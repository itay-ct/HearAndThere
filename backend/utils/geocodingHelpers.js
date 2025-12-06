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

import { generateNeighborhoodIntroAudio } from '../audioguideGeneration.js';
import { v4 as uuidv4 } from 'uuid';

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

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries (default: 4)
 * @param {number} delayMs - Delay between retries in milliseconds (default: 1000)
 * @param {Function} shouldRetry - Optional function to determine if error should trigger retry
 * @returns {Promise} Result of the function
 */
async function retryWithDelay(fn, maxRetries = 4, delayMs = 1000, shouldRetry = null) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error; // Don't retry this error
      }

      if (attempt < maxRetries) {
        console.warn(`[geocodingHelpers] Attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms...`, error.message);
        await sleep(delayMs);
      }
    }
  }

  // All retries exhausted
  console.error(`[geocodingHelpers] All ${maxRetries} attempts failed`);
  throw lastError;
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
 * Returns country_code (e.g., "us") and full country name (e.g., "United States")
 * Retries up to 4 times with 1-second delay on errors
 */
async function reverseGeocodeWithGoogleMaps(latitude, longitude) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[geocodingHelpers] GOOGLE_MAPS_API_KEY is not set; skipping Google Maps reverse-geocoding.');
    debugLog('reverseGeocodeWithGoogleMaps: missing GOOGLE_MAPS_API_KEY');
    return { countryCode: null, countryName: null, city: null, neighborhood: null };
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&location_type=RANGE_INTERPOLATED&key=${GOOGLE_MAPS_API_KEY}`;
  debugLog('reverseGeocodeWithGoogleMaps: requesting', url);

  try {
    // Retry up to 4 times with 1-second delay
    return await retryWithDelay(
      async () => {
        const res = await safeFetch(url);

        if (!res.ok) {
          const error = new Error(`Google Maps reverse geocoding failed with status ${res.status}`);
          error.status = res.status;
          console.warn('[geocodingHelpers]', error.message);
          debugLog('reverseGeocodeWithGoogleMaps: non-OK response', res.status);
          throw error; // Trigger retry
        }

        const data = await res.json();
        debugLog('reverseGeocodeWithGoogleMaps: got response result count', Array.isArray(data.results) ? data.results.length : 0);
        const first = data.results && data.results[0];
        if (!first || !first.address_components) {
          return { countryCode: null, countryName: null, city: null, neighborhood: null };
        }

        let countryCode = null;
        let countryName = null;
        let city = null;
        let neighborhood = null;
        for (const comp of first.address_components) {
          if (comp.types.includes('country')) {
            // Use short_name for country code (e.g., "US") and lowercase it
            countryCode = comp.short_name ? comp.short_name.toLowerCase() : null;
            // Use long_name for full country name (e.g., "United States")
            countryName = comp.long_name || null;
          }
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

        return { countryCode, countryName, city, neighborhood };
      },
      4, // maxRetries
      1000 // 1 second delay
    );
  } catch (err) {
    console.error('[geocodingHelpers] Google Maps reverse geocoding failed after 4 retries:', err.message);
    debugLog('reverseGeocodeWithGoogleMaps: error', err.message);
    return { countryCode, countryName: null, city: null, neighborhood: null };
  }
}

/**
 * Reverse geocode using LocationIQ
 * Extracts city (from town/city) and neighborhood (from suburb/neighbourhood)
 * Returns country_code (e.g., "us") and full country name (e.g., "United States")
 * Retries up to 4 times with 1-second delay on 429 (rate limit) errors
 */
async function reverseGeocodeWithLocationIQ(latitude, longitude) {
  if (!LOCATIONIQ_API_KEY) {
    debugLog('reverseGeocodeWithLocationIQ: missing LOCATIONIQ_API_KEY');
    return null;
  }

  const url = `https://us1.locationiq.com/v1/reverse?key=${LOCATIONIQ_API_KEY}&lat=${latitude}&lon=${longitude}&accept-language=en&format=json`;
  debugLog('reverseGeocodeWithLocationIQ: requesting', url);

  try {
    // Retry up to 4 times with 1-second delay for 429 errors
    return await retryWithDelay(
      async () => {
        const res = await safeFetch(url);

        // If we get a 429 (rate limit), throw error to trigger retry
        if (res.status === 429) {
          const error = new Error(`LocationIQ rate limit (429)`);
          error.status = 429;
          throw error;
        }

        if (!res.ok) {
          console.warn('[geocodingHelpers] LocationIQ reverse geocoding failed with status', res.status);
          debugLog('reverseGeocodeWithLocationIQ: non-OK response', res.status);
          return null;
        }

        const data = await res.json();
        debugLog('reverseGeocodeWithLocationIQ: got response', data);

        const address = data.address || {};

        // Extract country_code (e.g., "us") - lowercase for consistency
        const countryCode = address.country_code ? address.country_code.toLowerCase() : null;
        // Extract full country name (e.g., "United States")
        const countryName = address.country || null;

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

        debugLog('reverseGeocodeWithLocationIQ: extracted', { countryCode, countryName, city, neighborhood });
        return { countryCode, countryName, city, neighborhood };
      },
      4, // maxRetries
      1000, // 1 second delay
      (error) => error.status === 429 // Only retry on 429 errors
    );
  } catch (err) {
    // If all retries failed with 429, or other error occurred
    if (err.status === 429) {
      console.error('[geocodingHelpers] LocationIQ rate limit exceeded after 4 retries');
    } else {
      console.error('[geocodingHelpers] LocationIQ reverse geocoding error:', err);
    }
    debugLog('reverseGeocodeWithLocationIQ: error', err.message);
    return null;
  }
}

