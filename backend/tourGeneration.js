// Import utility functions
import { createTourState } from './utils/tourState.js';

// Import cache nodes
import { createCheckCacheForTourSuggestionsNode } from './nodes/cache/checkCacheForTourSuggestions.js';
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
    longitude,
    redisClient
  });

  const generateAreaSummariesNode = createGenerateAreaSummariesNode({
    redisClient
  });

  const assembleAreaContextNode = createAssembleAreaContextNode({
    sessionId,
    redisClient
  });

  const generateCandidatesNode = createGenerateCandidateToursNode({
    latitude,
    longitude,
    durationMinutes: normalizedDuration,
    customization,
    language,
    redisClient
  });

  // Routing functions
  const shouldCheckCache = (state) => {
    // Check cache only if no customization
    if (customization && customization.trim().length > 0) {
      console.log('[tourGeneration] Routing: Skip cache check (customization provided)');
      return 'query_pois';
    }
    console.log('[tourGeneration] Routing: Check cache');
    return 'check_cache_for_tour_suggestions';
  };

  const routeAfterCacheCheck = (state) => {
    if (state.cacheHit) {
      console.log('[tourGeneration] Routing: Cache hit, skip to end');
      return END;
    }
    console.log('[tourGeneration] Routing: Cache miss, continue to query POIs');
    return 'query_pois';
  };

  const routeAfterQueryPois = (state) => {
    // Check if we actually got POIs from the query
    const poiCount = state.pois?.length || 0;

    // If we have no POIs and haven't tried Google Maps yet, fetch from Google Maps
    if (poiCount === 0 && !state.googleMapsFetched) {
      console.warn('[tourGeneration] ⚠️ Routing: query_pois returned 0 POIs, falling back to Google Maps');
      return 'fetch_pois_from_google_maps';
    }

    console.log(`[tourGeneration] Routing: query_pois returned ${poiCount} POIs, continuing to reverse_geocode`);
    return 'reverse_geocode';
  };

  // Build and compile graph
  // Note: Cache saving nodes (savePoiToCache, saveTourSuggestionsToCache) are NOT in the graph
  // They will be called asynchronously after the graph completes to avoid blocking the user response
  const graph = new StateGraph(TourState)
    .addNode('check_cache_for_tour_suggestions', checkCacheForTourSuggestionsNode)
    .addNode('fetch_pois_from_google_maps', fetchPoisNode)
    .addNode('query_pois', queryPoisNode)
    .addNode('reverse_geocode', reverseGeocodeNode)
    .addNode('generate_area_summaries', generateAreaSummariesNode)
    .addNode('assemble_area_context', assembleAreaContextNode)
    .addNode('generate_candidate_tours', generateCandidatesNode)
    // Routing
    .addConditionalEdges(
      START,
      shouldCheckCache,
      {
        'check_cache_for_tour_suggestions': 'check_cache_for_tour_suggestions',
        'query_pois': 'query_pois'
      }
    )
    .addConditionalEdges(
      'check_cache_for_tour_suggestions',
      routeAfterCacheCheck,
      {
        [END]: END,
        'query_pois': 'query_pois'
      }
    )
    .addEdge('fetch_pois_from_google_maps', 'query_pois')
    .addConditionalEdges(
      'query_pois',
      routeAfterQueryPois,
      {
        'fetch_pois_from_google_maps': 'fetch_pois_from_google_maps',
        'reverse_geocode': 'reverse_geocode'
      }
    )
    .addEdge('reverse_geocode', 'generate_area_summaries')
    .addEdge('generate_area_summaries', 'assemble_area_context')
    .addEdge('assemble_area_context', 'generate_candidate_tours')
    .addEdge('generate_candidate_tours', END);

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

/**
 * Check if a session has been cancelled
 */
async function isSessionCancelled(sessionId, redisClient) {
  if (!sessionId || !redisClient) {
    return false;
  }

  try {
    const key = `session:${sessionId}`;
    const cancelled = await redisClient.hGet(key, 'cancelled');
    return cancelled === 'true';
  } catch (err) {
    console.error('[tourGeneration] Error checking cancellation status:', err);
    return false;
  }
}

// Main export function - generates tours using LangGraph workflow
export async function generateTours({ sessionId, latitude, longitude, durationMinutes, customization, language, city: providedCity, neighborhood: providedNeighborhood, country: providedCountry, redisClient }) {
  if (!redisClient) {
    throw new Error('Redis client is required for tour generation');
  }

  // Check if session was cancelled before starting
  if (await isSessionCancelled(sessionId, redisClient)) {
    console.log('[tourGeneration] Session cancelled before starting:', sessionId);
    throw new Error('CANCELLED');
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

  // Initialize state with provided city/neighborhood/country if available
  const initialState = {
    messages: [],
    sessionId, // Pass sessionId to state so nodes can check cancellation
    ...(providedCity && { city: providedCity }),
    ...(providedNeighborhood && { neighborhood: providedNeighborhood }),
    ...(providedCountry && { country: providedCountry })
  };

  // Check for cancellation before invoking graph
  if (await isSessionCancelled(sessionId, redisClient)) {
    console.log('[tourGeneration] Session cancelled before graph invocation:', sessionId);
    throw new Error('CANCELLED');
  }

  // Create a promise that rejects if session is cancelled
  const cancellationCheckInterval = setInterval(async () => {
    if (await isSessionCancelled(sessionId, redisClient)) {
      console.log('[tourGeneration] ⚠️ Session cancelled during graph execution:', sessionId);
      clearInterval(cancellationCheckInterval);
    }
  }, 500); // Check every 500ms

  let finalState;
  try {
    finalState = await graph.invoke(
      initialState,
      config
    );
  } finally {
    clearInterval(cancellationCheckInterval);
  }

  // Check for cancellation after graph completes
  if (await isSessionCancelled(sessionId, redisClient)) {
    console.log('[tourGeneration] Session cancelled after graph completion:', sessionId);
    throw new Error('CANCELLED');
  }

  // Check if tour generation failed due to no POIs
  if (finalState.error === 'no_pois_available') {
    console.warn('[tourGeneration] ⚠️ Tour generation failed: No POIs available');
    throw new Error('No points of interest detected in this area. Please try again from a different location.');
  }

  // Extract results from final state - use provided values if available, otherwise use generated values
  const city = providedCity || finalState.areaContext?.city || null;
  const neighborhood = providedNeighborhood || finalState.areaContext?.neighborhood || null;
  const country = providedCountry || finalState.areaContext?.country || null;
  const tours = finalState.finalTours || [];
  const cityData = finalState.cityData || { summary: null, keyFacts: null };
  const neighborhoodData = finalState.neighborhoodData || { summary: null, keyFacts: null };
  const poiTypeSummary = finalState.poiTypeSummary || [];

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
    country,
    tours,
    cityData,
    neighborhoodData,
    poiTypeSummary,
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