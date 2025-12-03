/**
 * Generate Candidate Tours Node
 *
 * LangGraph node that generates candidate walking tours using Gemini LLM.
 */

import { v4 as uuidv4 } from 'uuid';
import { generateToursWithGemini } from '../../utils/tourHelpers.js';
import { queryFoodPoisFromRedis } from '../../utils/poiHelpers.js';

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
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const areaContext = state.areaContext;

    if (!areaContext) {
      throw new Error('Area context not available in state');
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
        poiCount: areaContext.pois?.length || 0
      });

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

      // Generate tours using Gemini LLM
      const rawTours = await generateToursWithGemini({
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
      });

      console.log('[generateCandidateTours] Generated tours count:', Array.isArray(rawTours) ? rawTours.length : 0);

      // Assign unique UUIDs to each tour immediately after generation
      // Store the LLM-generated ID as originalTourId for reference
      const allTours = (Array.isArray(rawTours) ? rawTours : []).map(tour => ({
        ...tour,
        originalTourId: tour.id, // Keep LLM-generated ID (e.g., "RAA-001", "tel-aviv-green-escapes")
        id: uuidv4() // Always assign a new UUID for caching and storage
      }));

      console.log('[generateCandidateTours] Assigned UUIDs to', allTours.length, 'tours');

      const msg = {
        role: 'system',
        content: `Generated ${Array.isArray(rawTours) ? rawTours.length : 0} tours with unique IDs, keeping all ${allTours.length} for validation.`,
      };

      return {
        messages: [...messages, msg],
        candidateTours: allTours
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

