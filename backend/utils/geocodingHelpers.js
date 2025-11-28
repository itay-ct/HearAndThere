/**
 * Geocoding Helper Functions
 * 
 * Functions for reverse geocoding and generating area summaries using
 * Google Maps Geocoding API and Gemini LLM.
 */

import { traceable } from 'langsmith/traceable';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
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
 * Reverse geocode coordinates to get city and neighborhood
 */
export const reverseGeocode = traceable(async (latitude, longitude) => {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[geocodingHelpers] GOOGLE_MAPS_API_KEY is not set; skipping reverse-geocoding.');
    debugLog('reverseGeocode: missing GOOGLE_MAPS_API_KEY');
    return { city: null, neighborhood: null };
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_MAPS_API_KEY}`;
  debugLog('reverseGeocode: requesting', url);
  const res = await safeFetch(url);
  if (!res.ok) {
    console.warn('[geocodingHelpers] Reverse geocoding failed with status', res.status);
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
}, { name: 'reverseGeocode', run_type: 'tool' });

/**
 * Generate city summary using Gemini LLM
 */
export async function generateCitySummary(city) {
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
    console.warn(`[geocodingHelpers] Failed to generate city summary for ${city}`, err);
  }
  
  return { summary: null, keyFacts: null };
}

/**
 * Generate neighborhood summary using Gemini LLM
 */
export async function generateNeighborhoodSummary(neighborhood, city) {
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
    console.warn(`[geocodingHelpers] Failed to generate neighborhood summary for ${location}`, err);
  }
  
  return { summary: null, keyFacts: null };
}

