/**
 * Generate Candidate Tours Node
 *
 * LangGraph node that generates candidate walking tours using Gemini LLM.
 */

import { v4 as uuidv4 } from 'uuid';
import { generateToursWithGemini, validateSingleTour } from '../../utils/tourHelpers.js';
import { queryFoodPoisFromRedis } from '../../utils/poiHelpers.js';
import { checkCancellation, getSessionIdFromState } from '../../utils/cancellationHelper.js';

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[generateCandidateTours]', ...args);
  }
}

/**
 * Create the generateCandidateTours node
 *
 * This node generates candidate walking tours using Gemini LLM based on the
 * assembled area context (city, neighborhood, POIs, summaries).
 *
 * Each generated tour is assigned a unique UUID, and the LLM-generated ID
 * is preserved as `originalTourId` for reference.
 *
 * @param {Object} config - Node configuration
 * @param {number} config.latitude - Starting latitude
 * @param {number} config.longitude - Starting longitude
 * @param {number} config.durationMinutes - Tour duration in minutes
 * @param {string} config.customization - User customization request
 * @param {string} config.language - Tour language (english/hebrew)
 * @param {Object} config.redisClient - Redis client instance
 * @returns {Function} LangGraph node function
 */
export function createGenerateCandidateToursNode({
  latitude,
  longitude,
  durationMinutes,
  customization,
  language,
  redisClient
}) {
  return async (state, config) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const areaContext = state.areaContext;
    const sessionId = config?.configurable?.thread_id;

    if (!areaContext) {
      throw new Error('Area context not available in state');
    }

    // VALIDATION: Check if we have POIs to generate tours from
    const poiCount = areaContext.pois?.length || 0;
    if (poiCount === 0) {
      console.warn('[generateCandidateTours] ⚠️ WARNING: No POIs available for tour generation!');
      console.warn('[generateCandidateTours] Cannot generate tours without points of interest.');

      const errorMsg = {
        role: 'assistant',
        content: 'No points of interest detected in this area. Please try again from a different location.'
      };

      return {
        messages: [...messages, errorMsg],
        tours: [],
        error: 'no_pois_available'
      };
    }

    try {
      console.log('[generateCandidateTours] Generating candidate tours with Gemini LLM...');
      debugLog('Generating tours for', {
        latitude,
        longitude,
        durationMinutes,
        customization,
        language,
        city: areaContext.city,
        neighborhood: areaContext.neighborhood,
        poiCount
      });

      // Check for cancellation before expensive operations
      await checkCancellation(sessionId, redisClient, 'generateCandidateTours');

      // Query food POIs if tour is 2 hours or longer
      let foodPois = [];
      if (durationMinutes >= 120 && redisClient) {
        console.log('[generateCandidateTours] Tour is 2+ hours, querying food POIs...');

        // Calculate radius based on duration (same logic as in queryPois)
        const walkingTimeMinutes = durationMinutes * 0.4;
        const maxWalkingMeters = walkingTimeMinutes * 83;
        const calculatedRadius = Math.round(maxWalkingMeters / 2);
        const radiusMeters = Math.max(500, Math.min(3000, calculatedRadius));

        try {
          foodPois = await queryFoodPoisFromRedis(latitude, longitude, radiusMeters, redisClient);
          console.log(`[generateCandidateTours] Retrieved ${foodPois.length} food POIs`);
          debugLog('Food POIs:', foodPois.map(p => ({ name: p.name, rating: p.rating })));
        } catch (err) {
          console.warn('[generateCandidateTours] Failed to query food POIs:', err);
          foodPois = [];
        }
      }

      // Check for cancellation again before calling Gemini (expensive operation)
      await checkCancellation(sessionId, redisClient, 'generateCandidateTours');

      // Generate tours using Gemini LLM with streaming (always enabled)
      console.log('[generateCandidateTours] 🌊 Starting streaming tour generation...');
      const tourStream = await generateToursWithGemini({
        latitude,
        longitude,
        durationMinutes,
        customization,
        language,
        city: areaContext.city,
        neighborhood: areaContext.neighborhood,
        pois: areaContext.pois,
        cityData: areaContext.cityData,
        neighborhoodData: areaContext.neighborhoodData,
        foodPois: foodPois,
        sessionId, // Pass sessionId for cancellation checks
        redisClient, // Pass redisClient for cancellation checks
        streaming: true, // Always use streaming for tour generation
      });

      // Consume the stream, validate each tour, and send to frontend immediately
      const rawTours = [];
      const validatedTours = [];

      for await (const tour of tourStream) {
        console.log(`[generateCandidateTours] 📥 Received streamed tour: ${tour.title || 'Untitled'}`);

        // Assign UUID immediately
        const tourWithId = {
          ...tour,
          originalTourId: tour.id,
          id: uuidv4(),
        };

        rawTours.push(tourWithId);

        // Validate walking times immediately
        console.log(`[generateCandidateTours] 🔍 Validating tour: ${tourWithId.title}`);
        const validatedTour = await validateSingleTour(tourWithId, latitude, longitude);
        validatedTours.push(validatedTour);

        // Send validated tour to Redis immediately so frontend can display it
        const sessionKey = `session:${sessionId}`;
        try {
          await redisClient.hSet(sessionKey, {
            tours: JSON.stringify(validatedTours),
          });
          console.log(`[generateCandidateTours] ✅ Sent ${validatedTours.length} tour(s) to frontend`);
        } catch (err) {
          console.error('[generateCandidateTours] Failed to update Redis with streamed tour:', err);
        }
      }

      console.log(`[generateCandidateTours] ✅ Streaming complete. Received and validated ${validatedTours.length} tours`);

      // Tours are already validated and have UUIDs assigned
      const allTours = validatedTours;

      const msg = {
        role: 'system',
        content: `Generated and validated ${allTours.length} tours with streaming.`,
      };

      return {
        messages: [...messages, msg],
        finalTours: validatedTours,
        rawTours,
        validatedTours
      };
    } catch (err) {
      console.error('[generateCandidateTours] Failed to generate candidate tours:', err);
      
      const errorMsg = {
        role: 'system',
        content: 'Failed to generate candidate tours. Using empty tour list.'
      };

      return {
        messages: [...messages, errorMsg],
        candidateTours: []
      };
    }
  };
}

