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
 * This node performs reverse geocoding using Google Maps Geocoding API
 * to convert coordinates into city and neighborhood names.
 * 
 * @param {Object} config - Node configuration
 * @param {number} config.latitude - Starting latitude
 * @param {number} config.longitude - Starting longitude
 * @returns {Function} LangGraph node function
 */
export function createReverseGeocodeNode({ latitude, longitude }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];

    try {
      console.log('[reverseGeocodeNode] Performing reverse geocoding...');
      debugLog('Reverse geocoding for', { latitude, longitude });

      // Perform reverse geocoding
      const { city, neighborhood } = await reverseGeocode(latitude, longitude);

      console.log('[reverseGeocodeNode] Reverse geocoding complete:', { city, neighborhood });

      const msg = {
        role: 'assistant',
        content: `Identified location: ${neighborhood ? `${neighborhood}, ` : ''}${city || 'Unknown'}`
      };

      return {
        messages: [...messages, msg],
        city,
        neighborhood
      };
    } catch (err) {
      console.error('[reverseGeocodeNode] Failed to perform reverse geocoding:', err);
      
      const errorMsg = {
        role: 'assistant',
        content: 'Failed to identify location. Proceeding without location context.'
      };

      return {
        messages: [...messages, errorMsg],
        city: null,
        neighborhood: null
      };
    }
  };
}

