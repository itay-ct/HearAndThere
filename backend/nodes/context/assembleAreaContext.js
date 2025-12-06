/**
 * Assemble Area Context Node
 *
 * LangGraph node that assembles all area context (city, neighborhood, POIs, summaries)
 * into a single areaContext object for tour generation.
 */

import { traceable } from "langsmith/traceable";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

let geminiFlashLiteModelPromise;
async function getGeminiFlashLiteModel() {
  if (!GEMINI_API_KEY) {
    console.warn('[assembleAreaContext] GEMINI_API_KEY is not set');
    return null;
  }

  if (!geminiFlashLiteModelPromise) {
    geminiFlashLiteModelPromise = import('@google/generative-ai')
      .then((mod) => {
        const { GoogleGenerativeAI } = mod;
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        return genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
      })
      .catch((err) => {
        console.error('[assembleAreaContext] Failed to load Gemini Flash Lite model:', err);
        return null;
      });
  }

  return geminiFlashLiteModelPromise;
}

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[assembleAreaContext]', ...args);
  }
}

/**
 * Generate interesting messages about POIs using Gemini Flash Lite
 * @param {Array} pois - Array of POI objects
 * @returns {Promise<Array>} Array of {icon, message} objects
 */
async function generateInterestingMessages(pois) {
  if (!pois || pois.length === 0) {
    return [];
  }

  const model = await getGeminiFlashLiteModel();
  if (!model) {
    console.warn('[assembleAreaContext] Gemini Flash Lite model not available, skipping message generation');
    return [];
  }

  try {
    // Create a simple list of POI names and types for the prompt
    const poiList = pois.map(poi => {
      const types = (poi.types || [])
        .filter(t => t !== 'point_of_interest' && t !== 'establishment')
        .join(', ');
      return `${poi.name} (${types || 'general'})`;
    }).join('\n');

    const prompt = `Generate 7 interesting aggregative short 1-sentences about this places list (around 8 words). These should entertain the user while he waits for tours to generate. Aggregate them by their types and specify how many places, such as "found 7 great local restaurants around you". Answer ONLY with the 7 lines. for each line add 1 unique icon from this list only
[utensils, pizza, ice-cream, coffee, cup-soda, beer, wine, egg-fried, drumstick, salad, cake, sandwich, egg, tree, trees, flower, mountain, sprout, leaf, tent, shopping-bag, shopping-cart, store, building, building-2, warehouse, factory, film, film-reel, clapperboard, tv, music, ticket, map-pin, map-pinned, pin, pointer, navigation, navigation-2, locate, locate-fixed, flag, flag-triangle-left, flag-triangle-right, camera, camera-off, binoculars, landmark, museum, hotel]
output the icon name and then colon and then the sentence (sentence ONLY text characters, no icons).
List of places and their types:
${poiList}`;

    console.log('[assembleAreaContext] Generating interesting messages with Gemini Flash Lite...');

    // Wrap Gemini call with traceable for LangSmith observability
    const generateMessagesTraceable = traceable(
      async (promptText) => {
        const result = await model.generateContent(promptText);
        const response = result.response;
        const text = response.text();
        return text;
      },
      { name: 'generate_interesting_messages', run_type: 'llm' }
    );

    const text = await generateMessagesTraceable(prompt);

    console.log('[assembleAreaContext] Generated messages:', text);

    const defaultIcon = 'map-pin-check-inside';

    // Parse the response - each line should be "icon: message"
    const lines = text.split('\n').filter(line => line.trim() && line.includes(':'));
    const messages = lines.slice(0, 7).map(line => {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) return null;

      let icon = line.substring(0, colonIndex).trim().toLowerCase();
      let message = line.substring(colonIndex + 1).trim();

      // Validate icon format (should be kebab-case, alphanumeric + hyphens only)
      // If invalid format, use default icon
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(icon)) {
        console.warn(`[assembleAreaContext] Invalid icon format "${icon}", using default "${defaultIcon}"`);
        icon = defaultIcon;
      }

      // Clean message - remove emojis and special characters, keep only text
      // Keep only letters, numbers, punctuation, and spaces
      message = message.replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, '');

      // Normalize whitespace
      message = message.replace(/\s+/g, ' ').trim();

      if (!message) return null;

      return { icon, message };
    }).filter(Boolean);

    console.log('[assembleAreaContext] Parsed messages:', messages);
    return messages;
  } catch (err) {
    console.error('[assembleAreaContext] Failed to generate interesting messages:', err);
    return [];
  }
}

/**
 * Create the assembleAreaContext node
 *
 * This node assembles all the collected area context (city, neighborhood, POIs, summaries)
 * into a single areaContext object that will be used for tour generation.
 *
 * @param {Object} config - Node configuration
 * @param {string} config.sessionId - Session ID for saving progress
 * @param {Object} config.redisClient - Redis client for saving progress
 * @returns {Function} LangGraph node function
 */
export function createAssembleAreaContextNode({ sessionId, redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const country = state.country || null;
    const city = state.city || null;
    const neighborhood = state.neighborhood || null;
    const pois = state.pois || [];
    const cityData = state.cityData || { summary: null, keyFacts: null };
    const neighborhoodData = state.neighborhoodData || { summary: null, keyFacts: null };

    try {
      console.log('[assembleAreaContext] Assembling area context...');
      debugLog('Assembling context with', {
        country,
        city,
        neighborhood,
        poiCount: pois.length,
        hasCitySummary: !!cityData.summary,
        hasNeighborhoodSummary: !!neighborhoodData.summary
      });

      // Generate interesting messages in parallel (don't wait for it)
      const interestingMessagesPromise = generateInterestingMessages(pois);

      const areaContext = {
        country: country || null,
        city: city || null,
        neighborhood: neighborhood || null,
        pois: pois,
        cityData: {
          summary: cityData.summary,
          keyFacts: cityData.keyFacts,
        },
        neighborhoodData: {
          summary: neighborhoodData.summary,
          keyFacts: neighborhoodData.keyFacts,
        },
      };

      console.log('[assembleAreaContext] Area context assembled successfully');

      // Wait for interesting messages to complete
      const interestingMessages = await interestingMessagesPromise;

      // Save interesting messages to Redis immediately so frontend can start showing rotating messages
      if (sessionId && redisClient && interestingMessages.length > 0) {
        try {
          const key = `session:${sessionId}`;
          await redisClient.hSet(key, {
            interestingMessages: JSON.stringify(interestingMessages)
          });
          console.log('[assembleAreaContext] ✅ Saved interesting messages to Redis:', interestingMessages);
        } catch (err) {
          console.error('[assembleAreaContext] ❌ Failed to save interesting messages to Redis:', err);
        }
      }

      const msg = {
        role: 'assistant',
        content: `Assembled area context with ${pois.length} POIs for ${city || 'area'}`
      };

      return {
        messages: [...messages, msg],
        areaContext,
        interestingMessages // Add to state for session storage
      };
    } catch (err) {
      console.error('[assembleAreaContext] Failed to assemble area context:', err);
      
      const errorMsg = {
        role: 'assistant',
        content: 'Failed to assemble area context. Using minimal context.'
      };

      return {
        messages: [...messages, errorMsg],
        areaContext: {
          country: null,
          city: null,
          neighborhood: null,
          pois: [],
          cityData: { summary: null, keyFacts: null },
          neighborhoodData: { summary: null, keyFacts: null }
        }
      };
    }
  };
}

