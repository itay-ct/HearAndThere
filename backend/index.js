import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { generateTours } from './tourGeneration.js';

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
      'https://hear-and-there.vercel.app'  // New correct URL
    ],
    credentials: true
  }));
  app.use(express.json());

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

  app.post('/api/session', async (req, res) => {
    const {
      latitude,
      longitude,
      durationMinutes,
      sessionId: clientSessionId,
    } = req.body || {};

    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      typeof durationMinutes !== 'number'
    ) {
      return res.status(400).json({
        error: 'Invalid payload. Expected numeric latitude, longitude, durationMinutes.',
      });
    }

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
      durationMinutes,
    });

    try {
      await redisClient.hSet(key, {
        latitude: String(latitude),
        longitude: String(longitude),
        durationMinutes: String(durationMinutes),
        createdAt: String(createdAt),
      });

      let city = null;
      let neighborhood = null;
      let tours = [];

      try {
        const result = await generateTours({
          sessionId,
          latitude,
          longitude,
          durationMinutes,
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

