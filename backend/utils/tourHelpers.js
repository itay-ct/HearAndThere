/**
 * Tour Helper Functions
 *
 * Functions for generating, filtering, and validating walking tours using
 * Gemini LLM and Google Maps Directions API.
 */

import { traceable } from "langsmith/traceable";
import { checkCancellation } from './cancellationHelper.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL_TOUR_GENERATION || 'gemini-2.5-flash';
const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[tourHelpers]', ...args);
  }
}

let geminiModelPromise;
async function getGeminiModel() {
  if (!GEMINI_API_KEY) {
    console.warn('[tourHelpers] GEMINI_API_KEY is not set');
    return null;
  }

  if (!geminiModelPromise) {
    geminiModelPromise = import('@google/generative-ai')
      .then((mod) => {
        const { GoogleGenerativeAI } = mod;
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        return genAI.getGenerativeModel({ model: GEMINI_MODEL });
      })
      .catch((err) => {
        console.warn('[tourHelpers] Failed to load @google/generative-ai', err);
        return null;
      });
  }

  return geminiModelPromise;
}

// Define unified JSON schema for tour generation (top-level array for both streaming and non-streaming)
const tourGenerationSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique identifier for the tour"
      },
      title: {
        type: "string",
        description: "Tour title"
      },
      abstract: {
        type: "string",
        description: "Brief description of the tour"
      },
      theme: {
        type: "string",
        description: "Tour theme (e.g., History, Food & Culture, Hidden Gems)"
      },
      estimatedTotalMinutes: {
        type: "number",
        description: "Total estimated duration in minutes including walking and dwell time"
      },
      stops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the stop/POI"
            },
            latitude: {
              type: "number",
              description: "Latitude coordinate"
            },
            longitude: {
              type: "number",
              description: "Longitude coordinate"
            },
            dwellMinutes: {
              type: "number",
              description: "Time to spend at this stop in minutes"
            },
            walkMinutesFromPrevious: {
              type: "number",
              description: "Walking time from previous stop in minutes (0 for first stop)"
            }
          },
          required: ["name", "latitude", "longitude", "dwellMinutes", "walkMinutesFromPrevious"]
        }
      }
    },
    required: ["id", "title", "abstract", "theme", "estimatedTotalMinutes", "stops"]
  }
};

/**
 * Manual streaming JSON extractor for tour objects
 * Accumulates streamed JSON text and emits each completed top-level {...} tour object
 * as soon as it becomes valid JSON
 *
 * @param {AsyncIterable<string>} textStream - Stream of text chunks
 * @yields {Object} Complete tour objects as they become available
 */
