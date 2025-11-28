/**
 * Save Tour Suggestions to Cache Node
 * 
 * Saves generated tour suggestions to Redis cache with:
 * - 7-day TTL
 * - Individual cache keys per tour (toursuggest_cache:{UUID})
 * - GEO-indexed start location for efficient spatial queries
 */

/**
 * LangGraph Node: Save tour suggestions to cache
 */
export function createSaveTourSuggestionsToCache({
  durationMinutes, 
  language, 
  longitude, 
  latitude, 
  customization, 
  redisClient 
}) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const tours = state.finalTours || [];

    // Skip cache save if customization is provided
    if (customization && customization.trim().length > 0) {
      console.log('[saveTourSuggestionsToCache] Skipping - customization provided');
      return { messages };
    }

    // Skip if cache was hit (already cached)
    if (state.cacheHit) {
      console.log('[saveTourSuggestionsToCache] Skipping - cache was hit');
      return { messages };
    }

    if (!redisClient) {
      console.log('[saveTourSuggestionsToCache] Skipping - no Redis client');
      return { messages };
    }

    if (tours.length === 0) {
      console.log('[saveTourSuggestionsToCache] Skipping - no tours to cache');
      return { messages };
    }

    try {
      console.log(`[saveTourSuggestionsToCache] Saving ${tours.length} tour suggestions...`);

      // Save each tour suggestion separately with its own unique ID
      // This way the tour ID is consistent from suggestion → audioguide generation
      let savedCount = 0;

      for (const tour of tours) {
        // Each tour already has a unique ID from generateCandidatesNode
        const tourId = tour.id;
        const cacheKey = `toursuggest_cache:${tourId}`;

        const cacheDoc = {
          tourId,
          duration: durationMinutes,
          language: language.toLowerCase(),
          startLocation: `${longitude},${latitude}`, // GEO format for RediSearch
          tour: tour, // Store the complete tour object
          createdAt: new Date().toISOString()
        };

        console.log(`[saveTourSuggestionsToCache] Saving tour ${savedCount + 1}/${tours.length}:`, {
          key: cacheKey,
          tourId,
          duration: durationMinutes,
          language: language.toLowerCase(),
          startLocation: `${longitude},${latitude}`,
          title: tour.title
        });

        // Save to Redis with TTL of 7 days
        await redisClient.json.set(cacheKey, '$', cacheDoc);
        await redisClient.expire(cacheKey, 7 * 24 * 60 * 60); // 7 days
        savedCount++;
      }

      console.log(`[saveTourSuggestionsToCache] ✅ Successfully cached ${savedCount} tour suggestions (TTL: 7 days)`);

      // Verify the documents were indexed
      try {
        const indexInfo = await redisClient.ft.info('idx:tour_suggestions');
        console.log(`[saveTourSuggestionsToCache] Index now has ${indexInfo.numDocs} documents`);
      } catch (err) {
        console.warn(`[saveTourSuggestionsToCache] Could not verify index:`, err.message);
      }

      const msg = {
        role: 'system',
        content: `Cached ${savedCount} tour suggestions individually (TTL: 7 days)`,
      };

      return {
        messages: [...messages, msg]
      };

    } catch (err) {
      console.error('[saveTourSuggestionsToCache] Failed to save tours to cache:', err);
      return { messages };
    }
  };
}

