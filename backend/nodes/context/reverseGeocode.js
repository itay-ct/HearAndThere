/**
 * Reverse Geocode Node
 * 
 * LangGraph node that performs reverse geocoding to get city and neighborhood from coordinates.
 */

import { reverseGeocode } from '../../utils/geocodingHelpers.js';

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[reverseGeocodeNode]', ...args);
  }
}

/**
 * Create the reverseGeocode node
 *
 * This node performs reverse geocoding using LocationIQ (with Google Maps fallback)
 * to convert coordinates into city and neighborhood names.
 * If city/neighborhood are already provided in state, skips reverse geocoding.
 *
 * @param {Object} config - Node configuration
 * @param {number} config.latitude - Starting latitude
 * @param {number} config.longitude - Starting longitude
 * @param {Object} config.redisClient - Redis client for proactive summary caching
 * @returns {Function} LangGraph node function
 */
export function createReverseGeocodeNode({ latitude, longitude, redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const existingCountry = state.country || null;
    const existingCity = state.city || null;
    const existingNeighborhood = state.neighborhood || null;

    // Skip reverse geocoding if city and neighborhood are already provided
    if (existingCity && existingNeighborhood) {
      console.log('[reverseGeocodeNode] City and neighborhood already provided, skipping reverse geocoding');
      debugLog('Using provided location:', { country: existingCountry, city: existingCity, neighborhood: existingNeighborhood });

      const msg = {
        role: 'assistant',
        content: `Using provided location: ${existingNeighborhood}, ${existingCity}${existingCountry ? ` (${existingCountry})` : ''}`
      };

      return {
        messages: [...messages, msg],
        country: existingCountry,  // ✅ FIX: Preserve existing country instead of setting to null
        city: existingCity,
        neighborhood: existingNeighborhood
      };
    }

    try {
      console.log('[reverseGeocodeNode] Performing reverse geocoding...');
      debugLog('Reverse geocoding for', { latitude, longitude });

      // Perform reverse geocoding (with proactive summary caching)
      const { country, city, neighborhood } = await reverseGeocode(latitude, longitude, redisClient);

      // Use provided values if available, otherwise use geocoded values
      const finalCountry = country;
      const finalCity = existingCity || city;
      const finalNeighborhood = existingNeighborhood || neighborhood;

      console.log('[reverseGeocodeNode] Reverse geocoding complete:', { country: finalCountry, city: finalCity, neighborhood: finalNeighborhood });

      const msg = {
        role: 'assistant',
        content: `Identified location: ${finalNeighborhood ? `${finalNeighborhood}, ` : ''}${finalCity || 'Unknown'}${finalCountry ? ` (${finalCountry})` : ''}`
      };

      return {
        messages: [...messages, msg],
        country: finalCountry,
        city: finalCity,
        neighborhood: finalNeighborhood
      };
    } catch (err) {
      console.error('[reverseGeocodeNode] Failed to perform reverse geocoding:', err);

      const errorMsg = {
        role: 'assistant',
        content: 'Failed to identify location. Proceeding without location context.'
      };

      return {
        messages: [...messages, errorMsg],
        country: null,
        city: existingCity,
        neighborhood: existingNeighborhood
      };
    }
  };
}

