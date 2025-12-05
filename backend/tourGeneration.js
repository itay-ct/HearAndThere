// Import utility functions
import { createTourState } from './utils/tourState.js';

// Import cache nodes
import { createCheckCacheForTourSuggestionsNode } from './nodes/cache/checkCacheForTourSuggestions.js';
import { createCheckPoiCacheNode } from './nodes/cache/checkPoiCache.js';
import { createSaveTourSuggestionsToCache } from './nodes/cache/saveTourSuggestionsToCache.js';
import { createSavePoiToCacheNode } from './nodes/cache/savePoiToCache.js';

// Import POI nodes
import { createFetchPoisFromGoogleMapsNode } from './nodes/poi/fetchPoisFromGoogleMaps.js';
import { createQueryPoisNode } from './nodes/poi/queryPois.js';

// Import context nodes
import { createReverseGeocodeNode } from './nodes/context/reverseGeocode.js';
import { createGenerateAreaSummariesNode } from './nodes/context/generateAreaSummaries.js';
import { createAssembleAreaContextNode } from './nodes/context/assembleAreaContext.js';

// Import tour nodes
import { createGenerateCandidateToursNode } from './nodes/tours/generateCandidateTours.js';
import { createValidateWalkingTimesNode } from './nodes/tours/validateWalkingTimes.js';

// Add debug logging at the top
console.log('[tourGeneration] LangSmith config check:', {
  LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY ? 'SET' : 'NOT_SET',
  LANGSMITH_ENDPOINT: process.env.LANGSMITH_ENDPOINT,
  LANGCHAIN_PROJECT: process.env.LANGCHAIN_PROJECT,
  LANGCHAIN_TRACING_V2: process.env.LANGCHAIN_TRACING_V2
});

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[tourGeneration]', ...args);
  }
}

let langGraphModulesPromise;
async function getLangGraphModules() {
  if (!langGraphModulesPromise) {
    langGraphModulesPromise = import('@langchain/langgraph')
      .then((mod) => ({
        StateGraph: mod.StateGraph,
        MessagesAnnotation: mod.MessagesAnnotation,
        START: mod.START,
        END: mod.END,
      }))
      .catch((err) => {
        console.warn('[tourGeneration] Failed to load @langchain/langgraph', err);
        return null;
      });
  }
  return langGraphModulesPromise;
}

// Normalize duration to discrete values for better caching
function normalizeDuration(durationMinutes) {
  const allowedDurations = [30, 60, 90, 120, 180]; // 30min, 1h, 1.5h, 2h, 3h

  // Find the closest allowed duration
  let closest = allowedDurations[0];
  let minDiff = Math.abs(durationMinutes - closest);

  for (const duration of allowedDurations) {
    const diff = Math.abs(durationMinutes - duration);
    if (diff < minDiff) {
      minDiff = diff;
      closest = duration;
    }
  }

  return closest;
}