/**
 * Reverse geocode coordinates to get country, city and neighborhood
 * Uses LocationIQ first, falls back to Google Maps if LocationIQ fails
 *
 * @param {number} latitude - Latitude
 * @param {number} longitude - Longitude
 * @param {Object} redisClient - Optional Redis client for proactive summary caching
 * @returns {Promise<Object>} Object with { country, city, neighborhood }
 */
export async function reverseGeocode(latitude, longitude, redisClient = null) {
  // Try LocationIQ first
  const locationIQResult = await reverseGeocodeWithLocationIQ(latitude, longitude);

  if (locationIQResult && (locationIQResult.city || locationIQResult.neighborhood)) {
    console.log('[geocodingHelpers] ✅ LocationIQ reverse geocoding successful:', locationIQResult);

    // Proactively cache summaries in the background (don't await)
    if (redisClient) {
      prewarmSummaryCache(locationIQResult.countryName, locationIQResult.city, locationIQResult.neighborhood, redisClient)
        .catch(err => console.warn('[geocodingHelpers] Failed to prewarm summary cache:', err.message));
    }

    // Return country (full name), city, and neighborhood
    return {
      country: locationIQResult.countryName,
      city: locationIQResult.city,
      neighborhood: locationIQResult.neighborhood
    };
  }

  // Fallback to Google Maps
  console.log('[geocodingHelpers] LocationIQ failed or returned no data, falling back to Google Maps...');
  const googleMapsResult = await reverseGeocodeWithGoogleMaps(latitude, longitude);

  if (googleMapsResult && (googleMapsResult.city || googleMapsResult.neighborhood)) {
    console.log('[geocodingHelpers] ✅ Google Maps reverse geocoding successful:', googleMapsResult);

    // Proactively cache summaries in the background (don't await)
    if (redisClient) {
      prewarmSummaryCache(googleMapsResult.countryName, googleMapsResult.city, googleMapsResult.neighborhood, redisClient)
        .catch(err => console.warn('[geocodingHelpers] Failed to prewarm summary cache:', err.message));
    }

    // Return country (full name), city, and neighborhood
    return {
      country: googleMapsResult.countryName,
      city: googleMapsResult.city,
      neighborhood: googleMapsResult.neighborhood
    };
  }

  console.warn('[geocodingHelpers] Both LocationIQ and Google Maps reverse geocoding failed');
  return { country: null, city: null, neighborhood: null };
}

/**
 * Proactively fetch and cache summaries in the background
 * This improves cache hit rate for subsequent tour generation requests
 * Fires off generation immediately without checking cache first (generation functions handle caching internally)
 *
 * @param {string} country - Full country name (e.g., "Israel", "United States")
 * @param {string} city - City name
 * @param {string} neighborhood - Neighborhood name
 * @param {Object} redisClient - Redis client instance
 */
