/**
 * Geocoding Helper Functions
 *
 * Functions for reverse geocoding and generating area summaries using
 * Google Maps Geocoding API and Gemini LLM.
 *
 * DEBUG LOGGING:
 * To enable detailed debug logging, set the TOUR_DEBUG environment variable:
 *   - TOUR_DEBUG=1 or TOUR_DEBUG=true
 *
 * Example:
 *   TOUR_DEBUG=1 node index.js
 *
 * Or add to your .env file:
 *   TOUR_DEBUG=1
 */

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LOCATIONIQ_API_KEY = process.env.LOCATIONIQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[geocodingHelpers]', ...args);
  }
}

async function safeFetch(url, options) {
  if (typeof fetch === 'undefined') {
    throw new Error('Global fetch is not available. Please use Node 18+ or polyfill fetch.');
  }
  return fetch(url, options);
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

let geminiModelPromise;
async function getGeminiModel() {
  if (!GEMINI_API_KEY) {
    console.warn('[geocodingHelpers] GEMINI_API_KEY is not set');
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
        console.warn('[geocodingHelpers] Failed to load @langchain/google-genai', err);
        return null;
      });
  }
  
  return geminiModelPromise;
}

/**
 * Reverse geocode using Google Maps (fallback)
 * Only queries for RANGE_INTERPOLATED location type for better accuracy
 */
async function reverseGeocodeWithGoogleMaps(latitude, longitude) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[geocodingHelpers] GOOGLE_MAPS_API_KEY is not set; skipping Google Maps reverse-geocoding.');
    debugLog('reverseGeocodeWithGoogleMaps: missing GOOGLE_MAPS_API_KEY');
    return { city: null, neighborhood: null };
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&location_type=RANGE_INTERPOLATED&key=${GOOGLE_MAPS_API_KEY}`;
  debugLog('reverseGeocodeWithGoogleMaps: requesting', url);
  const res = await safeFetch(url);
  if (!res.ok) {
    console.warn('[geocodingHelpers] Google Maps reverse geocoding failed with status', res.status);
    debugLog('reverseGeocodeWithGoogleMaps: non-OK response', res.status);
    return { city: null, neighborhood: null };
  }

  const data = await res.json();
  debugLog('reverseGeocodeWithGoogleMaps: got response result count', Array.isArray(data.results) ? data.results.length : 0);
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

/**
 * Reverse geocode using LocationIQ
 * Extracts city (from town/city) and neighborhood (from suburb/neighbourhood)
 */
async function reverseGeocodeWithLocationIQ(latitude, longitude) {
  if (!LOCATIONIQ_API_KEY) {
    debugLog('reverseGeocodeWithLocationIQ: missing LOCATIONIQ_API_KEY');
    return null;
  }

  const url = `https://us1.locationiq.com/v1/reverse?key=${LOCATIONIQ_API_KEY}&lat=${latitude}&lon=${longitude}&accept-language=en&format=json`;
  debugLog('reverseGeocodeWithLocationIQ: requesting', url);

  try {
    const res = await safeFetch(url);
    if (!res.ok) {
      console.warn('[geocodingHelpers] LocationIQ reverse geocoding failed with status', res.status);
      debugLog('reverseGeocodeWithLocationIQ: non-OK response', res.status);
      return null;
    }

    const data = await res.json();
    debugLog('reverseGeocodeWithLocationIQ: got response', data);

    const address = data.address || {};

    // Extract city - choose the longer value between city and town
    let cityValue = null;
    if (address.city && address.town) {
      cityValue = address.city.length > address.town.length ? address.city : address.town;
      debugLog(`reverseGeocodeWithLocationIQ: Both city and town present - city="${address.city}" (${address.city.length}), town="${address.town}" (${address.town.length}) → chose "${cityValue}"`);
    } else {
      cityValue = address.city || address.town || null;
    }

    // Extract neighborhood - choose the longer value between suburb and neighbourhood
    let neighborhoodValue = null;
    if (address.suburb && address.neighbourhood) {
      neighborhoodValue = address.suburb.length > address.neighbourhood.length ? address.suburb : address.neighbourhood;
      debugLog(`reverseGeocodeWithLocationIQ: Both suburb and neighbourhood present - suburb="${address.suburb}" (${address.suburb.length}), neighbourhood="${address.neighbourhood}" (${address.neighbourhood.length}) → chose "${neighborhoodValue}"`);
    } else {
      neighborhoodValue = address.suburb || address.neighbourhood || null;
    }

    // Decision logic: if one is empty, drop it
    let city = null;
    let neighborhood = null;

    if (cityValue && neighborhoodValue) {
      // Both exist - use both
      city = cityValue;
      neighborhood = neighborhoodValue;
    } else if (cityValue) {
      // Only city exists
      city = cityValue;
    } else if (neighborhoodValue) {
      // Only neighborhood exists - use it as city
      city = neighborhoodValue;
    }

    debugLog('reverseGeocodeWithLocationIQ: extracted', { city, neighborhood });
    return { city, neighborhood };
  } catch (err) {
    console.error('[geocodingHelpers] LocationIQ reverse geocoding error:', err);
    debugLog('reverseGeocodeWithLocationIQ: error', err.message);
    return null;
  }
}

/**
 * Reverse geocode coordinates to get city and neighborhood
 * Uses LocationIQ first, falls back to Google Maps if LocationIQ fails
 */
