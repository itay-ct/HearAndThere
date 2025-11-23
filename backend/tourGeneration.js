import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";

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

async function cachePlaceInRedis(redisClient, place) {
  if (!redisClient || !place.id) return;

  const placeKey = `poi:${place.id}`;
  const geoKey = 'geo:pois';
  
  try {
    // Check if place already exists
    let existingPlace = null;
    try {
      const existing = await redisClient.json.get(placeKey, { path: '$' });
      existingPlace = existing && existing[0];
    } catch (jsonErr) {
      // Key doesn't exist or not JSON, that's fine
      console.log('[tourGeneration] No existing place found for', place.id);
    }
    
    // Prepare place document
    const placeDoc = {
      place_id: place.id,
      name: place.name,
      types: place.types || [],
      location: {
        lat: place.latitude,
        lon: place.longitude
      },
      rating: place.rating,
      source: 'google_places_api',
      fetched_at: new Date().toISOString(),
      pinned: existingPlace?.pinned || false,
      notes: existingPlace?.notes || null,
      tags: existingPlace?.tags || [],
      images: existingPlace?.images || []
    };

    console.log('[tourGeneration] Caching place:', {
      id: place.id,
      name: place.name,
      lat: place.latitude,
      lon: place.longitude,
      key: placeKey
    });

    // Upsert the place document
    await redisClient.json.set(placeKey, '$', placeDoc);
    
    // Set TTL only if not pinned
    if (!placeDoc.pinned) {
      await redisClient.expire(placeKey, 7 * 24 * 60 * 60); // 7 days
    }
    
    // Add to geospatial index
    await redisClient.geoAdd(geoKey, {
      longitude: place.longitude,
      latitude: place.latitude,
      member: place.id
    });
    
    console.log('[tourGeneration] Successfully cached place', place.id);
  } catch (err) {
    console.error('[tourGeneration] Failed to cache place', place.id, err);
  }
}

async function searchNearbyPois(latitude, longitude, redisClient = null) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[tourGeneration] GOOGLE_MAPS_API_KEY is not set; skipping POI search.');
    debugLog('searchNearbyPois: missing GOOGLE_MAPS_API_KEY');
    return [];
  }

  const radiusMeters = 1500;
  
  const primaryTypes = [
  'historical_place',
  'historical_landmark',
  'monument',
  'cultural_landmark',
  'museum',
  'art_gallery',
  'sculpture',
  'performing_arts_theater',
  'auditorium',
  'cultural_center',
  'park',
  'botanical_garden',
  'plaza',
  'garden',
  'visitor_center',
  'ice_cream_shop',
  'bakery',
  'cafe',
  'confectionery',
  'coffee_shop',
  'church',
  'hindu_temple',
  'mosque',
  'synagogue',
  'observation_deck',
  'amphitheatre',
  'picnic_ground',
  'wildlife_park',
  'zoo',
  'amusement_center',
  'tourist_attraction',
  'city_hall',
  'courthouse',
  'public_bathroom',
  'cemetery',
  'library',
  'planetarium',
  'opera_house',
  'street_art',
  'landmark',
  'bridge',
  'viewpoint',
  'architecture_landmark'
];

