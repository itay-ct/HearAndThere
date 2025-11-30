/**
 * Save POI to Cache Node
 * 
 * Saves fetched POIs to Redis cache with:
 * - 7-day TTL (unless pinned)
 * - RediSearch indexing for spatial queries
 * - Preservation of existing user data (pinned, notes, tags, images)
 * 
 * This node runs asynchronously after the user request completes,
 * so Redis interactions don't block the user experience.
 */

import { cachePlaceInRedis } from '../../utils/poiHelpers.js';

/**
 * LangGraph Node: Save POIs to cache
 * 
 * This node saves POIs fetched from Google Maps to Redis cache.
 * It should be called after POIs are fetched but should not block
 * the user response.
 * 
 * @param {Object} config - Node configuration
 * @param {Object} config.redisClient - Redis client instance
 * @returns {Function} LangGraph node function
 */
export function createSavePoiToCacheNode({ redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const pois = state.pois || [];

    // Skip if no Redis client
    if (!redisClient) {
      console.log('[savePoiToCache] Skipping - no Redis client');
      return { messages };
    }

    // Skip if no POIs to cache
    if (pois.length === 0) {
      console.log('[savePoiToCache] Skipping - no POIs to cache');
      return { messages };
    }

    // Skip if POIs were loaded from cache (not fetched from Google Maps)
    if (state.poiCacheHit) {
      console.log('[savePoiToCache] Skipping - POIs were loaded from cache');
      return { messages };
    }

    try {
      console.log(`[savePoiToCache] Saving ${pois.length} POIs to cache...`);

      // Cache all POIs in parallel
      await Promise.all(
        pois.map(poi => cachePlaceInRedis(redisClient, poi))
      );

      console.log(`[savePoiToCache] ✅ Successfully cached ${pois.length} POIs (TTL: 7 days)`);

      const msg = {
        role: 'system',
        content: `Cached ${pois.length} POIs to Redis (TTL: 7 days)`,
      };

      return {
        messages: [...messages, msg]
      };

    } catch (err) {
      console.error('[savePoiToCache] Failed to save POIs to cache:', err);
      // Don't fail the request if caching fails
      return { messages };
    }
  };
}