async function prewarmSummaryCache(country, city, neighborhood, redisClient) {
  if (!redisClient) return;

  // VALIDATION: We must have at least a city to prewarm summaries
  if (!city) {
    console.warn('[geocodingHelpers] ⚠️ Cannot prewarm summary cache without a city. Skipping.', { country, city, neighborhood });
    return;
  }

  console.log('[geocodingHelpers] 🔥 Prewarming summary cache (fire and forget):', { country, city, neighborhood });

  const promises = [];

  // Fire off city summary generation (it will check cache internally)
  console.log(`[geocodingHelpers] Initiating city summary generation: ${city}${country ? ` (${country})` : ''}`);
  promises.push(generateCitySummary(city, country, redisClient));

  // Fire off neighborhood summary generation if we have a neighborhood (it will check cache internally)
  if (neighborhood) {
    console.log(`[geocodingHelpers] Initiating neighborhood summary generation: ${neighborhood}, ${city}${country ? ` (${country})` : ''}`);
    promises.push(generateNeighborhoodSummary(neighborhood, city, country, redisClient));
  }

  // Execute all fetches in parallel (don't await - fire and forget)
  Promise.all(promises)
    .then(() => console.log('[geocodingHelpers] ✅ Summary cache prewarming complete'))
    .catch(err => console.warn('[geocodingHelpers] Failed to prewarm some summaries:', err.message));
}

/**
 * Write summary to Redis cache
 * Uses hierarchical key structure: summary_cache:country:city:neighborhood
 * Example: summary_cache:Israel:Raanana:Kiryat Sharett
 *
 * @param {Object} redisClient - Redis client instance
 * @param {string} country - Full country name (e.g., "Israel", "United States")
 * @param {string} city - City name (optional)
 * @param {string} neighborhood - Neighborhood name (optional)
 * @param {Object} summary - Summary object with { summary, keyFacts }
 */
export async function writeSummaryToCache(redisClient, country, city, neighborhood, summary) {
  if (!redisClient || !summary) {
    debugLog('writeSummaryToCache: missing required parameters');
    return;
  }

  // VALIDATION: Country is REQUIRED for all cache operations
  if (!country) {
    console.error('[geocodingHelpers] ❌ ERROR: Cannot write summary to cache without a country!', { country, city, neighborhood });
    return;
  }

  // VALIDATION: For city summaries (no neighborhood), we must have a city
  // For neighborhood summaries, we must have both city and neighborhood
  if (!neighborhood && !city) {
    console.error('[geocodingHelpers] ❌ ERROR: Cannot write city summary to cache without a city!', { country, city, neighborhood });
    return;
  }
  if (neighborhood && !city) {
    console.error('[geocodingHelpers] ❌ ERROR: Cannot write neighborhood summary to cache without a city!', { country, city, neighborhood });
    return;
  }

  console.log('[geocodingHelpers] writeSummaryToCache called with:', { country, city, neighborhood });

  // Build hierarchical cache key: country:city:neighborhood
  // Country is ALWAYS included as the first component
  const parts = ['summary_cache', country];

  // Add city if provided
  if (city) parts.push(city);

  // Add neighborhood if provided
  if (neighborhood) parts.push(neighborhood);

  const cacheKey = parts.join(':');
  console.log('[geocodingHelpers] Writing to cache key:', cacheKey);

  try {
    // Use Redis JSON.SET to store the summary as JSON
    await redisClient.json.set(cacheKey, '$', summary);

    // Set TTL separately (30 days)
    await redisClient.expire(cacheKey, 30 * 24 * 60 * 60);

    console.log(`[geocodingHelpers] ✅ Cached summary at ${cacheKey}`);
  } catch (err) {
    console.error(`[geocodingHelpers] Failed to cache summary at ${cacheKey}:`, err);
  }
}

/**
 * Read summary from Redis cache
 * Uses hierarchical key structure: summary_cache:country:city:neighborhood
 * Example: summary_cache:Israel:Raanana:Kiryat Sharett
 *
 * @param {Object} redisClient - Redis client instance
 * @param {string} country - Full country name (e.g., "Israel", "United States")
 * @param {string} city - City name (optional)
 * @param {string} neighborhood - Neighborhood name (optional)
 * @returns {Object|null} Summary object with { summary, keyFacts } or null if not found
 */
