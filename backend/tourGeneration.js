import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

// Add debug logging at the top
console.log('[tourGeneration] LangSmith config check:', {
  LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY ? 'SET' : 'NOT_SET',
  LANGSMITH_ENDPOINT: process.env.LANGSMITH_ENDPOINT,
  LANGCHAIN_PROJECT: process.env.LANGCHAIN_PROJECT,
  LANGCHAIN_TRACING_V2: process.env.LANGCHAIN_TRACING_V2
});

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const WIKIPEDIA_MCP_BASE_URL = process.env.WIKIPEDIA_MCP_BASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

// Add this debug log right after the constants
console.log('[tourGeneration] Environment check:', {
  GEMINI_API_KEY: !!GEMINI_API_KEY,
  GEMINI_MODEL: GEMINI_MODEL,
  GEMINI_MODEL_type: typeof GEMINI_MODEL
});

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

let geminiModelPromise;
async function getGeminiModel() {
  console.log('[tourGeneration] GEMINI_API_KEY exists:', !!GEMINI_API_KEY);
  console.log('[tourGeneration] GEMINI_MODEL:', GEMINI_MODEL);
  
  if (!GEMINI_API_KEY) {
    console.warn('[tourGeneration] GEMINI_API_KEY is not set');
    return null;
  }

  if (!geminiModelPromise) {
    geminiModelPromise = import('@langchain/google-genai')
      .then((mod) => {
        const { ChatGoogleGenerativeAI } = mod;
        return new ChatGoogleGenerativeAI({
          apiKey: GEMINI_API_KEY,
          model: GEMINI_MODEL,
        });
      })
      .catch((err) => {
        console.warn('[tourGeneration] Failed to load @langchain/google-genai', err);
        return null;
      });
  }
  
  return geminiModelPromise;
}

function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}


async function safeFetch(url, options) {
  if (typeof fetch === 'undefined') {
    throw new Error('Global fetch is not available. Please use Node 18+ or polyfill fetch.');
  }
  return fetch(url, options);
}

async function reverseGeocode(latitude, longitude) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[tourGeneration] GOOGLE_MAPS_API_KEY is not set; skipping reverse-geocoding.');
    debugLog('reverseGeocode: missing GOOGLE_MAPS_API_KEY');
    return { city: null, neighborhood: null };
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_MAPS_API_KEY}`;
  debugLog('reverseGeocode: requesting', url);
  const res = await safeFetch(url);
  if (!res.ok) {
    console.warn('[tourGeneration] Reverse geocoding failed with status', res.status);
    debugLog('reverseGeocode: non-OK response', res.status);
    return { city: null, neighborhood: null };
  }

  const data = await res.json();
  debugLog('reverseGeocode: got response result count', Array.isArray(data.results) ? data.results.length : 0);
  const first = data.results && data.results[0];
  if (!first || !first.address_components) {
    return { city: null, neighborhood: null };
  }

  let city = null;
  let neighborhood = null;
  for (const comp of first.address_components) {
    if (comp.types.includes('locality')) {
      city = comp.long_name;
    }
    if (
      comp.types.includes('sublocality') ||
      comp.types.includes('sublocality_level_1') ||
      comp.types.includes('neighborhood')
    ) {
      neighborhood = comp.long_name;
    }
  }

  return { city, neighborhood };
}

async function searchNearbyPois(latitude, longitude) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[tourGeneration] GOOGLE_MAPS_API_KEY is not set; skipping POI search.');
    debugLog('searchNearbyPois: missing GOOGLE_MAPS_API_KEY');
    return [];
  }

  const radiusMeters = 1500; // ~15–20 minute walking radius
  const url =
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latitude},${longitude}` +
    `&radius=${radiusMeters}&type=tourist_attraction|museum|park|point_of_interest&key=${GOOGLE_MAPS_API_KEY}`;

  debugLog('searchNearbyPois: requesting', url);
  const res = await safeFetch(url);
  if (!res.ok) {
    console.warn('[tourGeneration] Nearby search failed with status', res.status);
    debugLog('searchNearbyPois: non-OK response', res.status);
    return [];
  }

  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  debugLog('searchNearbyPois: got results count', results.length);

  return results.slice(0, 20).map((place, index) => {
    const loc = place.geometry && place.geometry.location;
    return {
      id: place.place_id || `poi_${index + 1}`,
      name: place.name,
      latitude: loc ? loc.lat : latitude,
      longitude: loc ? loc.lng : longitude,
      types: place.types || [],
      rating: place.rating || null,
    };
  });
}