async function* extractToursFromStream(textStream) {
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let currentTourStart = -1;
  let toursEmitted = 0;

  // Track which fields we've seen for the current tour
  let currentTourFields = new Set();

  for await (const chunk of textStream) {
    buffer += chunk;

    for (let i = buffer.length - chunk.length; i < buffer.length; i++) {
      const char = buffer[i];

      // Handle string escaping
      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      // Handle string boundaries
      if (char === '"') {
        inString = !inString;
        continue;
      }

      // Skip characters inside strings
      if (inString) {
        continue;
      }

      // Track depth of nested objects/arrays
      if (char === '{') {
        if (depth === 0) {
          // Start of a new tour object (we're inside the top-level array)
          currentTourStart = i;
          currentTourFields = new Set(); // Reset field tracking
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && currentTourStart !== -1) {
          // End of a tour object - try to parse it
          const tourJson = buffer.substring(currentTourStart, i + 1);
          try {
            const tour = JSON.parse(tourJson);
            toursEmitted++;
            console.log(`[tourHelpers] 🎉 Streamed tour ${toursEmitted}: ${tour.title || 'Untitled'}`);
            debugLog(`Streamed tour ${toursEmitted}:`, tour);
            yield tour;

            // Clear the buffer up to this point to save memory
            buffer = buffer.substring(i + 1);
            i = -1; // Reset index since we modified buffer
            currentTourStart = -1;
            currentTourFields = new Set(); // Reset for next tour
          } catch (err) {
            // Not valid JSON yet, but check if we can extract partial fields
            if (currentTourStart !== -1) {
              const partialJson = buffer.substring(currentTourStart, i + 1);

              // Try to detect when we get title, abstract, theme
              if (!currentTourFields.has('title') && partialJson.includes('"title"')) {
                const titleMatch = partialJson.match(/"title"\s*:\s*"([^"]+)"/);
                if (titleMatch) {
                  console.log(`[tourHelpers] 📝 Got tour title: "${titleMatch[1]}"`);
                  currentTourFields.add('title');
                }
              }

              if (!currentTourFields.has('abstract') && partialJson.includes('"abstract"')) {
                const abstractMatch = partialJson.match(/"abstract"\s*:\s*"([^"]+)"/);
                if (abstractMatch) {
                  console.log(`[tourHelpers] 📄 Got tour abstract: "${abstractMatch[1].substring(0, 50)}..."`);
                  currentTourFields.add('abstract');
                }
              }

              if (!currentTourFields.has('theme') && partialJson.includes('"theme"')) {
                const themeMatch = partialJson.match(/"theme"\s*:\s*"([^"]+)"/);
                if (themeMatch) {
                  console.log(`[tourHelpers] 🎨 Got tour theme: "${themeMatch[1]}"`);
                  currentTourFields.add('theme');
                }
              }
            }

            debugLog('Tour JSON not yet complete, continuing...');
          }
        }
      }
    }
  }

  debugLog(`Streaming complete. Total tours emitted: ${toursEmitted}`);
}

// Remove the entire heuristic function - no longer needed

/**
 * Generate tours using Gemini LLM with streaming support
 *
 * @param {Object} options - Generation options
 * @param {boolean} options.streaming - Enable streaming mode (default: false)
 * @returns {Promise<Array>|AsyncGenerator<Object>} Tours array or async generator of tour objects
 */
