/**
 * Cancellation Helper
 * 
 * Shared utilities for checking and handling session cancellation across all nodes.
 */

/**
 * Check if a session has been cancelled
 * @param {string} sessionId - Session ID to check
 * @param {Object} redisClient - Redis client instance
 * @returns {Promise<boolean>} True if session is cancelled
 */
export async function isSessionCancelled(sessionId, redisClient) {
  if (!sessionId || !redisClient) {
    return false;
  }

  try {
    const key = `session:${sessionId}`;
    const cancelled = await redisClient.hGet(key, 'cancelled');
    return cancelled === 'true';
  } catch (err) {
    console.error('[cancellationHelper] Error checking cancellation status:', err);
    return false;
  }
}

/**
 * Check for cancellation and throw error if cancelled
 * Use this at the start of expensive operations (API calls, LLM calls, etc.)
 * 
 * @param {string} sessionId - Session ID to check
 * @param {Object} redisClient - Redis client instance
 * @param {string} nodeName - Name of the node checking (for logging)
 * @throws {Error} Throws 'CANCELLED' error if session is cancelled
 */
export async function checkCancellation(sessionId, redisClient, nodeName = 'unknown') {
  if (await isSessionCancelled(sessionId, redisClient)) {
    console.log(`[${nodeName}] ⚠️ Session cancelled, aborting operation`);
    throw new Error('CANCELLED');
  }
}

/**
 * Extract sessionId from state (handles both direct sessionId and state.sessionId)
 * @param {Object} state - LangGraph state object
 * @returns {string|null} Session ID or null
 */
export function getSessionIdFromState(state) {
  return state?.sessionId || null;
}