async function generateCitySummary(city) {
  if (!city || !GEMINI_API_KEY) return { summary: null, keyFacts: null };
  
  const model = await getGeminiModel();
  if (!model) return { summary: null, keyFacts: null };

  const prompt = `Generate a brief summary and key facts about ${city}. Respond as JSON:
{
  "summary": "2-3 sentence overview of the city",
  "keyFacts": ["fact 1", "fact 2", "fact 3", "fact 4", "fact 5"]
}`;

  try {
    const response = await model.invoke(prompt);
    const text = response.content || '';
    const jsonText = extractJsonFromText(text);
    if (jsonText) {
      const parsed = JSON.parse(jsonText);
      return {
        summary: parsed.summary || null,
        keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : null
      };
    }
  } catch (err) {
    console.warn(`[tourGeneration] Failed to generate city summary for ${city}`, err);
  }
  
  return { summary: null, keyFacts: null };
}

async function generateNeighborhoodSummary(neighborhood, city) {
  if (!neighborhood || !GEMINI_API_KEY) return { summary: null, keyFacts: null };
  
  const model = await getGeminiModel();
  if (!model) return { summary: null, keyFacts: null };

  const location = city ? `${neighborhood}, ${city}` : neighborhood;
  const prompt = `Generate a brief summary and key facts about ${location}. Respond as JSON:
{
  "summary": "2-3 sentence overview of the neighborhood",
  "keyFacts": ["fact 1", "fact 2", "fact 3", "fact 4", "fact 5"]
}`;

  try {
    const response = await model.invoke(prompt);
    const text = response.content || '';
    const jsonText = extractJsonFromText(text);
    if (jsonText) {
      const parsed = JSON.parse(jsonText);
      return {
        summary: parsed.summary || null,
        keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : null
      };
    }
  } catch (err) {
    console.warn(`[tourGeneration] Failed to generate neighborhood summary for ${location}`, err);
  }
  
  return { summary: null, keyFacts: null };
}

async function buildAreaContext({ latitude, longitude }) {
  debugLog('buildAreaContext: start', { latitude, longitude });
  
  // Run geocoding and POI search in parallel
  const [{ city, neighborhood }, pois] = await Promise.all([
    reverseGeocode(latitude, longitude),
    searchNearbyPois(latitude, longitude),
  ]);

  // Run city and neighborhood summaries in parallel (no Wikipedia dependency)
  const [cityData, neighborhoodData] = await Promise.all([
    generateCitySummary(city),
    generateNeighborhoodSummary(neighborhood, city),
  ]);

  const areaContext = {
    city: city || null,
    neighborhood: neighborhood || null,
    pois,
    cityData: {
      summary: cityData.summary,
      keyFacts: cityData.keyFacts,
    },
    neighborhoodData: {
      summary: neighborhoodData.summary,
      keyFacts: neighborhoodData.keyFacts,
    },
  };

  debugLog('buildAreaContext: done', {
    city: areaContext.city,
    neighborhood: areaContext.neighborhood,
    poiCount: Array.isArray(areaContext.pois) ? areaContext.pois.length : 0,
    hasCitySummary: !!cityData.summary,
    hasNeighborhoodSummary: !!neighborhoodData.summary,
  });

  return areaContext;
}

