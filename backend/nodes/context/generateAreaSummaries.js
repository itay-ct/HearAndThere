/**
 * Generate Area Summaries Node
 * 
 * LangGraph node that generates city and neighborhood summaries using Gemini LLM.
 */

import { generateCitySummary, generateNeighborhoodSummary } from '../../utils/geocodingHelpers.js';
import { checkCancellation, getSessionIdFromState } from '../../utils/cancellationHelper.js';

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[generateAreaSummaries]', ...args);
  }
}

/**
 * Create the generateAreaSummaries node
 *
 * This node generates summaries and key facts for the city and neighborhood
 * using Gemini LLM. The summaries are generated in parallel for efficiency.
 * Checks cache first before generating new summaries.
 *
 * @param {Object} config - Node configuration
 * @param {Object} config.redisClient - Redis client instance for caching
 * @returns {Function} LangGraph node function
 */
export function createGenerateAreaSummariesNode({ redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const country = state.country || null;
    const city = state.city || null;
    const neighborhood = state.neighborhood || null;
    const sessionId = getSessionIdFromState(state);

    try {
      console.log('[generateAreaSummaries] Generating area summaries...');
      debugLog('Generating summaries for', { country, city, neighborhood });

      // Check for cancellation before expensive LLM operations
      await checkCancellation(sessionId, redisClient, 'generateAreaSummaries');

      // Generate city and neighborhood summaries in parallel (with caching)
      // Use hierarchical cache keys: country:city and country:city:neighborhood
      const [cityData, neighborhoodData] = await Promise.all([
        generateCitySummary(city, country, redisClient),
        generateNeighborhoodSummary(neighborhood, city, country, redisClient),
      ]);

      console.log('[generateAreaSummaries] Area summaries generated');

      const msg = {
        role: 'assistant',
        content: `Generated summaries for ${city || 'area'}${neighborhood ? ` (${neighborhood})` : ''}${country ? ` (${country})` : ''}`
      };

      return {
        messages: [...messages, msg],
        cityData,
        neighborhoodData
      };
    } catch (err) {
      console.error('[generateAreaSummaries] Failed to generate area summaries:', err);

      const errorMsg = {
        role: 'assistant',
        content: 'Failed to generate area summaries. Proceeding without summaries.'
      };

      return {
        messages: [...messages, errorMsg],
        cityData: { summary: null, keyFacts: null },
        neighborhoodData: { summary: null, keyFacts: null }
      };
    }
  };
}