// Build the LangGraph workflow for tour generation
async function buildTourGraph({ sessionId, latitude, longitude, durationMinutes, customization, language, redisClient }) {
  const modules = await getLangGraphModules();
  if (!modules) {
    throw new Error('LangGraph modules not available');
  }

  const { StateGraph, MessagesAnnotation, START, END } = modules;
  const { Annotation } = await import('@langchain/langgraph');

  // Normalize duration to discrete values for better caching
  const normalizedDuration = normalizeDuration(durationMinutes);
  console.log(`[tourGeneration] Duration normalized: ${durationMinutes} -> ${normalizedDuration} minutes`);

  // Create state using imported function
  const TourState = createTourState(Annotation, MessagesAnnotation);

  // Create nodes using imported node creators
  const checkCacheForTourSuggestionsNode = createCheckCacheForTourSuggestionsNode({
    durationMinutes: normalizedDuration,
    language,
    longitude,
    latitude,
    customization,
    redisClient
  });

  const checkPoiCacheNode = createCheckPoiCacheNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    redisClient
  });

  const fetchPoisNode = createFetchPoisFromGoogleMapsNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    redisClient
  });

  const queryPoisNode = createQueryPoisNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    redisClient
  });

  const reverseGeocodeNode = createReverseGeocodeNode({
    latitude,
    longitude
  });

  const generateAreaSummariesNode = createGenerateAreaSummariesNode({
    redisClient
  });

  const assembleAreaContextNode = createAssembleAreaContextNode();

  const generateCandidatesNode = createGenerateCandidateToursNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    customization,
    language,
    redisClient
  });

  const validateWalkingTimesNode = createValidateWalkingTimesNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    redisClient
  });

  // Routing functions
  const shouldCheckCache = (state) => {
    // Check cache only if no customization
    if (customization && customization.trim().length > 0) {
      console.log('[tourGeneration] Routing: Skip cache check (customization provided)');
      return 'check_poi_cache';
    }
    console.log('[tourGeneration] Routing: Check cache');
    return 'check_cache_for_tour_suggestions';
  };

  const routeAfterCacheCheck = (state) => {
    if (state.cacheHit) {
      console.log('[tourGeneration] Routing: Cache hit, skip to end');
      return END;
    }
    console.log('[tourGeneration] Routing: Cache miss, continue to POI cache check');
    return 'check_poi_cache';
  };

  const routeAfterPoiCacheCheck = (state) => {
    if (state.poiCacheHit) {
      console.log('[tourGeneration] Routing: POI cache hit, skip Google Maps fetch');
      return 'query_pois';
    }
    console.log('[tourGeneration] Routing: POI cache miss, fetch from Google Maps');
    return 'fetch_pois_from_google_maps';
  };

  // Build and compile graph
  // Note: Cache saving nodes (savePoiToCache, saveTourSuggestionsToCache) are NOT in the graph
  // They will be called asynchronously after the graph completes to avoid blocking the user response
  const graph = new StateGraph(TourState)
    .addNode('check_cache_for_tour_suggestions', checkCacheForTourSuggestionsNode)
    .addNode('check_poi_cache', checkPoiCacheNode)
    .addNode('fetch_pois_from_google_maps', fetchPoisNode)
    .addNode('query_pois', queryPoisNode)
    .addNode('reverse_geocode', reverseGeocodeNode)
    .addNode('generate_area_summaries', generateAreaSummariesNode)
    .addNode('assemble_area_context', assembleAreaContextNode)
    .addNode('generate_candidate_tours', generateCandidatesNode)
    .addNode('validate_walking_times', validateWalkingTimesNode)
    // Routing
    .addConditionalEdges(
      START,
      shouldCheckCache,
      {
        'check_cache_for_tour_suggestions': 'check_cache_for_tour_suggestions',
        'check_poi_cache': 'check_poi_cache'
      }
    )
    .addConditionalEdges(
      'check_cache_for_tour_suggestions',
      routeAfterCacheCheck,
      {
        [END]: END,
        'check_poi_cache': 'check_poi_cache'
      }
    )
    .addConditionalEdges(
      'check_poi_cache',
      routeAfterPoiCacheCheck,
      {
        'query_pois': 'query_pois',
        'fetch_pois_from_google_maps': 'fetch_pois_from_google_maps'
      }
    )
    .addEdge('fetch_pois_from_google_maps', 'query_pois')
    .addEdge('query_pois', 'reverse_geocode')
    .addEdge('reverse_geocode', 'generate_area_summaries')
    .addEdge('generate_area_summaries', 'assemble_area_context')
    .addEdge('assemble_area_context', 'generate_candidate_tours')
    .addEdge('generate_candidate_tours', 'validate_walking_times')
    .addEdge('validate_walking_times', END);

  // Compile graph with checkpointer if available
  let checkpointer = null;
  if (redisClient && sessionId) {
    try {
      const { RedisSaver } = await import('@langchain/langgraph-checkpoint-redis');
      // Configure checkpointer with 2-hour TTL to prevent Redis bloat
      checkpointer = new RedisSaver(redisClient, {
        ttl: {
          default_ttl: 120, // 2 hours in minutes
          refresh_on_read: false // Don't refresh TTL on read
        }
      });
      console.log('[tourGeneration] Using Redis checkpointer for session:', sessionId, '(TTL: 2 hours)');
    } catch (err) {
      console.warn('[tourGeneration] Failed to create Redis checkpointer:', err);
    }
  }

  const compiledGraph = checkpointer ? graph.compile({ checkpointer }) : graph.compile();

  console.log('[tourGeneration] Graph compiled successfully');
  return compiledGraph;
}

// Main export function - generates tours using LangGraph workflow
export async function generateTours({ sessionId, latitude, longitude, durationMinutes, customization, language, city: providedCity, neighborhood: providedNeighborhood, redisClient }) {
  if (!redisClient) {
    throw new Error('Redis client is required for tour generation');
  }

  const graph = await buildTourGraph({
    sessionId,
    latitude,
    longitude,
    durationMinutes,
    customization,
    language,
    redisClient,
  });

  // Use thread_id for checkpointing
  const config = {
    configurable: { thread_id: sessionId || 'default' },
  };

  // Initialize state with provided city/neighborhood if available
  const initialState = {
    messages: [],
    ...(providedCity && { city: providedCity }),
    ...(providedNeighborhood && { neighborhood: providedNeighborhood })
  };

  const finalState = await graph.invoke(
    initialState,
    config
  );

  // Extract results from final state - use provided values if available, otherwise use generated values
  const city = providedCity || finalState.areaContext?.city || null;
  const neighborhood = providedNeighborhood || finalState.areaContext?.neighborhood || null;
  const tours = finalState.finalTours || [];
  const cityData = finalState.cityData || { summary: null, keyFacts: null };
  const neighborhoodData = finalState.neighborhoodData || { summary: null, keyFacts: null };

  // Fire off cache operations asynchronously (don't await)
  // This allows the user to receive their response immediately while caching happens in the background
  saveCacheAsync({
    finalState,
    durationMinutes,
    language,
    longitude,
    latitude,
    customization,
    redisClient
  }).catch(err => {
    console.error('[tourGeneration] Background cache save failed:', err);
  });

  return {
    city,
    neighborhood,
    tours,
    cityData,
    neighborhoodData,
  };
}

/**
 * Save POIs and tour suggestions to cache asynchronously
 * This runs in the background after the user receives their response
 */
async function saveCacheAsync({ finalState, durationMinutes, language, longitude, latitude, customization, redisClient }) {
  console.log('[tourGeneration] Starting background cache operations...');

  try {
    // Create cache node instances
    const savePoiToCache = createSavePoiToCacheNode({ redisClient });
    const saveTourSuggestionsToCache = createSaveTourSuggestionsToCache({
      durationMinutes,
      language,
      longitude,
      latitude,
      customization,
      redisClient
    });

    // Run both cache operations in parallel
    await Promise.all([
      savePoiToCache(finalState).catch(err => {
        console.error('[tourGeneration] POI cache save failed:', err);
      }),
      saveTourSuggestionsToCache(finalState).catch(err => {
        console.error('[tourGeneration] Tour suggestions cache save failed:', err);
      })
    ]);

    console.log('[tourGeneration] ✅ Background cache operations completed');
  } catch (err) {
    console.error('[tourGeneration] Background cache operations failed:', err);
  }
}