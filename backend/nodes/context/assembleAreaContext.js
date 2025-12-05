/**
 * Assemble Area Context Node
 * 
 * LangGraph node that assembles all area context (city, neighborhood, POIs, summaries)
 * into a single areaContext object for tour generation.
 */

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[assembleAreaContext]', ...args);
  }
}

/**
 * Create the assembleAreaContext node
 * 
 * This node assembles all the collected area context (city, neighborhood, POIs, summaries)
 * into a single areaContext object that will be used for tour generation.
 * 
 * @returns {Function} LangGraph node function
 */
export function createAssembleAreaContextNode() {
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

      const msg = {
        role: 'assistant',
        content: `Assembled area context with ${pois.length} POIs for ${city || 'area'}`
      };

      return {
        messages: [...messages, msg],
        areaContext
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