function heuristicToursFromPois({ latitude, longitude, durationMinutes, city, pois }) {
  if (!pois || pois.length === 0) {
    const baseTitle = city || 'Your Area';
    return [
      {
        id: 'tour_1',
        title: `Stroll Around ${baseTitle}`,
        abstract: 'A relaxed loop around your starting point with a few nearby highlights.',
        theme: 'General Highlights',
        estimatedTotalMinutes: durationMinutes,
        stops: [
          {
            name: 'Start Point',
            latitude,
            longitude,
            dwellMinutes: 10,
            walkMinutesFromPrevious: 0,
          },
        ],
      },
    ];
  }

  const chunkSize = Math.max(2, Math.min(5, Math.ceil(pois.length / 3)));
  const chunks = [];
  for (let i = 0; i < 3; i++) {
    const slice = pois.slice(i * chunkSize, (i + 1) * chunkSize);
    if (slice.length === 0) break;
    chunks.push(slice);
  }

  const themes = ['History', 'Hidden Gems', 'Food & Culture'];

  return chunks.map((chunk, index) => {
    const theme = themes[index] || 'Local Highlights';
    const title = `${theme} Walk in ${city || 'Your Area'}`;
    const perStopDwell = 15;
    const walkBetween = 8;
    const stops = chunk.map((poi, idx) => ({
      name: poi.name,
      latitude: poi.latitude,
      longitude: poi.longitude,
      dwellMinutes: perStopDwell,
      walkMinutesFromPrevious: idx === 0 ? 0 : walkBetween,
    }));
    const estimatedTotalMinutes =
      stops.reduce((sum, s) => sum + s.dwellMinutes + s.walkMinutesFromPrevious, 0);

    return {
      id: `tour_${index + 1}`,
      title,
      abstract: `A ${theme.toLowerCase()}-flavored route visiting ${stops.length} nearby spots.`,
      theme,
      estimatedTotalMinutes,
      stops,
    };
  });
}

async function generateToursWithGemini({ latitude, longitude, durationMinutes, city, neighborhood, pois, cityData, neighborhoodData }) {
  const fallback = () =>
    heuristicToursFromPois({ latitude, longitude, durationMinutes, city, pois });

  if (!GEMINI_API_KEY) {
    console.warn('[tourGeneration] GEMINI_API_KEY is not set; using heuristic tours instead.');
    debugLog('generateToursWithGemini: missing GEMINI_API_KEY, using fallback');
    return fallback();
  }

  const model = await getGeminiModel();
  if (!model) {
    console.warn('[tourGeneration] Gemini model not initialized; using heuristic tours instead.');
    debugLog('generateToursWithGemini: model not initialized, using fallback');
    return fallback();
  }

  const systemPrompt = [
    'You are a tour-planning assistant with access to real-time Google Maps data.',
    'Use Google Maps to find actual places, verify locations, and calculate real walking distances.',
    'Create walking tours using ONLY real places that exist on Google Maps.',
    'Verify each location exists before including it in a tour.',
    'Calculate accurate walking times between actual coordinates.',
    'Given a starting point, nearby points of interest, and context,',
    'propose around 10 candidate walking tours with clear themes.',
    'Each tour must fit roughly within the requested total minutes.',
    'Respond strictly as JSON with a top-level "tours" array.',
    'Each tour object must have: id, title, abstract, theme, estimatedTotalMinutes, stops.',
    'Each stop must have: name, latitude, longitude, dwellMinutes, walkMinutesFromPrevious.',
  ].join(' ');

  const userPayload = {
    latitude,
    longitude,
    durationMinutes,
    city,
    neighborhood,
    pois,
    cityData,
    neighborhoodData,
  };

  const input = [
    systemPrompt,
    '',
    'Here is the JSON input describing the user context:',
    JSON.stringify(userPayload),
    '',
    'Respond ONLY with valid JSON of the form:',
    '{ "tours": [ { "id": "...", "title": "...", "abstract": "...", "theme": "...", "estimatedTotalMinutes": 90, "stops": [ { "name": "...", "latitude": 0, "longitude": 0, "dwellMinutes": 10, "walkMinutesFromPrevious": 5 } ] } ] }',
  ].join('\n');

  debugLog('generateToursWithGemini: invoking model with payload', {
    latitude,
    longitude,
    durationMinutes,
    city,
    neighborhood,
    poiCount: Array.isArray(pois) ? pois.length : 0,
  });

  try {
    const response = await model.invoke(input);
    const text = response.content || '';
    
    debugLog('generateToursWithGemini: raw response text length', text.length);
    console.log('[tourGeneration] generateToursWithGemini: raw response preview:', text.substring(0, 500));

    const jsonText = extractJsonFromText(text);
    if (!jsonText) {
      console.warn('[tourGeneration] Gemini response did not contain JSON; falling back to heuristics.');
      debugLog('generateToursWithGemini: no JSON block found, using fallback');
      return fallback();
    }

    console.log('[tourGeneration] generateToursWithGemini: extracted JSON length:', jsonText.length);
    console.log('[tourGeneration] generateToursWithGemini: JSON preview:', jsonText.substring(0, 500));

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      console.warn('[tourGeneration] Failed to parse Gemini JSON; falling back.', err);
      debugLog('generateToursWithGemini: JSON.parse failed', err?.message || err);
      return fallback();
    }

    console.log('[tourGeneration] generateToursWithGemini: parsed object keys:', Object.keys(parsed));
    const tours = Array.isArray(parsed.tours) ? parsed.tours : [];
    console.log('[tourGeneration] generateToursWithGemini: tours array length:', tours.length);
    debugLog('generateToursWithGemini: parsed tours count', tours.length);
    
    if (!tours.length) {
      return fallback();
    }

    return tours;
  } catch (err) {
    console.warn('[tourGeneration] Gemini request failed; falling back to heuristics.', err);
    debugLog('generateToursWithGemini: request threw, using fallback', err?.message || err);
    return fallback();
  }
}

