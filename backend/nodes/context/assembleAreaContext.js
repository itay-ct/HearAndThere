/**
 * Assemble Area Context Node
 *
 * LangGraph node that assembles all area context (city, neighborhood, POIs, summaries)
 * into a single areaContext object for tour generation.
 */

import { traceable } from "langsmith/traceable";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INTERESTING_MESSAGES_MODEL = process.env.INTERESTING_MESSAGES_MODEL || 'gemini-2.5-flash-lite';
const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

const DEFAULT_ICON = 'map-pin-check-inside';
const ICON_INDEX_NAME = 'lucide_icon_index';

let embeddingModel = null;

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
        return genAI.getGenerativeModel({ model: INTERESTING_MESSAGES_MODEL });
      })
      .catch((err) => {
        console.error('[assembleAreaContext] Failed to load Gemini model for interesting messages:', err);
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
 * Search for the best matching Lucide icon using Redis vector search
 * @param {string} message - The message to find an icon for
 * @param {Object} redisClient - Redis client instance
 * @returns {Promise<string>} Icon name (kebab-case)
 */
async function searchBestIcon(message, redisClient) {
  if (!message || !message.trim()) {
    return DEFAULT_ICON;
  }

  if (!redisClient) {
    console.warn('[assembleAreaContext] No Redis client available for icon search');
    return DEFAULT_ICON;
  }

  try {
    // Lazy load embedding model
    if (!embeddingModel) {
      const { pipeline } = await import('@xenova/transformers');
      embeddingModel = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }

    // Generate embedding for the message
    const output = await embeddingModel(message, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data);
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // Search for nearest icon in Redis
    const searchResults = await redisClient.ft.search(
      ICON_INDEX_NAME,
      `*=>[KNN 1 @embedding $vector AS score]`,
      {
        PARAMS: { vector: embeddingBuffer },
        RETURN: ['name', 'score'],
        SORTBY: 'score',
        DIALECT: 2
      }
    );

    if (searchResults.total > 0 && searchResults.documents.length > 0) {
      const iconName = searchResults.documents[0].value.name;
      console.log(`[assembleAreaContext] Found icon "${iconName}" for message: "${message}"`);
      return iconName;
    }
  } catch (err) {
    console.error('[assembleAreaContext] Icon search failed:', err.message);
  }

  return DEFAULT_ICON;
}

/**
 * Generate interesting messages about POIs using Gemini Flash Lite
 * @param {Array} pois - Array of POI objects
 * @param {Object} redisClient - Redis client for icon search
 * @returns {Promise<Array>} Array of {icon, message} objects
 */
async function generateInterestingMessages(pois, redisClient) {
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

    const prompt = `Generate 7 interesting aggregative short 1-sentences about this places list (around 8 words). These should entertain the user while he waits for tours to generate. Aggregate them by their types and specify how many places, such as "found 7 great local restaurants around you". Answer ONLY with the 7 lines, one per line.
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

    // Parse the response - each line is a message
    const lines = text.split('\n').filter(line => line.trim());

    // Process messages in parallel to find best icons
    const messagesPromises = lines.slice(0, 7).map(async (line) => {
      // Clean message - remove emojis and special characters, keep only text
      // Keep only letters, numbers, punctuation, and spaces
      let message = line.replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, '');

      // Normalize whitespace
      message = message.replace(/\s+/g, ' ').trim();

      if (!message) return null;

      // Search for best matching icon using vector search
      const icon = await searchBestIcon(message, redisClient);

      console.log(`best icon: ${icon} for message: ${message}`);
      debugLog('best icon:', icon, 'for message:', message);
      
      return { icon, message };
    });

    const messages = (await Promise.all(messagesPromises)).filter(Boolean);

    console.log('[assembleAreaContext] Parsed messages with icons:', messages);
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
      const interestingMessagesPromise = generateInterestingMessages(pois, redisClient);

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