const secondaryTypes = [
  'art_studio',
  'farm',
  'ranch',
  'adventure_sports_center',
  'dog_park',
  'marina',
  'roller_coaster',
  'skateboard_park',
  'wildlife_refuge',
  'acai_shop',
  'bagel_shop',
  'cat_cafe',
  'dog_cafe',
  'juice_shop',
  'vegan_restaurant',
  'wine_bar',
  'local_government_office',
  'embassy',
  'apartment_building',
  'campground',
  'mobile_home_park',
  'beach',
  'playground',
  'ski_resort',
  'athletic_field',
  'ice_skating_rink',
  'ferry_terminal',
  'taxi_stand',
  'transit_depot',
  'truck_stop',
  'summer_camp_organizer',
  'public_bath'
];

  const allResults = [];

  const [primaryResults, secondaryResults] = await Promise.all([
    searchPlacesNearby(latitude, longitude, radiusMeters, primaryTypes),
    searchPlacesNearby(latitude, longitude, radiusMeters, secondaryTypes)
  ]);

  allResults.push(...primaryResults, ...secondaryResults);

  // Remove duplicates by place_id
  const uniqueResults = [];
  const seenIds = new Set();
  for (const place of allResults) {
    if (!seenIds.has(place.id)) {
      seenIds.add(place.id);
      uniqueResults.push(place);
    }
  }

  // Cache all places in Redis
  if (redisClient) {
    await Promise.all(
      uniqueResults.map(place => cachePlaceInRedis(redisClient, place))
    );
  }

  debugLog('searchNearbyPois: got unique results count', uniqueResults.length);
  return uniqueResults.slice(0, 20);
}

async function searchPlacesNearby(latitude, longitude, radiusMeters, includedTypes) {
  const url = 'https://places.googleapis.com/v1/places:searchNearby';
  
  const requestBody = {
    includedTypes,
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: {
          latitude,
          longitude
        },
        radius: radiusMeters
      }
    }
  };

  debugLog('searchPlacesNearby: requesting', { url, types: includedTypes.length });
  
  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.location,places.rating'
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    console.warn('[tourGeneration] Places search failed with status', res.status);
    debugLog('searchPlacesNearby: non-OK response', res.status);
    return [];
  }

  const data = await res.json();
  const places = Array.isArray(data.places) ? data.places : [];
  debugLog('searchPlacesNearby: got places count', places.length);

  return places.map((place, index) => ({
    id: place.id || `poi_${index + 1}`,
    name: place.displayName?.text || 'Unknown Place',
    latitude: place.location?.latitude || latitude,
    longitude: place.location?.longitude || longitude,
    types: place.types || [],
    rating: place.rating || null,
  }));
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