export function readSummaryFromCache(redisClient, country, city, neighborhood) {
  if (!redisClient) {
    debugLog('readSummaryFromCache: missing redisClient');
    return null;
  }

  // VALIDATION: Country is REQUIRED for all cache operations
  if (!country) {
    console.error('[geocodingHelpers] ❌ ERROR: Cannot read summary from cache without a country!', { country, city, neighborhood });
    return null;
  }

  // VALIDATION: For city summaries (no neighborhood), we must have a city
  // For neighborhood summaries, we must have both city and neighborhood
  if (!neighborhood && !city) {
    console.error('[geocodingHelpers] ❌ ERROR: Cannot read city summary from cache without a city!', { country, city, neighborhood });
    return null;
  }
  if (neighborhood && !city) {
    console.error('[geocodingHelpers] ❌ ERROR: Cannot read neighborhood summary from cache without a city!', { country, city, neighborhood });
    return null;
  }

  console.log('[geocodingHelpers] readSummaryFromCache called with:', { country, city, neighborhood });

  // Build hierarchical cache key: country:city:neighborhood
  // Country is ALWAYS included as the first component
  const parts = ['summary_cache', country];

  // Add city if provided
  if (city) parts.push(city);

  // Add neighborhood if provided
  if (neighborhood) parts.push(neighborhood);

  const cacheKey = parts.join(':');
  console.log('[geocodingHelpers] Reading from cache key:', cacheKey);

  try {
    // Use Redis JSON.GET to retrieve the summary as JSON
    const cached = redisClient.json.get(cacheKey);
    if (cached) {
      console.log(`[geocodingHelpers] ✅ Cache hit at ${cacheKey}`);
      return cached;
    }
    console.log(`[geocodingHelpers] ❌ Cache miss at ${cacheKey}`);
    return null;
  } catch (err) {
    console.error(`[geocodingHelpers] Failed to read summary from cache at ${cacheKey}:`, err);
    return null;
  }
}

/**
 * Generate city summary using Gemini LLM
 * Checks cache first, only generates if not cached
 *
 * @param {string} city - City name
 * @param {string} country - Full country name (e.g., "Israel", "United States") - optional
 * @param {Object} redisClient - Redis client instance
 * @returns {Promise<Object>} Summary object with { summary, keyFacts }
 */
