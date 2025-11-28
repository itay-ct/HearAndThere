/**
 * Check Cache for Tour Suggestions Node
 * 
 * Checks if we have cached tour suggestions matching the request criteria:
 * - Exact duration match (after normalization)
 * - Language match
 * - Starting point within 50 meters
 */

const TOUR_SUGGESTIONS_INDEX = 'idx:tour_suggestions';

/**
 * Ensure tour suggestions index exists
 */
async function ensureTourSuggestionsIndexExists(redisClient) {
  if (!redisClient) return false;

  try {
    const indexInfo = await redisClient.ft.info(TOUR_SUGGESTIONS_INDEX);
    console.log(`[checkCacheForTourSuggestions] Index '${TOUR_SUGGESTIONS_INDEX}' exists with ${indexInfo.numDocs} documents`);
    return true;
  } catch (err) {
    const errorMsg = err.message || '';
    if (errorMsg.includes('Unknown index name') || errorMsg.includes('no such index')) {
      console.log(`[checkCacheForTourSuggestions] Creating index '${TOUR_SUGGESTIONS_INDEX}'...`);

      try {
        await redisClient.ft.create(
          TOUR_SUGGESTIONS_INDEX,
          {
            '$.tourId': { type: 'TAG', AS: 'tourId' },
            '$.duration': { type: 'NUMERIC', AS: 'duration' },
            '$.language': { type: 'TAG', AS: 'language' },
            '$.startLocation': { type: 'GEO', AS: 'startLocation' },
            '$.tour.title': { type: 'TEXT', AS: 'title' },
            '$.createdAt': { type: 'TEXT', AS: 'createdAt' }
          },
          {
            ON: 'JSON',
            PREFIX: 'toursuggest_cache:'
          }
        );

        console.log(`[checkCacheForTourSuggestions] ✅ Index created successfully`);

        // Wait a moment for index to initialize
        await new Promise(resolve => setTimeout(resolve, 100));

        return true;
      } catch (createErr) {
        console.error(`[checkCacheForTourSuggestions] Failed to create index:`, createErr);
        throw createErr;
      }
    } else {
      throw err;
    }
  }
}

/**
 * LangGraph Node: Check cache for tour suggestions
 */
export function createCheckCacheForTourSuggestionsNode({ 
  durationMinutes, 
  language, 
  longitude, 
  latitude, 
  customization, 
  redisClient 
}) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];

    // Skip cache check if customization is provided
    if (customization && customization.trim().length > 0) {
      console.log('[checkCacheForTourSuggestions] Skipping - customization provided');
      return { messages, cacheHit: false };
    }

    if (!redisClient) {
      console.log('[checkCacheForTourSuggestions] Skipping - no Redis client');
      return { messages, cacheHit: false };
    }

    try {
      console.log('[checkCacheForTourSuggestions] Checking cache...');

      // Ensure index exists
      await ensureTourSuggestionsIndexExists(redisClient);

      // Search for cached tours - get up to 10 matching tours
      const query = `@duration:[${durationMinutes} ${durationMinutes}] @language:{${language.toLowerCase()}} @startLocation:[${longitude} ${latitude} 50 m]`;
      console.log('[checkCacheForTourSuggestions] Query:', query);

      const results = await redisClient.ft.search(TOUR_SUGGESTIONS_INDEX, query, {
        LIMIT: { from: 0, size: 10 }
      });

      if (results.total > 0 && results.documents && results.documents.length > 0) {
        console.log(`[checkCacheForTourSuggestions] Cache HIT! Found ${results.documents.length} cached tours`);

        // Retrieve each individual tour from cache
        const cachedTours = [];
        for (const doc of results.documents) {
          const cachedDoc = await redisClient.json.get(doc.id, { path: '$' });

          if (cachedDoc && cachedDoc[0] && cachedDoc[0].tour) {
            cachedTours.push(cachedDoc[0].tour);
          }
        }

        if (cachedTours.length > 0) {
          console.log(`[checkCacheForTourSuggestions] Returning ${cachedTours.length} cached tours`);

          const msg = {
            role: 'system',
            content: `Cache HIT: Found ${cachedTours.length} cached tour suggestions (duration=${durationMinutes}, language=${language}, location within 50m)`,
          };

          return {
            messages: [...messages, msg],
            finalTours: cachedTours,
            cacheHit: true
          };
        }
      }

      console.log('[checkCacheForTourSuggestions] Cache MISS - will generate new tours');
      const msg = {
        role: 'system',
        content: `Cache MISS: No cached tours found for duration=${durationMinutes}, language=${language}`,
      };

      return {
        messages: [...messages, msg],
        cacheHit: false
      };

    } catch (err) {
      console.error('[checkCacheForTourSuggestions] Cache check failed:', err);
      return { messages, cacheHit: false };
    }
  };
}