async function buildAreaContext({ latitude, longitude, redisClient = null }) {
  debugLog('buildAreaContext: start', { latitude, longitude });
  
  // Run geocoding and POI search in parallel
  const [{ city, neighborhood }, pois] = await Promise.all([
    reverseGeocode(latitude, longitude),
    searchNearbyPois(latitude, longitude, redisClient), // Pass redisClient
  ]);

  // Run city and neighborhood summaries in parallel
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

  // Prepare POI data without place_id for LLM
  const poisForLLM = Array.isArray(pois) ? pois.map(poi => ({
    name: poi.name,
    latitude: poi.latitude,
    longitude: poi.longitude,
    types: poi.types,
    rating: poi.rating
  })) : [];

  const userPayload = {
    latitude,
    longitude,
    durationMinutes,
    city,
    neighborhood,
    pois: poisForLLM, // Use cleaned POI data without place_id
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
    poiCount: poisForLLM.length,
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

  // Use Annotation.Root to extend MessagesAnnotation
  const { Annotation } = await import('@langchain/langgraph');
  
  const TourState = Annotation.Root({
    ...MessagesAnnotation.spec,
    areaContext: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
    candidateTours: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => [],
    }),
    finalTours: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => [],
    }),
  });

  const collectContextNode = async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    let areaContext;
    try {
      areaContext = await buildAreaContext({ latitude, longitude, redisClient });
    } catch (err) {
      console.warn('[tourGeneration] buildAreaContext failed in collectContextNode', err);
      areaContext = {
        city: null,
        neighborhood: null,
        pois: [],
        cityData: { summary: null, keyFacts: null },
        neighborhoodData: { summary: null, keyFacts: null },
      };
    }

    const summaryParts = [];
    if (areaContext.city) summaryParts.push(`city=${areaContext.city}`);
    if (areaContext.neighborhood) summaryParts.push(`neighborhood=${areaContext.neighborhood}`);
    summaryParts.push(`pois=${Array.isArray(areaContext.pois) ? areaContext.pois.length : 0}`);
    
    const msg = {
      role: 'system',
      content: `Collected area context for session ${sessionId || 'n/a'} (${summaryParts.join(', ')}).`,
    };

    return { 
      messages: [...messages, msg],
      areaContext
    };
  };

  const generateCandidatesNode = async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const areaContext = state.areaContext;

    if (!areaContext) {
      throw new Error('Area context not available in state');
    }

    const rawTours = await generateToursWithGemini({
      latitude,
      longitude,
      durationMinutes,
      city: areaContext.city,
      neighborhood: areaContext.neighborhood,
      pois: areaContext.pois,
      cityData: areaContext.cityData,
      neighborhoodData: areaContext.neighborhoodData,
    });
    
    console.log('[tourGeneration] generateCandidatesNode: generated tours count', Array.isArray(rawTours) ? rawTours.length : 0);
    
    const allTours = Array.isArray(rawTours) ? rawTours : [];
    
    const msg = {
      role: 'system',
      content: `Generated ${Array.isArray(rawTours) ? rawTours.length : 0} tours, keeping all ${allTours.length} for validation.`,
    };

    return { 
      messages: [...messages, msg],
      candidateTours: allTours
    };
  };

  const validateWalkingTimesNode = async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const tours = state.candidateTours || [];
    
    if (!tours.length) {
      console.warn('[tourGeneration] No tours to validate walking times for');
      return { messages };
    }
    
    console.log('[tourGeneration] validateWalkingTimesNode: validating', tours.length, 'tours');
    
    // Pass latitude and longitude to validateWalkingTimes
    const validatedTours = await validateWalkingTimes(tours, latitude, longitude, redisClient);
    
    const msg = {
      role: 'system',
      content: `Validated walking times for ${validatedTours.length} tours using Google Maps.`,
    };

    return { 
      messages: [...messages, msg],
      finalTours: validatedTours
    };
  };

  // Create Redis checkpointer with error handling
  let checkpointer = null;
  try {
    checkpointer = new RedisSaver(redisClient);
  } catch (err) {
    console.warn('[tourGeneration] Redis checkpointer failed to initialize, running without persistence:', err.message);
  }

  const graph = new StateGraph(TourState)
    .addNode('collect_context', collectContextNode)
    .addNode('generate_candidate_tours', generateCandidatesNode)
    .addNode('validate_walking_times', validateWalkingTimesNode)
    .addEdge(START, 'collect_context')
    .addEdge('collect_context', 'generate_candidate_tours')
    .addEdge('generate_candidate_tours', 'validate_walking_times')
    .addEdge('validate_walking_times', END)
    .compile(checkpointer ? { checkpointer } : {}); // Use checkpointer if available

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

  // Use thread_id for checkpointing
  const config = {
    configurable: { thread_id: sessionId || 'default' },
  };

  const finalState = await graph.invoke(
    { messages: [] },
    config
  );

  // Extract results from final state
  if (finalState.areaContext) {
    city = finalState.areaContext.city;
    neighborhood = finalState.areaContext.neighborhood;
  }
  
  tours = finalState.finalTours || [];

  return {
    city,
    neighborhood,
    tours,
  };
}

