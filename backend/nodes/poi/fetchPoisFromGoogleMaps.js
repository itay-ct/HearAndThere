/**
 * Fetch POIs from Google Maps Node
 * 
 * LangGraph node that fetches POIs from Google Maps API when cache doesn't have enough data.
 */

import { searchNearbyPois } from '../../utils/poiHelpers.js';

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[fetchPoisFromGoogleMaps]', ...args);
  }
}

/**
 * Create the fetchPoisFromGoogleMaps node
 * 
 * This node fetches POIs from Google Maps API and caches them in Redis.
 * It's only called when the POI cache doesn't have sufficient data (< 40 primary POIs).
 * 
 * @param {Object} config - Node configuration
 * @param {number} config.latitude - Starting latitude
 * @param {number} config.longitude - Starting longitude
 * @param {number} config.durationMinutes - Tour duration in minutes
 * @param {Object} config.redisClient - Redis client instance
 * @returns {Function} LangGraph node function
 */
export function createFetchPoisFromGoogleMapsNode({ latitude, longitude, durationMinutes, redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];

    try {
      console.log('[fetchPoisFromGoogleMaps] Fetching POIs from Google Maps API...');
      debugLog('Fetching POIs for', { latitude, longitude, durationMinutes });

      // Fetch POIs from Google Maps and cache them
      const pois = await searchNearbyPois(latitude, longitude, durationMinutes, redisClient);

      console.log(`[fetchPoisFromGoogleMaps] Fetched and cached ${pois.length} POIs from Google Maps`);

      const msg = {
        role: 'assistant',
        content: `Fetched ${pois.length} POIs from Google Maps API and cached them in Redis.`
      };

      return {
        messages: [...messages, msg],
        pois,
        poisCount: pois.length
      };
    } catch (err) {
      console.error('[fetchPoisFromGoogleMaps] Failed to fetch POIs from Google Maps:', err);
      
      const errorMsg = {
        role: 'assistant',
        content: 'Failed to fetch POIs from Google Maps API. Using empty POI list.'
      };

      return {
        messages: [...messages, errorMsg],
        pois: [],
        poisCount: 0
      };
    }
  };
}