export async function generateToursWithGemini({
  latitude,
  longitude,
  durationMinutes,
  customization,
  language,
  city,
  neighborhood,
  pois,
  cityData,
  neighborhoodData,
  foodPois = [],
  sessionId = null,
  redisClient = null,
  streaming = false
}) {
  if (!GEMINI_API_KEY) {
    console.error('[tourHelpers] GEMINI_API_KEY is not set');
    throw new Error('Tour generation service is unavailable. Please try again later.');
  }

  const model = await getGeminiModel();
  if (!model) {
    console.error('[tourHelpers] Gemini model not initialized');
    throw new Error('Tour generation service is unavailable. Please try again later.');
  }

  const languageInstruction = language === 'hebrew'
    ? 'Generate all tour titles, abstracts, themes, and stop names in HEBREW (עברית).'
    : 'Generate all tour titles, abstracts, themes, and stop names in ENGLISH.';

  const customizationInstruction = customization
    ? `User customization request: "${customization}". Please incorporate this preference into the tour themes and stop selection.`
    : '';

  // Minimum 2 stops per 30 minutes
  const minimumStops = (durationMinutes / 30) * 2;
  const sharedStops = (durationMinutes / 30);

  // Build system prompt based on streaming mode
  const responseFormatInstruction = streaming
    ? 'Respond strictly as a JSON array of tour objects (top-level array, not wrapped in an object).'
    : 'Respond strictly as JSON with a top-level "tours" array.';

  const systemPrompt = [
    'You are an experienced local tour guide who designs walking tours ',
    'that balance must-see highlights with moments of local discovery.',
    'Create walking tours using ONLY real places that exist in the list below.',
    'Given a starting point nearby points of interest, and context,',
    'generate 2 to 10 walking tours with clear and distinct themes.',
    'Ensure that at least one tour includes nearby must-see or iconic points of interest,',
    'when such places exist in the list below.',
    'Prioritize diversity between tours in both routes and points of interest.',
    'Design tours to be pleasant to walk and discovery-oriented.',
    'Avoid long, uneventful walks to the first stop when possible.',
    'If the first highlight is far away, either ensure it is truly worthwhile or include interesting micro-stops along the way.',
    `Include approximately ${minimumStops} stops per tour,`,
    `Tours must be meaningfully distinct: Any two tours may share at most ${sharedStops} points of interest, even in a different order. Exclude any tour that violates it.`,
    `The total tour should take approximately ${Math.round(durationMinutes * 0.8)} minutes.`,

    languageInstruction,
    customizationInstruction,
    responseFormatInstruction,
    //    'Each tour object must have: id, title, abstract, theme, estimatedTotalMinutes, stops.',
    //    'Each stop must have: name, latitude, longitude, dwellMinutes, walkMinutesFromPrevious.',
  ].join(' ');

  // Helper function to format POI as simple text
  const formatPoi = (poi, isFood = false) => {
    const lat = poi.latitude;
    const lon = poi.longitude;
    const types = Array.isArray(poi.types) && poi.types.length > 0 ? poi.types.join(', ') : 'general';
    const rating = poi.rating ? poi.rating.toFixed(1) : 'N/A';
    const foodMarker = isFood ? ' [FOOD]' : '';
    return `- ${poi.name} / ${lat} / ${lon} / ${types} / ${rating}${foodMarker}`;
  };

  // Merge regular POIs and food POIs into one list
  const allPois = [...(Array.isArray(pois) ? pois : [])];

  // For tours 2+ hours, add food POIs with [FOOD] marker
  // DISABLED FOR NOW
  //const shouldIncludeFood = durationMinutes >= 120 && Array.isArray(foodPois) && foodPois.length > 0;
  const shouldIncludeFood = false;

  if (shouldIncludeFood) {
    allPois.push(...foodPois.map(poi => ({ ...poi, _isFood: true })));
  }

  // Format all POIs as simple text list
  const poisText = allPois.length > 0
    ? allPois.map(poi => formatPoi(poi, poi._isFood)).join('\n')
    : 'No POIs available';

  // Format city context
  /*
  let cityContextText = '';
  if (cityData) {
    cityContextText = `City: ${city}\n${cityData.summary || ''}`;
    if (cityData.keyFacts && cityData.keyFacts.length > 0) {
      cityContextText += '\nKey Facts:\n' + cityData.keyFacts.map(f => `- ${f}`).join('\n');
    }
  }

  // Format neighborhood context
  let neighborhoodContextText = '';
  if (neighborhoodData) {
    neighborhoodContextText = `Neighborhood: ${neighborhood}\n${neighborhoodData.summary || ''}`;
    if (neighborhoodData.keyFacts && neighborhoodData.keyFacts.length > 0) {
      neighborhoodContextText += '\nKey Facts:\n' + neighborhoodData.keyFacts.map(f => `- ${f}`).join('\n');
    }
  }
    */

  // Build input array with simplified format
  const inputParts = [
    systemPrompt,
    '',
    `Starting Location: ${latitude}, ${longitude}`,
    // `Duration: ${durationMinutes} minutes`,
    `Language: ${language || 'english'}`,
  ];

  if (customization && customization.trim().length > 0) {
    inputParts.push(`Customization: ${customization}`);
  }

  inputParts.push('');

  if (cityContextText) {
    inputParts.push(cityContextText);
    inputParts.push('');
  }

  if (neighborhoodContextText) {
    inputParts.push(neighborhoodContextText);
    inputParts.push('');
  }

  inputParts.push('=== AVAILABLE POINTS OF INTEREST ===');
  inputParts.push('Format: NAME / LATITUDE / LONGITUDE / TYPES / RATING');

  if (shouldIncludeFood) {
    inputParts.push('Note: POIs marked with [FOOD] are food establishments. For tours 2+ hours, include at least one highly-rated [FOOD] POI.');
  }

  inputParts.push('');
  inputParts.push(poisText);
  inputParts.push('');

  const prompt = inputParts.join('\n');

  debugLog('generateToursWithGemini: invoking model with payload', {
    latitude,
    longitude,
    durationMinutes,
    city,
    neighborhood,
    poiCount: allPois.length,
    streaming,
  });

  // Check for cancellation before expensive Gemini call
  await checkCancellation(sessionId, redisClient, 'generateToursWithGemini');

  // STREAMING MODE
  if (streaming) {
    console.log('[tourHelpers] 🌊 Starting streaming tour generation...');

    // Wrap streaming call with traceable for LangSmith observability
    const generateToursStreamingTraceable = traceable(
      async function* (promptText) {
        // Use streaming with structured output
        const streamResult = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: tourGenerationSchema, // Now uses the same unified schema
          },
        });

        // Create async generator for text chunks
        async function* textChunks() {
          for await (const chunk of streamResult.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
              yield chunkText;
            }
          }
        }

        // Extract and yield tours as they become complete
        for await (const tour of extractToursFromStream(textChunks())) {
          yield tour;
        }
      },
      {
        name: 'generate_tours_with_gemini_streaming',
        run_type: 'llm',
        metadata: {
          model: GEMINI_MODEL,
          latitude,
          longitude,
          durationMinutes,
          city,
          neighborhood,
          poiCount: allPois.length,
          language,
          streaming: true,
        },
      }
    );

    // Return an async generator that yields tours as they're streamed
    return (async function* () {
      try {
        for await (const tour of generateToursStreamingTraceable(prompt)) {
          yield tour;
        }
      } catch (err) {
        console.error('[tourHelpers] ❌ Streaming failed:', err);
        debugLog('generateToursWithGemini (streaming): error', err?.message || err);
        // Yield fallback tours
        const fallbackTours = fallback();
        for (const tour of fallbackTours) {
          yield tour;
        }
      }
    })();
  }

  // NON-STREAMING MODE (original implementation)
  // Wrap Gemini call with traceable for LangSmith observability
  const generateToursTraceable = traceable(
    async (promptText) => {
      // Use structured output with JSON schema
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: tourGenerationSchema, // Now uses the unified schema
        },
      });

      const response = result.response;
      const text = response.text();

      debugLog('generateToursWithGemini: structured output response length', text.length);
      debugLog('generateToursWithGemini: structured output preview:', text.substring(0, 500));

      return text;
    },
    {
      name: 'generate_tours_with_gemini',
      run_type: 'llm',
      metadata: {
        model: GEMINI_MODEL,
        latitude,
        longitude,
        durationMinutes,
        city,
        neighborhood,
        poiCount: allPois.length,
        language,
        streaming: false,
      },
    }
  );

  try {
    // Race the Gemini call against periodic cancellation checks
    // This allows us to interrupt even during the Gemini API call
    const geminiCallPromise = generateToursTraceable(prompt);

    // Create a cancellation checker that polls every 500ms
    const cancellationPromise = new Promise((_, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          await checkCancellation(sessionId, redisClient, 'generateToursWithGemini');
        } catch (err) {
          clearInterval(checkInterval);
          reject(err);
        }
      }, 500);

      // Clean up interval when Gemini call completes
      geminiCallPromise.finally(() => clearInterval(checkInterval));
    });

    const text = await Promise.race([geminiCallPromise, cancellationPromise]);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.warn('[tourHelpers] Failed to parse structured output JSON; falling back.', err);
      debugLog('generateToursWithGemini: JSON.parse failed', err?.message || err);
      return fallback();
    }

    console.log('[tourHelpers] generateToursWithGemini: parsed array length:', parsed.length);
    const tours = Array.isArray(parsed) ? parsed : [];
    console.log('[tourHelpers] generateToursWithGemini: tours array length:', tours.length);
    debugLog('generateToursWithGemini: parsed tours count', tours.length);

    if (!tours.length) {
      return fallback();
    }

    return tours;
  } catch (err) {
    console.warn('[tourHelpers] Gemini request failed; falling back to heuristics.', err);
    debugLog('generateToursWithGemini: request threw, using fallback', err?.message || err);
    return fallback();
  }
}



