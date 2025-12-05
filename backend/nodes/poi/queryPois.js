/**
 * Query POIs Node
 * 
 * LangGraph node that queries POIs from Redis cache using RediSearch.
 */

import { queryPoisFromRedis } from '../../utils/poiHelpers.js';

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[queryPois]', ...args);
  }
}

/**
 * Create the queryPois node
 * 
 * This node queries POIs from Redis cache using RediSearch with intelligent fallback logic:
 * 1. Query primary POIs within radiusMeters
 * 2. If < 40, query all POIs within radiusMeters
 * 3. If still < 40, query all POIs within radiusMeters * 1.5
 * 
 * @param {Object} config - Node configuration
 * @param {number} config.latitude - Starting latitude
 * @param {number} config.longitude - Starting longitude
 * @param {number} config.durationMinutes - Tour duration in minutes
 * @param {Object} config.redisClient - Redis client instance
 * @returns {Function} LangGraph node function
 */
export function createQueryPoisNode({ latitude, longitude, durationMinutes, redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];

    // If POIs already exist in state (from fetchPoisFromGoogleMaps), use them
    // This happens when POI cache miss triggers Google Maps fetch
    if (state.pois && state.pois.length > 0) {
      console.log(`[queryPois] Using ${state.pois.length} POIs already in state (from Google Maps fetch)`);
      debugLog('Skipping Redis query - POIs already fetched from Google Maps');

      return {
        messages,
        pois: state.pois,
        poisCount: state.pois.length
      };
    }

    // If we reach here after Google Maps fetch failed, we should have empty POIs in state
    if (state.pois !== undefined && state.pois.length === 0) {
      console.warn('[queryPois] ⚠️ WARNING: POIs in state is empty (Google Maps fetch likely failed or returned nothing)');
      console.warn('[queryPois] Attempting to query Redis cache as fallback...');
    }

    try {
      console.log('[queryPois] Querying POIs from Redis cache...');
      debugLog('Querying POIs for', { latitude, longitude, durationMinutes });

      // Calculate radius based on duration
      const walkingTimeMinutes = durationMinutes * 0.4;
      const maxWalkingMeters = walkingTimeMinutes * 83;
      const calculatedRadius = Math.round(maxWalkingMeters / 2);
      const radiusMeters = Math.max(500, Math.min(3000, calculatedRadius));

      debugLog('Calculated radius:', radiusMeters, 'meters');

      // Query POIs from Redis
      const pois = await queryPoisFromRedis(latitude, longitude, radiusMeters, redisClient);

      console.log(`[queryPois] Retrieved ${pois.length} POIs from Redis cache`);

      // VALIDATION: Warn if Redis query returned no POIs
      if (pois.length === 0) {
        console.warn('[queryPois] ⚠️ WARNING: Redis query returned 0 POIs!');
        console.warn('[queryPois] This will cause tour generation to fail.');
      }

      const msg = {
        role: 'assistant',
        content: `Retrieved ${pois.length} POIs from Redis cache for tour generation.`
      };

      return {
        messages: [...messages, msg],
        pois,
        poisCount: pois.length
      };
    } catch (err) {
      console.error('[queryPois] ❌ ERROR: Failed to query POIs from Redis:', err);
      console.error('[queryPois] Error details:', err.message);

      const errorMsg = {
        role: 'assistant',
        content: 'Failed to query POIs from Redis cache. Using empty POI list.'
      };

      return {
        messages: [...messages, errorMsg],
        pois: [],
        poisCount: 0
      };
    }
  };
}