export async function reverseGeocode(latitude, longitude) {
  // Try LocationIQ first
  const locationIQResult = await reverseGeocodeWithLocationIQ(latitude, longitude);

  if (locationIQResult && (locationIQResult.city || locationIQResult.neighborhood)) {
    console.log('[geocodingHelpers] ✅ LocationIQ reverse geocoding successful:', locationIQResult);
    return locationIQResult;
  }

  // Fallback to Google Maps
  console.log('[geocodingHelpers] LocationIQ failed or returned no data, falling back to Google Maps...');
  const googleMapsResult = await reverseGeocodeWithGoogleMaps(latitude, longitude);

  if (googleMapsResult && (googleMapsResult.city || googleMapsResult.neighborhood)) {
    console.log('[geocodingHelpers] ✅ Google Maps reverse geocoding successful:', googleMapsResult);
    return googleMapsResult;
  }

  console.warn('[geocodingHelpers] Both LocationIQ and Google Maps reverse geocoding failed');
  return { city: null, neighborhood: null };
}

/**
 * Write summary to Redis cache
 * @param {Object} redisClient - Redis client instance
 * @param {string} entityType - Type of entity ('city' or 'neighborhood')
 * @param {string} entityName - Name of the entity
 * @param {Object} summary - Summary object with { summary, keyFacts }
 */
export async function writeSummaryToCache(redisClient, entityType, entityName, summary) {
  if (!redisClient || !entityType || !entityName || !summary) {
    debugLog('writeSummaryToCache: missing required parameters');
    return;
  }

  const cacheKey = `summary_cache:${entityType}:${entityName}`;

  try {
    // Use Redis JSON.SET to store the summary as JSON
    await redisClient.json.set(cacheKey, '$', summary);

    // Set TTL separately (30 days)
    await redisClient.expire(cacheKey, 30 * 24 * 60 * 60);

    debugLog(`writeSummaryToCache: cached ${entityType} summary for ${entityName}`);
  } catch (err) {
    console.error(`[geocodingHelpers] Failed to cache ${entityType} summary for ${entityName}:`, err);
  }
}

/**
 * Read summary from Redis cache
 * @param {Object} redisClient - Redis client instance
 * @param {string} entityType - Type of entity ('city' or 'neighborhood')
 * @param {string} entityName - Name of the entity
 * @returns {Object|null} Summary object with { summary, keyFacts } or null if not found
 */
export async function readSummaryFromCache(redisClient, entityType, entityName) {
  if (!redisClient || !entityType || !entityName) {
    debugLog('readSummaryFromCache: missing required parameters');
    return null;
  }

  const cacheKey = `summary_cache:${entityType}:${entityName}`;

  try {
    // Use Redis JSON.GET to retrieve the summary as JSON
    const cached = await redisClient.json.get(cacheKey);
    if (cached) {
      debugLog(`readSummaryFromCache: cache hit for ${entityType} ${entityName}`);
      return cached;
    }
    debugLog(`readSummaryFromCache: cache miss for ${entityType} ${entityName}`);
    return null;
  } catch (err) {
    console.error(`[geocodingHelpers] Failed to read ${entityType} summary from cache for ${entityName}:`, err);
    return null;
  }
}

/**
 * Generate city summary using Gemini LLM
 * Checks cache first, only generates if not cached
 */
export async function generateCitySummary(city, redisClient = null) {
  if (!city) return { summary: null, keyFacts: null };

  // Check cache first
  if (redisClient) {
    const cached = await readSummaryFromCache(redisClient, 'city', city);
    if (cached) {
      console.log(`[geocodingHelpers] Using cached city summary for ${city}`);
      return cached;
    }
  }

  // Not in cache, generate with Gemini
  if (!GEMINI_API_KEY) {
    console.warn('[geocodingHelpers] GEMINI_API_KEY not set, cannot generate city summary');
    return { summary: null, keyFacts: null };
  }

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
      const result = {
        summary: parsed.summary || null,
        keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : null
      };

      // Cache the result
      if (redisClient && (result.summary || result.keyFacts)) {
        await writeSummaryToCache(redisClient, 'city', city, result);
      }

      return result;
    }
  } catch (err) {
    console.warn(`[geocodingHelpers] Failed to generate city summary for ${city}`, err);
  }

  return { summary: null, keyFacts: null };
}

/**
 * Generate neighborhood summary using Gemini LLM
 * Checks cache first, only generates if not cached
 */
export async function generateNeighborhoodSummary(neighborhood, city, redisClient = null) {
  if (!neighborhood) return { summary: null, keyFacts: null };

  // Check cache first (use city:neighborhood as cache key to avoid conflicts)
  // Different cities can have neighborhoods with the same name
  const cacheKey = city ? `${city}:${neighborhood}` : neighborhood;
  if (redisClient) {
    const cached = await readSummaryFromCache(redisClient, 'neighborhood', cacheKey);
    if (cached) {
      console.log(`[geocodingHelpers] Using cached neighborhood summary for ${neighborhood}${city ? ` in ${city}` : ''}`);
      return cached;
    }
  }

  // Not in cache, generate with Gemini
  if (!GEMINI_API_KEY) {
    console.warn('[geocodingHelpers] GEMINI_API_KEY not set, cannot generate neighborhood summary');
    return { summary: null, keyFacts: null };
  }

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
      const result = {
        summary: parsed.summary || null,
        keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : null
      };

      // Cache the result with city:neighborhood key
      if (redisClient && (result.summary || result.keyFacts)) {
        await writeSummaryToCache(redisClient, 'neighborhood', cacheKey, result);
      }

      return result;
    }
  } catch (err) {
    console.warn(`[geocodingHelpers] Failed to generate neighborhood summary for ${location}`, err);
  }

  return { summary: null, keyFacts: null };
}

