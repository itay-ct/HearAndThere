/**
 * Fetch POIs from Google Maps Node
 *
 * LangGraph node that fetches POIs from Google Maps API when cache doesn't have enough data.
 */

import { searchNearbyPois, cachePlaceInRedis } from '../../utils/poiHelpers.js';

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

      // Fetch POIs from Google Maps
      const pois = await searchNearbyPois(latitude, longitude, durationMinutes, redisClient);

      console.log(`[fetchPoisFromGoogleMaps] Fetched ${pois.length} POIs from Google Maps`);

      // VALIDATION: Warn if Google Maps returned no POIs
      if (pois.length === 0) {
        console.warn('[fetchPoisFromGoogleMaps] ⚠️ WARNING: Google Maps API returned 0 POIs!');
        console.warn('[fetchPoisFromGoogleMaps] This may indicate an issue with the location or API.');
      }

      // ✅ IMMEDIATELY cache POIs to Redis (don't wait for background task)
      // Redis can handle duplicates, so no need to worry about re-caching
      if (redisClient && pois.length > 0) {
        console.log(`[fetchPoisFromGoogleMaps] Caching ${pois.length} POIs immediately...`);
        await Promise.all(
          pois.map(poi => cachePlaceInRedis(redisClient, poi).catch(err => {
            console.error(`[fetchPoisFromGoogleMaps] Failed to cache POI ${poi.id}:`, err.message);
          }))
        );
        console.log(`[fetchPoisFromGoogleMaps] ✅ Successfully cached ${pois.length} POIs`);
      }

      const msg = {
        role: 'assistant',
        content: `Fetched ${pois.length} POIs from Google Maps API and cached them in Redis.`
      };

      return {
        messages: [...messages, msg],
        pois,
        poisCount: pois.length,
        googleMapsFetched: true  // Flag to prevent infinite loop
      };
    } catch (err) {
      console.error('[fetchPoisFromGoogleMaps] ❌ ERROR: Failed to fetch POIs from Google Maps:', err);
      console.error('[fetchPoisFromGoogleMaps] Error details:', err.message);

      const errorMsg = {
        role: 'assistant',
        content: 'Failed to fetch POIs from Google Maps API. Using empty POI list.'
      };

      return {
        messages: [...messages, errorMsg],
        pois: [],
        poisCount: 0,
        googleMapsFetched: true  // Flag to prevent infinite loop even on error
      };
    }
  };
}

