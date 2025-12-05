/**
 * Tour Helper Functions
 * 
 * Functions for generating, filtering, and validating walking tours using
 * Gemini LLM and Google Maps Directions API.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[tourHelpers]', ...args);
  }
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
    console.warn('[tourHelpers] GEMINI_API_KEY is not set');
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
        console.warn('[tourHelpers] Failed to load @langchain/google-genai', err);
        return null;
      });
  }
  
  return geminiModelPromise;
}

/**
 * Generate heuristic tours from POIs (fallback when LLM is unavailable)
 */
export function heuristicToursFromPois({ latitude, longitude, durationMinutes, city, pois }) {
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

/**
 * Generate tours using Gemini LLM
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
  foodPois = []
}) {
  const fallback = () =>
    heuristicToursFromPois({ latitude, longitude, durationMinutes, city, pois });

  if (!GEMINI_API_KEY) {
    console.warn('[tourHelpers] GEMINI_API_KEY is not set; using heuristic tours instead.');
    debugLog('generateToursWithGemini: missing GEMINI_API_KEY, using fallback');
    return fallback();
  }

  const model = await getGeminiModel();
  if (!model) {
    console.warn('[tourHelpers] Gemini model not initialized; using heuristic tours instead.');
    debugLog('generateToursWithGemini: model not initialized, using fallback');
    return fallback();
  }

  const languageInstruction = language === 'hebrew'
    ? 'Generate all tour titles, abstracts, themes, and stop names in HEBREW (עברית).'
    : 'Generate all tour titles, abstracts, themes, and stop names in ENGLISH.';

  const customizationInstruction = customization
    ? `User customization request: "${customization}". Please incorporate this preference into the tour themes and stop selection.`
    : '';

  // Minimum 2 stops per 30 minutes
  const minimumStops = (durationMinutes / 30) * 2;

  const systemPrompt = [
    'You are a tour-planning assistant with access to real-time Google Maps data.',
    'Use Google Maps to find actual places, verify locations, and calculate real walking distances.',
    'Create walking tours using ONLY real places that exist on Google Maps.',
    'Verify each location exists before including it in a tour.',
    'Calculate accurate walking times between actual coordinates.',
    'Given a starting point, nearby points of interest, and context,',
    'propose between 1 to 10 candidate walking tours with clear themes.',
    'Make sure the tours are not similar in their points of interest,',
    'they should not repeat points of interests, even in different order, ',
    'they should have maximum 1 repetition of a point of interest, ',
    'otherwise remove the repetition from the candidate tours. ',
    'propose around 10 candidate walking tours with clear themes. ',
    `I expect a minimum of ${minimumStops} points of interests `,
    `IMPORTANT: Each tour MUST fit within ${durationMinutes} minutes total (including walking AND dwell time).`,
    'Be conservative with time estimates - it\'s better to have a shorter tour that fits comfortably than one that runs over.',
    `Target tours between ${Math.round(durationMinutes * 0.8)} and ${durationMinutes} minutes.`,
    languageInstruction,
    customizationInstruction,
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

  // Prepare food POI data for LLM (if available)
  const foodPoisForLLM = Array.isArray(foodPois) ? foodPois.map(poi => ({
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
    pois: poisForLLM,
    cityData,
    neighborhoodData,
    language: language || 'english',
  };

  // Add customization to payload only if it has a value
  if (customization && customization.trim().length > 0) {
    userPayload.customization = customization;
  }

  // Build input array with conditional food POI instruction
  const inputParts = [
    systemPrompt,
    '',
    'Here is the JSON input describing the user context:',
    JSON.stringify(userPayload),
    '',
  ];

  // For tours 2 hours and above, add food POI instruction and foodPois data
  if (durationMinutes >= 120 && foodPoisForLLM.length > 0) {
    inputParts.push(
      'IMPORTANT: Since this is a longer tour (2+ hours), please include at least one good food point of interest from the foodPois list provided below. Choose a highly-rated food establishment that fits naturally into the tour route.',
      '',
      'Available food points of interest:',
      JSON.stringify(foodPoisForLLM),
      ''
    );
  }

  inputParts.push(
    'Respond ONLY with valid JSON of the form:',
    '{ "tours": [ { "id": "...", "title": "...", "abstract": "...", "theme": "...", "estimatedTotalMinutes": 90, "stops": [ { "name": "...", "latitude": 0, "longitude": 0, "dwellMinutes": 10, "walkMinutesFromPrevious": 5 } ] } ] }'
  );

  const input = inputParts.join('\n');

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
    console.log('[tourHelpers] generateToursWithGemini: raw response preview:', text.substring(0, 500));

    const jsonText = extractJsonFromText(text);
    if (!jsonText) {
      console.warn('[tourHelpers] Gemini response did not contain JSON; falling back to heuristics.');
      debugLog('generateToursWithGemini: no JSON block found, using fallback');
      return fallback();
    }

    console.log('[tourHelpers] generateToursWithGemini: extracted JSON length:', jsonText.length);
    console.log('[tourHelpers] generateToursWithGemini: JSON preview:', jsonText.substring(0, 500));

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      console.warn('[tourHelpers] Failed to parse Gemini JSON; falling back.', err);
      debugLog('generateToursWithGemini: JSON.parse failed', err?.message || err);
      return fallback();
    }

    console.log('[tourHelpers] generateToursWithGemini: parsed object keys:', Object.keys(parsed));
    const tours = Array.isArray(parsed.tours) ? parsed.tours : [];
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
 * Filter and rank tours by duration and variety
 */
export function filterAndRankTours(tours, durationMinutes) {
  if (!Array.isArray(tours)) return [];

  console.log('[tourHelpers] filterAndRankTours: input tours count', tours.length);

  const target = durationMinutes;
  const scored = tours.map((tour, index) => {
    const total = typeof tour.estimatedTotalMinutes === 'number' ? tour.estimatedTotalMinutes : target;
    const durationPenalty = Math.abs(total - target);
    const stopCount = Array.isArray(tour.stops) ? tour.stops.length : 0;
    const varietyBonus = stopCount;
    const score = -durationPenalty + 0.5 * varietyBonus;

    console.log('[tourHelpers] filterAndRankTours: tour scoring', {
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

  console.log('[tourHelpers] filterAndRankTours: final tours count', topTours.length);
  console.log('[tourHelpers] filterAndRankTours: final tour IDs', topTours.map(t => t.id));

  return topTours;
}

/**
 * Get walking directions from Google Maps Directions API
 */
import { traceable } from 'langsmith/traceable';

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
 * Validate walking times using Google Maps Directions API
 */
export async function validateWalkingTimes(tours, startLatitude, startLongitude, redisClient = null) {
  if (!GOOGLE_MAPS_API_KEY || !Array.isArray(tours) || tours.length === 0) {
    console.warn('[tourHelpers] Cannot validate walking times - missing API key or no tours');
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
      let waypoints = null;
      if (tour.stops.length > 1) {
        const waypointCoords = tour.stops.slice(0, -1).map(stop => `${stop.latitude},${stop.longitude}`);
        waypoints = waypointCoords.join('|');
      }

      console.log('[tourHelpers] Validating walking times for tour:', tour.id);

      const data = await getWalkingDirections(origin, destination, waypoints);
      if (data.status !== 'OK' || !data.routes || data.routes.length === 0) {
        console.warn('[tourHelpers] No valid route found for tour', tour.id, 'API status:', data.status);
        validatedTours.push(tour);
        continue;
      }

      const route = data.routes[0];
      const legs = route.legs || [];

      // Now we should have legs.length === tour.stops.length (including start->first POI)
      if (legs.length !== tour.stops.length) {
        console.warn('[tourHelpers] Leg count mismatch for tour', tour.id, 'expected:', tour.stops.length, 'got:', legs.length);
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

        // Get Google Maps walking time and directions for this leg
        const leg = legs[index];
        const googleWalkingSeconds = leg.duration?.value || 0;
        const googleWalkingMinutes = Math.ceil(googleWalkingSeconds / 60);
        const distanceMeters = leg.distance?.value || 0;

        updatedStop.walkMinutesFromPrevious = googleWalkingMinutes;
        updatedStop.distanceMeters = distanceMeters;

        // Extract walking directions with street names
        if (leg.steps && leg.steps.length > 0) {
          // Store walking directions as an object with distance, duration, and steps array
          updatedStop.walkingDirections = {
            distance: leg.distance?.text || '',
            duration: leg.duration?.text || '',
            steps: leg.steps.map(step => ({
              instruction: step.html_instructions || '', // Keep HTML for proper display
              distance: step.distance?.text || '',
              duration: step.duration?.text || '',
            }))
          };

          // Extract street names from the steps
          const streetNames = leg.steps
            .map(step => {
              const instruction = step.html_instructions || '';
              // Try to extract street names from instructions
              const match = instruction.match(/on\s+<b>([^<]+)<\/b>/i) ||
                           instruction.match(/onto\s+<b>([^<]+)<\/b>/i) ||
                           instruction.match(/toward\s+<b>([^<]+)<\/b>/i);
              return match ? match[1] : null;
            })
            .filter(Boolean);

          updatedStop.streetNames = [...new Set(streetNames)]; // Remove duplicates
        }

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
      console.log('[tourHelpers] Walking time validation for tour', tour.id, {
        llmTotalWalkingMinutes,
        googleTotalWalkingMinutes,
        difference: googleTotalWalkingMinutes - llmTotalWalkingMinutes,
        llmTotalTourMinutes: tour.estimatedTotalMinutes,
        googleTotalTourMinutes: updatedTotalMinutes,
        tourTimeDifference: updatedTotalMinutes - tour.estimatedTotalMinutes
      });

      validatedTours.push(validatedTour);

    } catch (err) {
      console.error('[tourHelpers] Error validating walking times for tour', tour.id, err.message);
      // Always include the tour even if validation fails
      validatedTours.push(tour);
    }
  }

  return validatedTours;
}

