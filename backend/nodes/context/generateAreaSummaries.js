/**
 * Generate Area Summaries Node
 * 
 * LangGraph node that generates city and neighborhood summaries using Gemini LLM.
 */

import { generateCitySummary, generateNeighborhoodSummary } from '../../utils/geocodingHelpers.js';

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
 * 
 * @returns {Function} LangGraph node function
 */
export function createGenerateAreaSummariesNode() {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const city = state.city || null;
    const neighborhood = state.neighborhood || null;

    try {
      console.log('[generateAreaSummaries] Generating area summaries...');
      debugLog('Generating summaries for', { city, neighborhood });

      // Generate city and neighborhood summaries in parallel
      const [cityData, neighborhoodData] = await Promise.all([
        generateCitySummary(city),
        generateNeighborhoodSummary(neighborhood, city),
      ]);

      console.log('[generateAreaSummaries] Area summaries generated');

      const msg = {
        role: 'assistant',
        content: `Generated summaries for ${city || 'area'}${neighborhood ? ` (${neighborhood})` : ''}`
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

