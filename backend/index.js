import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { generateTours } from './tourGeneration.js';
import { generateAudioguide } from './audioguideGeneration.js';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
const { version } = packageJson;

const app = express();
const PORT = process.env.PORT || 4000;

// Prefer configuring this via the REDIS_URL env var in local/dev.
// Falls back to the URL you provided.
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('REDIS_URL environment variable is not set');
  process.exit(1);
}

const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => {
  console.error('Redis Client Error', err);
});

async function start() {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.error('Failed to connect to Redis', err);
    process.exit(1);
  }

  // Add logging middleware before CORS
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path} - Origin: ${req.headers.origin}`);
    next();
  });

  app.use(cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:5173', // Vite default port
      'http://localhost:4173', // Vite preview port
      'http://localhost:5174', // Another common Vite port
      'https://hear-and-there.vercel.app',  // Old URL
      'https://hear-and-there-phi.vercel.app'  // Your actual Vercel URL
    ],
    credentials: true
  }));
  app.use(express.json());

  // Audio files are now served from Google Cloud Storage
  // No need for local static file serving

  app.get('/health', async (req, res) => {
    try {
      await redisClient.ping();
      res.json({
        status: 'ok',
        version: version,
      });
    } catch (err) {
      console.error('Health check failed', err);
      res.status(500).json({
        status: 'redis-error',
        version: version,
      });
    }
  });

  // Normalize duration to discrete values for better caching
  function normalizeDuration(durationMinutes) {
    const allowedDurations = [30, 60, 90, 120, 180]; // 30min, 1h, 1.5h, 2h, 3h

    // Find the closest allowed duration
    let closest = allowedDurations[0];
    let minDiff = Math.abs(durationMinutes - closest);

    for (const duration of allowedDurations) {
      const diff = Math.abs(durationMinutes - duration);
      if (diff < minDiff) {
        minDiff = diff;
        closest = duration;
      }
    }

    return closest;
  }

  app.post('/api/session', async (req, res) => {
    const {
      latitude,
      longitude,
      durationMinutes: rawDuration,
      sessionId: clientSessionId,
      customization,
      language,
    } = req.body || {};

    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      typeof rawDuration !== 'number'
    ) {
      return res.status(400).json({
        error: 'Invalid payload. Expected numeric latitude, longitude, durationMinutes.',
      });
    }

    // Normalize duration to discrete values (30, 60, 90, 120, 180)
    const durationMinutes = normalizeDuration(rawDuration);

    const sessionId =
      typeof clientSessionId === 'string' && clientSessionId.trim().length > 0
        ? clientSessionId.trim()
        : uuidv4();
    const key = `session:${sessionId}`;
    const createdAt = Date.now();

    console.log('[api/session] new session', {
      sessionId,
      latitude,
      longitude,
      durationMinutes: `${durationMinutes} (normalized from ${rawDuration})`,
      customization,
      language,
    });

    try {
      const sessionData = {
        latitude: String(latitude),
        longitude: String(longitude),
        durationMinutes: String(durationMinutes),
        createdAt: String(createdAt),
      };

      if (customization) sessionData.customization = customization;
      if (language) sessionData.language = language;

      await redisClient.hSet(key, sessionData);

      let city = null;
      let neighborhood = null;
      let tours = [];

      try {
        const result = await generateTours({
          sessionId,
          latitude,
          longitude,
          durationMinutes,
          customization,
          language,
          redisClient,
        });
        city = result.city || null;
        neighborhood = result.neighborhood || null;
        tours = Array.isArray(result.tours) ? result.tours : [];

        const extraFields = {};
        if (city) extraFields.city = city;
        if (neighborhood) extraFields.neighborhood = neighborhood;
        if (tours.length) extraFields.tours = JSON.stringify(tours);

        if (Object.keys(extraFields).length > 0) {
          await redisClient.hSet(key, extraFields);
        }

        console.log('[api/session] tours generated', {
          sessionId,
          city,
          neighborhood,
          tourCount: tours.length,
        });
      } catch (err) {
        console.error('Error generating tours', err);
      }

      res.json({
        sessionId,
        status: tours.length ? 'tours-ready' : 'saved',
        city,



        neighborhood,
        tours,
      });
    } catch (err) {
      console.error('Error saving session to Redis', err);
      res.status(500).json({ error: 'Failed to save session' });
    }
  });

  app.get('/api/session/:sessionId/progress', async (req, res) => {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const key = `session:${sessionId}`;

    try {
      const data = await redisClient.hGetAll(key);
      if (!data || Object.keys(data).length === 0) {
        return res.status(404).json({ error: 'session-not-found' });
      }

      let tourCount = 0;
      if (data.tours) {
        try {
          const parsed = JSON.parse(data.tours);
          if (Array.isArray(parsed)) {
            tourCount = parsed.length;
          }
        } catch {
          // ignore parse errors
        }
      }

      res.json({
        sessionId,
        stage: data.stage || null,
        city: data.city || null,
        neighborhood: data.neighborhood || null,
        tourCount,
        status: tourCount > 0 ? 'tours-ready' : 'in-progress',
      });
    } catch (err) {
      console.error('Error reading session progress', err);
      res.status(500).json({ error: 'failed-to-read-session-progress' });
    }
  });

  // Generate audioguide for a specific tour
  app.post('/api/session/:sessionId/tour/:tourId/audioguide', async (req, res) => {
    const { sessionId, tourId } = req.params;
    const { voice } = req.body || {};

    if (!sessionId || !tourId) {
      return res.status(400).json({ error: 'sessionId and tourId are required' });
    }

    const key = `session:${sessionId}`;

    try {
      // Load session data
      const sessionData = await redisClient.hGetAll(key);
      if (!sessionData || Object.keys(sessionData).length === 0) {
        return res.status(404).json({ error: 'session-not-found' });
      }

      // Parse tours
      let tours = [];
      if (sessionData.tours) {
        try {
          tours = JSON.parse(sessionData.tours);
        } catch (err) {
          console.error('Failed to parse tours', err);
          return res.status(500).json({ error: 'invalid-tour-data' });
        }
      }

      // Find the selected tour
      const selectedTour = tours.find(t => t.id === tourId);
      if (!selectedTour) {
        return res.status(404).json({ error: 'tour-not-found' });
      }

      // Build area context from session data
      const areaContext = {
        city: sessionData.city || null,
        neighborhood: sessionData.neighborhood || null,
        cityData: { summary: null, keyFacts: null },
        neighborhoodData: { summary: null, keyFacts: null },
      };

      // Get language preference from session
      const language = sessionData.language || 'english';

      // Get voice preference from request body (defaults based on language)
      const selectedVoice = voice || (language === 'hebrew' ? 'he-IL-Standard-D' : 'en-GB-Wavenet-B');

      // Use the tour's existing UUID (assigned during generation)
      // This ensures consistency: toursuggest:{UUID} → tour:{UUID}
      const shareableTourId = selectedTour.id;
      console.log('[api] Using tour ID from generation:', shareableTourId);

      // Ensure finalized tours index exists
      try {
        await redisClient.ft.info('idx:tours');
      } catch (err) {
        const errorMsg = err.message || '';
        if (errorMsg.includes('Unknown index name') || errorMsg.includes('no such index')) {
          console.log('[api] Creating finalized tours index...');
          await redisClient.ft.create(
            'idx:tours',
            {
              '$.tourId': { type: 'TAG', AS: 'tourId' },
              '$.originalTourId': { type: 'TAG', AS: 'originalTourId' },
              '$.duration': { type: 'NUMERIC', AS: 'duration' },
              '$.language': { type: 'TAG', AS: 'language' },
              '$.startLocation': { type: 'GEO', AS: 'startLocation' },
              '$.title': { type: 'TEXT', AS: 'title' },
              '$.status': { type: 'TAG', AS: 'status' },
              '$.createdAt': { type: 'TEXT', AS: 'createdAt' }
            },
            {
              ON: 'JSON',
              PREFIX: 'tour:'
            }
          );
          console.log('[api] Finalized tours index created');
        }
      }

      // Store tour data under the shareable tour ID as JSON
      const tourDataKey = `tour:${shareableTourId}`;
      const startLongitude = parseFloat(sessionData.longitude);
      const startLatitude = parseFloat(sessionData.latitude);

      const tourDocument = {
        tourId: shareableTourId, // UUID (e.g., "1e4e6a0b-dce7-4e77-a43a-4eae369184df")
        sessionId, // Keep reference for debugging
        originalTourId: selectedTour.originalTourId || tourId, // LLM-generated slug (e.g., "RAA-001", "tel-aviv-green-escapes")
        status: 'generating',
        startedAt: new Date().toISOString(),
        title: selectedTour.title,
        abstract: selectedTour.abstract,
        theme: selectedTour.theme,
        estimatedTotalMinutes: selectedTour.estimatedTotalMinutes,
        duration: selectedTour.estimatedTotalMinutes, // For RediSearch NUMERIC query
        language,
        voice: selectedVoice, // Store selected voice
        // Store starting point coordinates (separate for backward compatibility)
        startLatitude,
        startLongitude,
        // Store starting point as GEO field for RediSearch
        startLocation: `${startLongitude},${startLatitude}`,
        // Store full tour data with stops and walking directions
        tour: selectedTour,
        areaContext,
        // Placeholders for scripts and audio files (will be added when generation completes)
        scripts: null,
        audioFiles: null,
        createdAt: new Date().toISOString()
      };

      await redisClient.json.set(tourDataKey, '$', tourDocument);

      // Start audioguide generation (async)
      console.log('[api] Starting audioguide generation for shareable tour:', shareableTourId, 'language:', language, 'voice:', selectedVoice);

      // Return immediately with the shareable tour ID
      res.status(202).json({
        sessionId,
        tourId: shareableTourId, // Return the shareable tour ID
        status: 'generating',
        message: 'Audioguide generation started',
      });

      // Generate audioguide in background
      generateAudioguide({
        sessionId,
        tourId: shareableTourId, // Pass shareable tour ID
        selectedTour,
        areaContext,
        language,
        voice: selectedVoice,
        redisClient,
      }).then(async (result) => {
        console.log('[api] Audioguide generation completed for tour:', shareableTourId);

        // Update the tour document with completion status, scripts, and audio files
        await redisClient.json.set(tourDataKey, '$.status', 'complete');
        await redisClient.json.set(tourDataKey, '$.completedAt', new Date().toISOString());

        if (result.scripts) {
          await redisClient.json.set(tourDataKey, '$.scripts', result.scripts);
        }
        if (result.audioFiles) {
          await redisClient.json.set(tourDataKey, '$.audioFiles', result.audioFiles);
        }

        console.log('[api] Audioguide data saved to Redis for shareable tour:', shareableTourId);
      }).catch(async (err) => {
        console.error('[api] Audioguide generation failed for tour:', shareableTourId, err);

        // Mark as failed
        await redisClient.json.set(tourDataKey, '$.status', 'failed');
        await redisClient.json.set(tourDataKey, '$.error', err.message || 'audioguide-generation-failed');
        await redisClient.json.set(tourDataKey, '$.failedAt', new Date().toISOString());
      });

    } catch (err) {
      console.error('Error starting audioguide generation', err);
      res.status(500).json({ error: 'failed-to-start-audioguide-generation' });
    }
  });

  // Get audioguide status and data (legacy endpoint - kept for backward compatibility)
  app.get('/api/session/:sessionId/tour/:tourId/audioguide', async (req, res) => {
    const { sessionId, tourId } = req.params;

    if (!sessionId || !tourId) {
      return res.status(400).json({ error: 'sessionId and tourId are required' });
    }

    const audioguideKey = `audioguide:${sessionId}:${tourId}`;

    try {
      const audioguideData = await redisClient.hGetAll(audioguideKey);

      if (!audioguideData || Object.keys(audioguideData).length === 0) {
        return res.status(404).json({ error: 'audioguide-not-found' });
      }

      const response = {
        sessionId,
        tourId,
        status: audioguideData.status || 'unknown',
        startedAt: audioguideData.startedAt || null,
        completedAt: audioguideData.completedAt || null,
        error: audioguideData.error || null,
      };

      // If complete, load scripts and audio files
      if (audioguideData.status === 'complete') {
        try {
          const scriptsData = await redisClient.json.get(`${audioguideKey}:scripts`, { path: '$' });
          const audioFilesData = await redisClient.json.get(`${audioguideKey}:audioFiles`, { path: '$' });

          response.scripts = Array.isArray(scriptsData) && scriptsData.length > 0 ? scriptsData[0] : null;
          response.audioFiles = Array.isArray(audioFilesData) && audioFilesData.length > 0 ? audioFilesData[0] : null;
        } catch (err) {
          console.warn('[api] Failed to load audioguide data from Redis', err);
        }
      }

      res.json(response);
    } catch (err) {
      console.error('Error fetching audioguide status', err);
      res.status(500).json({ error: 'failed-to-fetch-audioguide-status' });
    }
  });

  // Get shareable tour data by tour ID
  app.get('/api/tour/:tourId', async (req, res) => {
    const { tourId } = req.params;

    if (!tourId) {
      return res.status(400).json({ error: 'tourId is required' });
    }

    const tourDataKey = `tour:${tourId}`;

    try {
      // Read tour data from JSON
      const tourDataArray = await redisClient.json.get(tourDataKey, { path: '$' });

      if (!tourDataArray || !Array.isArray(tourDataArray) || tourDataArray.length === 0) {
        return res.status(404).json({ error: 'tour-not-found' });
      }

      const tourData = tourDataArray[0];

      // Return the complete tour document (includes tour, scripts, audioFiles, etc.)
      res.json(tourData);
    } catch (err) {
      console.error('Error fetching tour data', err);
      res.status(500).json({ error: 'failed-to-fetch-tour-data' });
    }
  });

  // Get feedback for a tour
  app.get('/api/tour/:tourId/feedback', async (req, res) => {
    const { tourId } = req.params;

    if (!tourId) {
      return res.status(400).json({ error: 'tourId is required' });
    }

    const feedbackKey = `tour:${tourId}:feedback`;

    try {
      const feedbackData = await redisClient.json.get(feedbackKey, { path: '$' });

      let feedback = [];
      if (feedbackData !== null && Array.isArray(feedbackData) && feedbackData.length > 0) {
        feedback = feedbackData[0];
      }

      res.json({
        tourId,
        feedback,
        count: Array.isArray(feedback) ? feedback.length : 0
      });
    } catch (err) {
      console.error('Error fetching feedback', err);
      res.status(500).json({ error: 'failed-to-fetch-feedback' });
    }
  });

  // Submit feedback for a tour
  app.post('/api/tour/:tourId/feedback', async (req, res) => {
    const { tourId } = req.params;
    const { rating, feedback } = req.body;

    if (!tourId) {
      return res.status(400).json({ error: 'tourId is required' });
    }

    if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating is required and must be between 1 and 5' });
    }

    const tourDataKey = `tour:${tourId}`;

    try {
      // Check if tour exists
      const tourExists = await redisClient.exists(tourDataKey);
      if (!tourExists) {
        return res.status(404).json({ error: 'tour-not-found' });
      }

      // Get existing feedback array or create new one
      const feedbackKey = `${tourDataKey}:feedback`;
      let feedbackArray = [];

      try {
        const existingFeedback = await redisClient.json.get(feedbackKey, { path: '$' });
        console.log('[api] Existing feedback retrieved:', existingFeedback);

        if (existingFeedback !== null) {
          // Redis JSON returns the value wrapped in an array when using path '$'
          if (Array.isArray(existingFeedback) && existingFeedback.length > 0) {
            feedbackArray = Array.isArray(existingFeedback[0]) ? existingFeedback[0] : [];
          }
        }
      } catch (err) {
        // Feedback doesn't exist yet, that's okay
        console.log('[api] No existing feedback, creating new array:', err.message);
      }

      // Add new feedback with timestamp
      const feedbackEntry = {
        rating,
        timestamp: new Date().toISOString(),
      };

      // Add optional feedback text if provided
      if (feedback && typeof feedback === 'string' && feedback.trim()) {
        feedbackEntry.feedback = feedback.trim();
      }

      feedbackArray.push(feedbackEntry);

      console.log('[api] Feedback array before saving:', feedbackArray);

      // Store updated feedback array
      await redisClient.json.set(feedbackKey, '$', feedbackArray);

      console.log(`[api] Feedback saved to Redis at key: ${feedbackKey}`);
      console.log(`[api] Feedback entry:`, feedbackEntry);

      // Verify it was saved
      const verification = await redisClient.json.get(feedbackKey, { path: '$' });
      console.log('[api] Verification - feedback after save:', verification);

      res.json({ success: true, message: 'Feedback submitted successfully' });
    } catch (err) {
      console.error('Error submitting feedback', err);
      res.status(500).json({ error: 'failed-to-submit-feedback' });
    }
  });


  const server = app.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    console.log('Shutting down API server...');
    try {
      await redisClient.quit();
    } catch (err) {
      console.error('Error closing Redis connection', err);
    }
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();

