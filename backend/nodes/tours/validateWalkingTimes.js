/**
 * Validate Walking Times Node
 * 
 * LangGraph node that validates and updates walking times using Google Maps Directions API.
 */

import { validateWalkingTimes } from '../../utils/tourHelpers.js';

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[validateWalkingTimesNode]', ...args);
  }
}

/**
 * Create the validateWalkingTimes node
 * 
 * This node validates walking times for all candidate tours using Google Maps Directions API.
 * It replaces LLM-estimated walking times with actual Google Maps data and filters out tours
 * that deviate by more than 30 minutes from the requested duration.
 * 
 * @param {Object} config - Node configuration
 * @param {number} config.latitude - Starting latitude
 * @param {number} config.longitude - Starting longitude
 * @param {number} config.durationMinutes - Requested tour duration in minutes
 * @param {Object} config.redisClient - Redis client instance
 * @returns {Function} LangGraph node function
 */
export function createValidateWalkingTimesNode({ latitude, longitude, durationMinutes, redisClient }) {
  return async (state) => {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const tours = state.candidateTours || [];

    if (!tours.length) {
      console.warn('[validateWalkingTimesNode] No tours to validate walking times for');
      return { messages, finalTours: [] };
    }

    try {
      console.log('[validateWalkingTimesNode] Validating', tours.length, 'tours...');
      debugLog('Validating tours with Google Maps Directions API');

      // Validate walking times using Google Maps Directions API
      const validatedTours = await validateWalkingTimes(tours, latitude, longitude, redisClient);

      console.log('[validateWalkingTimesNode] Validated', validatedTours.length, 'tours');

      // Filter tours that deviate by more than 30 minutes from requested duration
      const filteredTours = validatedTours.filter(tour => {
        const deviation = Math.abs(tour.estimatedTotalMinutes - durationMinutes);
        const withinThreshold = deviation <= 30;

        if (!withinThreshold) {
          console.log(`[validateWalkingTimesNode] Filtering out tour "${tour.title}" - deviation: ${deviation} min (requested: ${durationMinutes}, actual: ${tour.estimatedTotalMinutes})`);
        }

        return withinThreshold;
      });

      console.log(`[validateWalkingTimesNode] After 30-min threshold filter: ${filteredTours.length}/${validatedTours.length} tours remain`);

      const msg = {
        role: 'system',
        content: filteredTours.length > 0
          ? `Validated walking times for ${validatedTours.length} tours, ${filteredTours.length} within 30-min threshold.`
          : `Validated ${validatedTours.length} tours but none fit within 30 minutes of requested ${durationMinutes} min duration.`,
      };

      return {
        messages: [...messages, msg],
        finalTours: filteredTours
      };
    } catch (err) {
      console.error('[validateWalkingTimesNode] Failed to validate walking times:', err);
      
      const errorMsg = {
        role: 'system',
        content: 'Failed to validate walking times. Using unvalidated tours.'
      };

      return {
        messages: [...messages, errorMsg],
        finalTours: tours // Return unvalidated tours as fallback
      };
    }
  };
}

