// Import utility functions
import { createTourState } from './utils/tourState.js';

// Import cache nodes
import { createCheckCacheForTourSuggestionsNode } from './nodes/cache/checkCacheForTourSuggestions.js';
import { createCheckPoiCacheNode } from './nodes/cache/checkPoiCache.js';
import { createSaveTourSuggestionsToCache } from './nodes/cache/saveTourSuggestionsToCache.js';

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

  const generateAreaSummariesNode = createGenerateAreaSummariesNode();

  const assembleAreaContextNode = createAssembleAreaContextNode();

  const generateCandidatesNode = createGenerateCandidateToursNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    customization,
    language
  });

  const validateWalkingTimesNode = createValidateWalkingTimesNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    redisClient
  });

  const saveTourSuggestionsToCache = createSaveTourSuggestionsToCache({
    durationMinutes: normalizedDuration,
    language,
    longitude,
    latitude,
    customization,
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

  const shouldSaveToCache = (state) => {
    // Only save to cache if no customization
    if (customization && customization.trim().length > 0) {
      console.log('[tourGeneration] Routing: Skip cache save (customization provided)');
      return END;
    }
    console.log('[tourGeneration] Routing: Save to cache');
    return 'save_tour_suggestions_to_cache';
  };

  // Build and compile graph
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
    .addNode('save_tour_suggestions_to_cache', saveTourSuggestionsToCache)
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
    .addConditionalEdges(
      'validate_walking_times',
      shouldSaveToCache,
      {
        [END]: END,
        'save_tour_suggestions_to_cache': 'save_tour_suggestions_to_cache'
      }
    )
    .addEdge('save_tour_suggestions_to_cache', END);

  // Compile graph with checkpointer if available
  let checkpointer = null;
  if (redisClient && sessionId) {
    try {
      const { RedisSaver } = await import('@langchain/langgraph-checkpoint-redis');
      checkpointer = new RedisSaver(redisClient);
      console.log('[tourGeneration] Using Redis checkpointer for session:', sessionId);
    } catch (err) {
      console.warn('[tourGeneration] Failed to create Redis checkpointer:', err);
    }
  }

  const compiledGraph = checkpointer ? graph.compile({ checkpointer }) : graph.compile();

  console.log('[tourGeneration] Graph compiled successfully');
  return compiledGraph;
}

// Main export function - generates tours using LangGraph workflow
export async function generateTours({ sessionId, latitude, longitude, durationMinutes, customization, language, redisClient }) {
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

  const finalState = await graph.invoke(
    { messages: [] },
    config
  );

  // Extract results from final state
  const city = finalState.areaContext?.city || null;
  const neighborhood = finalState.areaContext?.neighborhood || null;
  const tours = finalState.finalTours || [];

  return {
    city,
    neighborhood,
    tours,
  };
}