function filterAndRankTours(tours, durationMinutes) {
  if (!Array.isArray(tours)) return [];

  console.log('[tourGeneration] filterAndRankTours: input tours count', tours.length);
  
  const target = durationMinutes;
  const scored = tours.map((tour, index) => {
    const total = typeof tour.estimatedTotalMinutes === 'number' ? tour.estimatedTotalMinutes : target;
    const durationPenalty = Math.abs(total - target);
    const stopCount = Array.isArray(tour.stops) ? tour.stops.length : 0;
    const varietyBonus = stopCount;
    const score = -durationPenalty + 0.5 * varietyBonus;
    
    console.log('[tourGeneration] filterAndRankTours: tour scoring', {
      id: tour.id,
      title: tour.title,
      estimatedMinutes: total,
      durationPenalty,
      varietyBonus,
      score
    });
    
    return { tour: { ...tour, estimatedTotalMinutes: total }, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const topTours = scored.slice(0, 3).map((entry, idx) => ({
    ...entry.tour,
    id: entry.tour.id || `tour_${idx + 1}`,
  }));
  
  console.log('[tourGeneration] filterAndRankTours: final tours count', topTours.length);
  console.log('[tourGeneration] filterAndRankTours: final tour IDs', topTours.map(t => t.id));
  
  return topTours;
}

async function persistAreaContextToRedis({ redisClient, sessionKey, areaContext }) {
  if (!redisClient || !sessionKey) return;
  
  debugLog('persistAreaContextToRedis: saving area context', {
    sessionKey,
    city: areaContext.city,
    neighborhood: areaContext.neighborhood,
    poiCount: Array.isArray(areaContext.pois) ? areaContext.pois.length : 0,
  });

  // Clean up any existing keys that might have wrong types
  await cleanupRedisKeys({ redisClient, sessionKey });

  // Store basic info in hash
  await redisClient.hSet(sessionKey, {
    city: areaContext.city || '',
    neighborhood: areaContext.neighborhood || '',
    stage: 'area_context_built',
  });

  // Store POIs as JSON
  if (Array.isArray(areaContext.pois) && areaContext.pois.length > 0) {
    try {
      await redisClient.json.set(`${sessionKey}:pois`, '$', areaContext.pois);
    } catch (err) {
      console.warn('[tourGeneration] Failed to store POIs as JSON', err);
    }
  }
  
  // Store summaries data as JSON
  if (areaContext.summaries) {
    try {
      await redisClient.json.set(`${sessionKey}:summaries`, '$', areaContext.summaries);
    } catch (err) {
      console.warn('[tourGeneration] Failed to store summaries as JSON', err);
    }
  }
}

async function loadAreaContextFromRedis({ redisClient, sessionKey }) {
  if (!redisClient || !sessionKey) return null;
  
  try {
    const base = await redisClient.hGetAll(sessionKey);
    if (!base || !base.city) return null;

    // Load POIs from JSON
    let pois = [];
    try {
      const poisFromJson = await redisClient.json.get(`${sessionKey}:pois`, { path: '$' });
      if (Array.isArray(poisFromJson) && poisFromJson.length > 0 && Array.isArray(poisFromJson[0])) {
        pois = poisFromJson[0];
      }
    } catch (err) {
      console.log('[tourGeneration] No POIs found in Redis JSON');
    }

    // Load summaries data from JSON
    let summaries = [];
    try {
      const summariesFromJson = await redisClient.json.get(`${sessionKey}:summaries`, { path: '$' });
      if (Array.isArray(summariesFromJson) && summariesFromJson.length > 0 && Array.isArray(summariesFromJson[0])) {
        summaries = summariesFromJson[0];
      }
    } catch (err) {
      console.log('[tourGeneration] No summaries data found in Redis JSON');
    }

    return {
      city: base.city,
      neighborhood: base.neighborhood || null,
      pois,
      summaries,
    };
  } catch (err) {
    console.warn('[tourGeneration] Failed to load area context from Redis', err);
    return null;
  }
}

async function appendMessagesToRedis({ redisClient, sessionKey, messages }) {
  if (!redisClient || !sessionKey) return;
  if (!Array.isArray(messages) || !messages.length) return;
  const listKey = `${sessionKey}:messages`;
  await redisClient.rPush(listKey, ...messages.map((m) => JSON.stringify(m)));
}

async function persistCandidateTours({ redisClient, sessionKey, tours }) {
  if (!redisClient || !sessionKey) return;
  
  console.log('[tourGeneration] persistCandidateTours: input tours count', Array.isArray(tours) ? tours.length : 0);
  
  const jsonKey = `${sessionKey}:candidate_tours`;
  
  try {
    // Delete existing key first to avoid type conflicts
    await redisClient.del(jsonKey);
    
    if (Array.isArray(tours) && tours.length) {
      console.log('[tourGeneration] persistCandidateTours: persisting tours', tours.map(t => t.id || 'no-id'));
      await redisClient.json.set(jsonKey, '$', tours);
    } else {
      await redisClient.json.set(jsonKey, '$', []);
    }
    
    console.log('[tourGeneration] persistCandidateTours: completed');
  } catch (err) {
    console.warn('[tourGeneration] Failed to persist candidate tours', err);
  }
}

async function loadCandidateTours({ redisClient, sessionKey }) {
  if (!redisClient || !sessionKey) return [];
  
  const jsonKey = `${sessionKey}:candidate_tours`;
  
  try {
    const tours = await redisClient.json.get(jsonKey, { path: '$' });
    const result = Array.isArray(tours) && tours.length > 0 && Array.isArray(tours[0]) ? tours[0] : [];
    console.log('[tourGeneration] loadCandidateTours: loaded', result.length, 'tours from Redis');
    return result;
  } catch (err) {
    console.log('[tourGeneration] loadCandidateTours: no candidate tours found or error', err.message);
    return [];
  }
}

async function persistFinalTours({ redisClient, sessionKey, tours }) {
  if (!redisClient || !sessionKey) return;
  
  console.log('[tourGeneration] persistFinalTours: input tours count', Array.isArray(tours) ? tours.length : 0);
  
  const jsonKey = `${sessionKey}:tours`;
  const normalizedTours = Array.isArray(tours) ? tours : [];
  
  try {
    // Delete existing key first to avoid type conflicts
    await redisClient.del(jsonKey);
    
    if (normalizedTours.length) {
      console.log('[tourGeneration] persistFinalTours: persisting tours', normalizedTours.map(t => t.id));
      await redisClient.json.set(jsonKey, '$', normalizedTours);
    } else {
      await redisClient.json.set(jsonKey, '$', []);
    }
    
    await redisClient.hSet(sessionKey, {
      tours: JSON.stringify(normalizedTours),
      stage: 'tours_ranked',
    });
    
    console.log('[tourGeneration] persistFinalTours: completed');
  } catch (err) {
    console.warn('[tourGeneration] Failed to persist final tours', err);
  }
}

async function cleanupRedisKeys({ redisClient, sessionKey }) {
  if (!redisClient || !sessionKey) return;
  
  try {
    // Delete potentially conflicting keys
    const keysToDelete = [
      `${sessionKey}:pois`,
      `${sessionKey}:summaries`,
      `${sessionKey}:candidate_tours`,
      `${sessionKey}:tours`
    ];
    
    for (const key of keysToDelete) {
      try {
        await redisClient.del(key);
      } catch (err) {
        // Ignore individual key deletion errors
      }
    }
  } catch (err) {
    console.warn('[tourGeneration] Failed to cleanup Redis keys', err);
  }
}

async function buildTourGraph({ sessionId, latitude, longitude, durationMinutes, redisClient }) {
  const modules = await getLangGraphModules();
  if (!modules) {
    throw new Error('LangGraph modules not available');
  }
  const { StateGraph, MessagesAnnotation, START, END } = modules;
  const sessionKey = sessionId ? `session:${sessionId}` : null;

  const collectContextNode = async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    let areaContext;
    try {
      areaContext = await buildAreaContext({ latitude, longitude });
    } catch (err) {
      console.warn('[tourGeneration] buildAreaContext failed in collectContextNode', err);
      areaContext = {
        city: null,
        neighborhood: null,
        pois: [],
        summaries: { citySummary: null, neighborhoodSummary: null },
      };
    }
    if (redisClient && sessionKey) {
      try {
        await persistAreaContextToRedis({ redisClient, sessionKey, areaContext });
        await redisClient.hSet(sessionKey, { stage: 'context_collected' });
      } catch (err) {
        console.warn('[tourGeneration] Failed to persist area context to Redis', err);
      }
    }
    const summaryParts = [];
    if (areaContext.city) summaryParts.push(`city=${areaContext.city}`);
    if (areaContext.neighborhood) summaryParts.push(`neighborhood=${areaContext.neighborhood}`);
    summaryParts.push(`pois=${Array.isArray(areaContext.pois) ? areaContext.pois.length : 0}`);
    const msg = {
      role: 'system',
      content: `Collected area context for session ${sessionId || 'n/a'} (${summaryParts.join(', ')}).`,
    };
    if (redisClient && sessionKey) {
      await appendMessagesToRedis({ redisClient, sessionKey, messages: [msg] });
    }
    return { messages: [...messages, msg] };
  };

  const generateCandidatesNode = async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    let areaContext =
      redisClient && sessionKey
        ? await loadAreaContextFromRedis({ redisClient, sessionKey })
        : null;
    if (!areaContext || !Array.isArray(areaContext.pois) || !areaContext.pois.length) {
      areaContext = await buildAreaContext({ latitude, longitude });
      if (redisClient && sessionKey) {
        await persistAreaContextToRedis({ redisClient, sessionKey, areaContext });
      }
    }
    const rawTours = await generateToursWithGemini({
      latitude,
      longitude,
      durationMinutes,
      city: areaContext.city,
      neighborhood: areaContext.neighborhood,
      pois: areaContext.pois,
      summaries: areaContext.summaries,
    });
    
    console.log('[tourGeneration] generateCandidatesNode: generated tours count', Array.isArray(rawTours) ? rawTours.length : 0);
    
    if (redisClient && sessionKey) {
      await persistCandidateTours({ redisClient, sessionKey, tours: rawTours });
      await redisClient.hSet(sessionKey, { stage: 'candidates_generated' });
    }
    const msg = {
      role: 'system',
      content: `Generated ${Array.isArray(rawTours) ? rawTours.length : 0} candidate tours using Gemini.`,
    };
    if (redisClient && sessionKey) {
      await appendMessagesToRedis({ redisClient, sessionKey, messages: [msg] });
    }
    return { messages: [...messages, msg] };
  };

  const rankToursNode = async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    let candidateTours =
      redisClient && sessionKey
        ? await loadCandidateTours({ redisClient, sessionKey })
        : [];
    if (!candidateTours.length) {
      let areaContext =
        redisClient && sessionKey
          ? await loadAreaContextFromRedis({ redisClient, sessionKey })
          : null;
      if (!areaContext || !Array.isArray(areaContext.pois) || !areaContext.pois.length) {
        areaContext = await buildAreaContext({ latitude, longitude });
      }
      candidateTours = heuristicToursFromPois({
        latitude,
        longitude,
        durationMinutes,
        city: areaContext.city,
        neighborhood: areaContext.neighborhood,
        pois: areaContext.pois,
      });
    }
    const topTours = filterAndRankTours(candidateTours, durationMinutes);
    if (redisClient && sessionKey) {
      await persistFinalTours({ redisClient, sessionKey, tours: topTours });
    }
    const msg = {
      role: 'system',
      content: `Ranked tours and selected top ${Array.isArray(topTours) ? topTours.length : 0} tours.`,
    };
    if (redisClient && sessionKey) {
      await appendMessagesToRedis({ redisClient, sessionKey, messages: [msg] });
    }
    return { messages: [...messages, msg] };
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('collect_context', collectContextNode)
    .addNode('generate_candidate_tours', generateCandidatesNode)
    .addNode('rank_tours', rankToursNode)
    .addEdge(START, 'collect_context')
    .addEdge('collect_context', 'generate_candidate_tours')
    .addEdge('generate_candidate_tours', 'rank_tours')
    .addEdge('rank_tours', END)
    .compile();

  return graph;
}



export async function generateTours({ sessionId, latitude, longitude, durationMinutes, redisClient }) {
  let city = null;
  let neighborhood = null;
  let tours = [];

  if (!redisClient) {
    console.warn('[tourGeneration] Redis client not provided; running in stateless mode.');
    const areaContext = await buildAreaContext({ latitude, longitude });
    const rawTours = await generateToursWithGemini({
      latitude,
      longitude,
      durationMinutes,
      city: areaContext.city,
      neighborhood: areaContext.neighborhood,
      pois: areaContext.pois,
      summaries: areaContext.summaries,
    });
    const topTours = filterAndRankTours(rawTours, durationMinutes);
    return {
      city: areaContext.city || null,
      neighborhood: areaContext.neighborhood || null,
      tours: topTours,
    };
  }

  const graph = await buildTourGraph({
    sessionId,
    latitude,
    longitude,
    durationMinutes,
    redisClient,
  });

  await graph.invoke(
    { messages: [] },
    {
      configurable: { thread_id: sessionId || undefined },
    },
  );

  if (sessionId) {
    const sessionKey = `session:${sessionId}`;
    try {
      const base = await redisClient.hGetAll(sessionKey);
      if (base && typeof base === 'object') {
        if (base.city) city = base.city;
        if (base.neighborhood) neighborhood = base.neighborhood;
      }

      // Use RedisJSON to read tours instead of lRange
      const jsonKey = `${sessionKey}:tours`;
      try {
        const toursFromJson = await redisClient.json.get(jsonKey, { path: '$' });
        if (Array.isArray(toursFromJson) && toursFromJson.length > 0 && Array.isArray(toursFromJson[0])) {
          tours = toursFromJson[0];
        }
      } catch (jsonErr) {
        console.log('[tourGeneration] No JSON tours found, trying fallback from hash');
        // Fallback to hash field if JSON doesn't exist
        if (base && base.tours) {
          try {
            const parsed = JSON.parse(base.tours);
            if (Array.isArray(parsed)) {
              tours = parsed;
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      console.warn('[tourGeneration] Failed to read final tours from Redis', err);
    }
  }

  return {
    city,
    neighborhood,
    tours,
  };
}