async function validateWalkingTimes(tours, startLatitude, startLongitude, redisClient = null) {
  if (!GOOGLE_MAPS_API_KEY || !Array.isArray(tours) || tours.length === 0) {
    console.warn('[tourGeneration] Cannot validate walking times - missing API key or no tours');
    return tours;
  }

  const validatedTours = [];

  for (const tour of tours) {
    if (!Array.isArray(tour.stops) || tour.stops.length < 1) {
      validatedTours.push(tour);
      continue;
    }

    try {
      // Include the user's starting position as the origin
      const origin = `${startLatitude},${startLongitude}`;
      const destination = `${tour.stops[tour.stops.length - 1].latitude},${tour.stops[tour.stops.length - 1].longitude}`;
      
      // Build waypoints including ALL tour stops except the last one
      let waypoints = '';
      if (tour.stops.length > 1) {
        const waypointCoords = tour.stops.slice(0, -1).map(stop => `${stop.latitude},${stop.longitude}`);
        waypoints = waypointCoords.join('|');
      }

      const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
      url.searchParams.set('origin', origin);
      url.searchParams.set('destination', destination);
      if (waypoints) url.searchParams.set('waypoints', waypoints);
      url.searchParams.set('mode', 'walking');
      url.searchParams.set('key', GOOGLE_MAPS_API_KEY);

      console.log('[tourGeneration] Validating walking times for tour:', tour.id);
      
      // Add timeout and retry logic
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(url.toString(), { 
        signal: controller.signal,
        headers: {
          'User-Agent': 'HearAndThere/1.0'
        }
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.warn('[tourGeneration] Directions API failed for tour', tour.id, response.status);
        validatedTours.push(tour);
        continue;
      }

      const data = await response.json();
      if (data.status !== 'OK' || !data.routes || data.routes.length === 0) {
        console.warn('[tourGeneration] No valid route found for tour', tour.id, 'API status:', data.status);
        validatedTours.push(tour);
        continue;
      }

      const route = data.routes[0];
      const legs = route.legs || [];

      // Now we should have legs.length === tour.stops.length (including start->first POI)
      if (legs.length !== tour.stops.length) {
        console.warn('[tourGeneration] Leg count mismatch for tour', tour.id, 'expected:', tour.stops.length, 'got:', legs.length);
        validatedTours.push(tour);
        continue;
      }

      // Calculate LLM vs Google Maps walking times
      let llmTotalWalkingMinutes = 0;
      let googleTotalWalkingMinutes = 0;

      const updatedStops = tour.stops.map((stop, index) => {
        const updatedStop = {
          ...stop,
          walkMinutesFromPrevious_llm: stop.walkMinutesFromPrevious // Save original LLM estimate
        };

        // Get Google Maps walking time for this leg
        const leg = legs[index];
        const googleWalkingSeconds = leg.duration?.value || 0;
        const googleWalkingMinutes = Math.ceil(googleWalkingSeconds / 60);
        
        updatedStop.walkMinutesFromPrevious = googleWalkingMinutes;
        
        llmTotalWalkingMinutes += stop.walkMinutesFromPrevious || 0;
        googleTotalWalkingMinutes += googleWalkingMinutes;

        return updatedStop;
      });

      // Calculate total tour time with Google Maps walking times
      const totalDwellMinutes = updatedStops.reduce((sum, stop) => sum + (stop.dwellMinutes || 0), 0);
      const updatedTotalMinutes = googleTotalWalkingMinutes + totalDwellMinutes;

      const validatedTour = {
        ...tour,
        stops: updatedStops,
        estimatedTotalMinutes_llm: tour.estimatedTotalMinutes, // Save original LLM estimate
        estimatedTotalMinutes: updatedTotalMinutes
      };

      // Debug logging
      console.log('[tourGeneration] Walking time validation for tour', tour.id, {
        llmTotalWalkingMinutes,
        googleTotalWalkingMinutes,
        difference: googleTotalWalkingMinutes - llmTotalWalkingMinutes,
        llmTotalTourMinutes: tour.estimatedTotalMinutes,
        googleTotalTourMinutes: updatedTotalMinutes,
        tourTimeDifference: updatedTotalMinutes - tour.estimatedTotalMinutes
      });

      validatedTours.push(validatedTour);

    } catch (err) {
      console.error('[tourGeneration] Error validating walking times for tour', tour.id, err.message);
      // Always include the tour even if validation fails
      validatedTours.push(tour);
    }
  }

  return validatedTours;
}
