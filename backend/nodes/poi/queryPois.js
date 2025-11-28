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
      console.error('[queryPois] Failed to query POIs from Redis:', err);
      
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

