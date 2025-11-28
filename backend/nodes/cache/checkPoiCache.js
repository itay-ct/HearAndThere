/**
 * Check POI Cache Node
 * 
 * Checks if we have enough POIs (40+) cached in Redis before calling Google Maps.
 * This dramatically reduces API calls and costs.
 */

import { traceable } from 'langsmith/traceable';

const POI_INDEX_NAME = 'idx:pois';

/**
 * Ensure RediSearch index exists for POIs
 */
async function ensurePoiIndexExists(redisClient) {
  if (!redisClient) {
    console.warn('[checkPoiCache] No Redis client available for index creation');
    return false;
  }

  try {
    // Check if index already exists
    try {
      await redisClient.ft.info(POI_INDEX_NAME);
      console.log(`[checkPoiCache] RediSearch index '${POI_INDEX_NAME}' already exists`);
      return true;
    } catch (err) {
      // Index doesn't exist, create it
      const errorMsg = err.message || '';
      if (errorMsg.includes('Unknown index name') || errorMsg.includes('no such index')) {
        console.log(`[checkPoiCache] Creating RediSearch index '${POI_INDEX_NAME}'...`);

        await redisClient.ft.create(
          POI_INDEX_NAME,
          {
            '$.name': {
              type: 'TEXT',
              AS: 'name'
            },
            '$.types[*]': {
              type: 'TAG',
              AS: 'types'
            },
            '$.location': {
              type: 'GEO',
              AS: 'location'
            },
            '$.rating': {
              type: 'NUMERIC',
              AS: 'rating'
            },
            '$.primary': {
              type: 'TAG',
              AS: 'primary'
            }
          },
          {
            ON: 'JSON',
            PREFIX: 'poi_cache:'
          }
        );

        console.log(`[checkPoiCache] ✅ RediSearch index '${POI_INDEX_NAME}' created successfully`);
        return true;
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('[checkPoiCache] Failed to ensure POI index exists:', err);
    return false;
  }
}

/**
 * Check if we have enough POIs cached in Redis
 */
export const checkPoiCacheHelper = traceable(async ({ latitude, longitude, durationMinutes, redisClient = null }) => {
  if (!redisClient) {
    console.warn('[checkPoiCache] No Redis client available for POI cache check');
    return { hasSufficientPois: false, poisCount: 0 };
  }

  // Calculate radius for POI search
  const walkingTimeMinutes = durationMinutes * 0.4;
  const maxWalkingMeters = walkingTimeMinutes * 83;
  const calculatedRadius = Math.round(maxWalkingMeters / 2);
  const radiusMeters = Math.max(500, Math.min(3000, calculatedRadius));

  // Ensure index exists
  await ensurePoiIndexExists(redisClient);

  try {
    // Query primary POIs within radiusMeters
    const query = `@location:[${longitude} ${latitude} ${radiusMeters} m] @primary:{true}`;
    console.log(`[checkPoiCache] POI cache check query: ${query}`);

    const results = await redisClient.ft.search(POI_INDEX_NAME, query, {
      LIMIT: { from: 0, size: 40 }
    });

    const poisCount = results.total || 0;
    const hasSufficientPois = poisCount >= 40;

    console.log(`[checkPoiCache] Found ${poisCount} primary POIs (need 40)`);

    return { hasSufficientPois, poisCount, radiusMeters };
  } catch (err) {
    console.error('[checkPoiCache] POI cache check failed:', err);
    return { hasSufficientPois: false, poisCount: 0, radiusMeters };
  }
}, { name: 'checkPoiCache', run_type: 'tool' });

/**
 * LangGraph Node: Check if we have enough POIs in cache
 */
export function createCheckPoiCacheNode({ latitude, longitude, durationMinutes, redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];

    try {
      const { hasSufficientPois, poisCount } = await checkPoiCacheHelper({
        latitude,
        longitude,
        durationMinutes,
        redisClient
      });

      console.log(`[checkPoiCache] POI cache check: ${poisCount} POIs found, sufficient: ${hasSufficientPois}`);

      return {
        messages,
        poiCacheHit: hasSufficientPois,
        poisCount
      };
    } catch (err) {
      console.error('[checkPoiCache] POI cache check failed:', err);
      return {
        messages,
        poiCacheHit: false,
        poisCount: 0
      };
    }
  };
}