/**
 * Get walking directions from Google Maps Directions API
 */
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

async function safeFetch(url, options) {
  if (typeof fetch === 'undefined') {
    throw new Error('Global fetch is not available. Please use Node 18+ or polyfill fetch.');
  }
  return fetch(url, options);
}

export const getWalkingDirections = traceable(async (origin, destination, waypoints = null) => {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  if (waypoints) url.searchParams.set('waypoints', waypoints);
  url.searchParams.set('mode', 'walking');
  url.searchParams.set('key', GOOGLE_MAPS_API_KEY);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await safeFetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HearAndThere/1.0'
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Directions API returned ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}, { name: 'getWalkingDirections', run_type: 'tool' });

/**
 * Validate walking times for a single tour using Google Maps Directions API
 * @param {Object} tour - Tour object to validate
 * @param {number} startLatitude - Starting latitude
 * @param {number} startLongitude - Starting longitude
 * @returns {Promise<Object>} Validated tour with updated walking times
 */
export async function validateSingleTour(tour, startLatitude, startLongitude) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[tourHelpers] Cannot validate walking times - missing API key');
    return tour;
  }

  if (!Array.isArray(tour.stops) || tour.stops.length < 1) {
    return tour;
  }

  try {
    // Include the user's starting position as the origin
    const origin = `${startLatitude},${startLongitude}`;
    const destination = `${tour.stops[tour.stops.length - 1].latitude},${tour.stops[tour.stops.length - 1].longitude}`;

    // Build waypoints including ALL tour stops except the last one
    let waypoints = null;
    if (tour.stops.length > 1) {
      const waypointCoords = tour.stops.slice(0, -1).map(stop => `${stop.latitude},${stop.longitude}`);
      waypoints = waypointCoords.join('|');
    }

    console.log('[tourHelpers] Validating walking times for tour:', tour.id);

    const data = await getWalkingDirections(origin, destination, waypoints);
    if (data.status !== 'OK' || !data.routes || data.routes.length === 0) {
      console.warn('[tourHelpers] No valid route found for tour', tour.id, 'API status:', data.status);
      return tour;
    }

    const route = data.routes[0];
    const legs = route.legs || [];

    // Now we should have legs.length === tour.stops.length (including start->first POI)
    if (legs.length !== tour.stops.length) {
      console.warn('[tourHelpers] Leg count mismatch for tour', tour.id, 'expected:', tour.stops.length, 'got:', legs.length);
      return tour;
    }

    // Update each stop with actual walking time and directions from Google Maps
    const updatedStops = tour.stops.map((stop, i) => {
      const leg = legs[i];
      const actualWalkMinutes = leg.duration?.value ? Math.ceil(leg.duration.value / 60) : stop.walkMinutesFromPrevious;

      // Extract walking directions from the leg
      const walkingDirections = leg.steps ? {
        distance: leg.distance?.text || '',
        duration: leg.duration?.text || '',
        steps: leg.steps.map(step => ({
          instruction: step.html_instructions || step.instructions || '',
          distance: step.distance?.text || '',
          duration: step.duration?.text || ''
        }))
      } : undefined;

      return {
        ...stop,
        walkMinutesFromPrevious: actualWalkMinutes,
        walkingDirections
      };
    });

    // Recalculate total tour duration
    const totalWalkMinutes = updatedStops.reduce((sum, stop) => sum + (stop.walkMinutesFromPrevious || 0), 0);
    const totalDwellMinutes = updatedStops.reduce((sum, stop) => sum + (stop.dwellMinutes || 0), 0);
    const estimatedTotalMinutes = totalWalkMinutes + totalDwellMinutes;

    console.log(`[tourHelpers] ✅ Validated tour "${tour.title}": ${estimatedTotalMinutes} min (walk: ${totalWalkMinutes}, dwell: ${totalDwellMinutes})`);

    return {
      ...tour,
      stops: updatedStops,
      estimatedTotalMinutes
    };
  } catch (err) {
    console.error('[tourHelpers] Error validating tour', tour.id, err);
    return tour;
  }
}