export async function generateCitySummary(city, country = null, redisClient = null) {
  if (!city) {
    console.warn('[geocodingHelpers] ⚠️ generateCitySummary called without a city. Returning null.', { city, country });
    return { summary: null, keyFacts: null };
  }

  // VALIDATION: Country is REQUIRED for cache operations
  if (!country) {
    console.warn('[geocodingHelpers] ⚠️ generateCitySummary called without a country. Cannot use cache. Generating without caching.', { city, country });
    // Continue without caching - we'll generate the summary but won't cache it
  }

  // Check cache first using hierarchical key: country:city (only if we have country)
  if (redisClient && country) {
    const cached = await readSummaryFromCache(redisClient, country, city, null);
    if (cached) {
      console.log(`[geocodingHelpers] Using cached city summary for ${city}, ${country}`);
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

  // Build city description with country for better LLM context
  console.log('[geocodingHelpers] generateCitySummary - country:', country, 'city:', city);
  const cityDescription = country ? `${city}, ${country}` : city;
  console.log('[geocodingHelpers] City description for LLM:', cityDescription);

  const prompt = `Generate a brief summary and key facts about ${cityDescription}. Respond as JSON:
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

      // Cache the result using hierarchical key: country:city (only if we have country)
      if (redisClient && country && (result.summary || result.keyFacts)) {
        await writeSummaryToCache(redisClient, country, city, null, result);
      } else if (redisClient && !country) {
        console.warn('[geocodingHelpers] ⚠️ Cannot cache city summary without country. Summary generated but not cached.');
      }

      return result;
    }
  } catch (err) {
    console.warn(`[geocodingHelpers] Failed to generate city summary for ${city}`, err);
  }

  return { summary: null, keyFacts: null };
}

/**
 * Generate intro script for neighborhood using Gemini Flash 2.5
 * Creates a 1-2 minute spoken introduction about the neighborhood
 *
 * @param {string} neighborhood - Neighborhood name
 * @param {string} city - City name
 * @param {string} country - Country name
 * @param {string} neighborhoodSummary - Summary of the neighborhood
 * @param {Array<string>} neighborhoodKeyFacts - Key facts about the neighborhood
 * @param {string} citySummary - Summary of the city (optional)
 * @param {Array<string>} cityKeyFacts - Key facts about the city (optional)
 * @returns {Promise<string|null>} Intro script text or null if generation fails
 */
async function generateNeighborhoodIntroScript(
  neighborhood,
  city,
  country,
  neighborhoodSummary,
  neighborhoodKeyFacts,
  citySummary = null,
  cityKeyFacts = null
) {
  if (!GEMINI_API_KEY) {
    console.warn('[geocodingHelpers] GEMINI_API_KEY not set, cannot generate intro script');
    return null;
  }

  const model = await getGeminiModel();
  if (!model) return null;

  // Build context from summaries and key facts
  const neighborhoodContext = [
    neighborhoodSummary,
    ...(neighborhoodKeyFacts || [])
  ].filter(Boolean).join('\n- ');

  const cityContext = citySummary || cityKeyFacts?.length > 0
    ? [citySummary, ...(cityKeyFacts || [])].filter(Boolean).join('\n- ')
    : null;

  const prompt = `You are creating a welcoming audio introduction for a walking tour.

LOCATION:
Neighborhood: ${neighborhood}
City: ${city}
Country: ${country}

NEIGHBORHOOD CONTEXT:
${neighborhoodContext}

${cityContext ? `CITY CONTEXT:\n${cityContext}\n` : ''}

TASK:
Write a 1-2 minute spoken introduction script that:
1. Starts with: "While your audioguide is being prepared, here's an intro about ${neighborhood}..."
2. Provides interesting insights about the neighborhood and city
3. Makes the listener excited to explore
4. Ends with an excited tone: "Let's go!"

REQUIREMENTS:
- Natural, conversational tone (as if speaking to a friend)
- 150-250 words (1-2 minutes when spoken)
- Engaging and enthusiastic
- Focus on what makes this area special
- NO markdown, NO special formatting, just plain text
- End with "Let's go!"

Write the script now:`;

  try {
    console.log('[geocodingHelpers] Generating intro script for', neighborhood, city);
    const response = await model.invoke(prompt);
    const script = response.content?.trim() || null;

    if (script) {
      console.log(`[geocodingHelpers] ✅ Generated intro script (${script.length} chars)`);
      return script;
    }

    console.warn('[geocodingHelpers] ⚠️ Empty intro script generated');
    return null;
  } catch (err) {
    console.error('[geocodingHelpers] Failed to generate intro script:', err);
    return null;
  }
}

/**
 * Generate neighborhood summary using Gemini LLM
 * Checks cache first, only generates if not cached
 * Also generates intro_script for the neighborhood
 *
 * @param {string} neighborhood - Neighborhood name
 * @param {string} city - City name (optional)
 * @param {string} country - Full country name (e.g., "Israel", "United States") - optional
 * @param {Object} redisClient - Redis client instance
 * @param {Object} cityData - City summary data with { summary, keyFacts } (optional, for intro script)
 * @param {string} language - Language for TTS generation (e.g., 'english', 'hebrew') - optional
 * @returns {Promise<Object>} Summary object with { summary, keyFacts, intro_script }
 */
export async function generateNeighborhoodSummary(neighborhood, city = null, country = null, redisClient = null, cityData = null, language = 'english') {
  if (!neighborhood) {
    const error = new Error('generateNeighborhoodSummary called without a neighborhood');
    console.error('[geocodingHelpers] ❌ ERROR:', error.message, { neighborhood, city, country });
    throw error;
  }

  if (!city) {
    const error = new Error('generateNeighborhoodSummary called without a city - neighborhood summaries require a city context');
    console.error('[geocodingHelpers] ❌ ERROR:', error.message, { neighborhood, city, country });
    throw error;
  }

  // VALIDATION: Country is REQUIRED for cache operations
  if (!country) {
    console.warn('[geocodingHelpers] ⚠️ generateNeighborhoodSummary called without a country. Cannot use cache. Generating without caching.', { neighborhood, city, country });
    // Continue without caching - we'll generate the summary but won't cache it
  }

  // Check cache first using hierarchical key: country:city:neighborhood (only if we have country)
  if (redisClient && country) {
    const cached = await readSummaryFromCache(redisClient, country, city, neighborhood);
    if (cached) {
      console.log(`[geocodingHelpers] Using cached neighborhood summary for ${neighborhood}, ${city}, ${country}`);
      return cached;
    }
  }

  // Not in cache, generate with Gemini
  if (!GEMINI_API_KEY) {
    console.warn('[geocodingHelpers] GEMINI_API_KEY not set, cannot generate neighborhood summary');
    return {
      summary: null,
      keyFacts: null,
      intro_script: null,
      intro_audio_url: null,
      intro_audio_status: 'pending'
    };
  }

  const model = await getGeminiModel();
  if (!model) return { summary: null, keyFacts: null, intro_script: null };

  // Build location description with available parts, including country for better LLM context
  console.log('[geocodingHelpers] generateNeighborhoodSummary - country:', country, 'city:', city, 'neighborhood:', neighborhood);
  const locationParts = [neighborhood];
  if (city) locationParts.push(city);
  if (country) locationParts.push(country);
  const location = locationParts.join(', ');
  console.log('[geocodingHelpers] Neighborhood description for LLM:', location);

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
        keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : null,
        intro_script: null, // Will be generated next
        intro_audio_url: null, // Will be set by TTS generation
        intro_audio_status: 'pending' // Status: pending, generating, complete, failed
      };

      // Generate intro script using the summary and key facts
      console.log('[geocodingHelpers] Generating intro script for neighborhood...');
      const introScript = await generateNeighborhoodIntroScript(
        neighborhood,
        city,
        country,
        result.summary,
        result.keyFacts,
        cityData?.summary,
        cityData?.keyFacts
      );

      result.intro_script = introScript;

      // Cache the result using hierarchical key: country:city:neighborhood (only if we have country)
      if (redisClient && country && (result.summary || result.keyFacts)) {
        await writeSummaryToCache(redisClient, country, city, neighborhood, result);
        console.log('[geocodingHelpers] ✅ Cached neighborhood data with intro_script and TTS status');

        // Trigger TTS generation immediately in background (don't await)
        if (introScript) {
          console.log('[geocodingHelpers] 🎵 Triggering TTS generation for intro script...');

          // Generate unique filename
          const audioId = uuidv4();
          const fileName = `neighborhood_intro_${audioId}.mp3`;
          const cacheKey = `summary_cache:${country}:${city}:${neighborhood}`;

          // Update status to 'generating' before starting
          redisClient.json.set(cacheKey, '$.intro_audio_status', 'generating')
            .catch(err => console.warn('[geocodingHelpers] Failed to update status to generating:', err));

          // Generate TTS audio
          generateNeighborhoodIntroAudio({
            introScript,
            outputFileName: fileName,
            language,
            voice: null // Will use default voice for language
          }).then(async (audioUrl) => {
            console.log('[geocodingHelpers] ✅ Neighborhood intro TTS generated:', audioUrl);

            // Update cache with audio URL
            await redisClient.json.set(cacheKey, '$.intro_audio_url', audioUrl);
            await redisClient.json.set(cacheKey, '$.intro_audio_status', 'complete');
            console.log(`[geocodingHelpers] ✅ Updated cache with audio URL at ${cacheKey}`);
          }).catch(async (err) => {
            console.error('[geocodingHelpers] ❌ Failed to generate neighborhood intro TTS:', err);

            // Update cache with failed status
            try {
              await redisClient.json.set(cacheKey, '$.intro_audio_status', 'failed');
              await redisClient.json.set(cacheKey, '$.intro_audio_error', err.message || 'TTS generation failed');
            } catch (redisErr) {
              console.error('[geocodingHelpers] Failed to update cache with error status:', redisErr);
            }
          });
        }
      } else if (redisClient && !country) {
        console.warn('[geocodingHelpers] ⚠️ Cannot cache neighborhood summary without country. Summary generated but not cached.');
      }

      return result;
    }
  } catch (err) {
    console.warn(`[geocodingHelpers] Failed to generate neighborhood summary for ${location}`, err);
  }

  return {
    summary: null,
    keyFacts: null,
    intro_script: null,
    intro_audio_url: null,
    intro_audio_status: 'pending'
  };
}

