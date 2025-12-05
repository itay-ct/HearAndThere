/**
 * Preload Location Summaries Node
 * 
 * LangGraph node that reverse geocodes all POIs in the tour and preloads
 * city/neighborhood summaries into memory before script generation.
 * 
 * This ensures:
 * 1. All location data is fetched once upfront (not during parallel script generation)
 * 2. Summaries are loaded from cache when available
 * 3. New summaries are generated and cached only when needed
 * 4. Script generation nodes can access summaries from memory without generating new ones
 */

import { reverseGeocode } from '../../utils/geocodingHelpers.js';
import { generateCitySummary, generateNeighborhoodSummary } from '../../utils/geocodingHelpers.js';
import { cachePlaceInRedis } from '../../utils/poiHelpers.js';

const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[preloadLocationSummaries]', ...args);
  }
}

/**
 * Create the preloadLocationSummaries node
 * 
 * This node:
 * 1. Extracts all unique POIs from the tour
 * 2. For each POI, checks if it has country/city/neighborhood cached
 * 3. If not, performs reverse geocoding and updates the POI cache
 * 4. Loads all unique city/neighborhood summaries from cache (or generates if missing)
 * 5. Stores summaries in a locationSummaries map for script generation to use
 * 
 * @param {Object} config - Node configuration
 * @param {Object} config.redisClient - Redis client instance
 * @returns {Function} LangGraph node function
 */
export function createPreloadLocationSummariesNode({ redisClient }) {
  return async (state) => {
    const { selectedTour } = state;
    const stops = selectedTour?.stops || [];

    if (stops.length === 0) {
      console.log('[preloadLocationSummaries] No stops in tour, skipping');
      return { locationSummaries: {} };
    }

    try {
      console.log(`[preloadLocationSummaries] Preloading location summaries for ${stops.length} stops...`);

      // Track unique locations (country:city:neighborhood combinations)
      const locationSet = new Set();
      const locationSummaries = {};
      const stopLocationMap = {}; // Map stop index to location key

      // Step 1: Reverse geocode all POIs and update cache
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];

        if (!stop.latitude || !stop.longitude) {
          console.warn(`[preloadLocationSummaries] Stop "${stop.name}" missing coordinates, skipping`);
          continue;
        }

        let country = stop.country || null;
        let city = stop.city || null;
        let neighborhood = stop.neighborhood || null;

        // If POI doesn't have location data, reverse geocode it
        if (!city && !neighborhood) {
          console.log(`[preloadLocationSummaries] Reverse geocoding "${stop.name}"...`);
          const geocodeResult = await reverseGeocode(stop.latitude, stop.longitude, redisClient);
          country = geocodeResult.country;
          city = geocodeResult.city;
          neighborhood = geocodeResult.neighborhood;

          debugLog('Reverse geocoded:', { name: stop.name, country, city, neighborhood });

          // Update the POI cache with location data
          if (redisClient && stop.id) {
            await cachePlaceInRedis(redisClient, {
              ...stop,
              country,
              city,
              neighborhood
            }).catch(err => {
              console.warn(`[preloadLocationSummaries] Failed to update POI cache for ${stop.id}:`, err.message);
            });
          }
        }

        // Track this location
        const locationKey = `${country || 'unknown'}:${city || 'unknown'}:${neighborhood || 'unknown'}`;
        locationSet.add(locationKey);

        // Map this stop index to its location key
        stopLocationMap[i] = locationKey;

        // Store location data for this stop
        if (!locationSummaries[locationKey]) {
          locationSummaries[locationKey] = {
            country,
            city,
            neighborhood,
            cityData: null,
            neighborhoodData: null
          };
        }
      }

      console.log(`[preloadLocationSummaries] Found ${locationSet.size} unique locations`);

      // Step 2: Load summaries for all unique locations
      const summaryPromises = [];
      for (const locationKey of locationSet) {
        const location = locationSummaries[locationKey];
        
        summaryPromises.push(
          (async () => {
            try {
              // Load city and neighborhood summaries in parallel
              const [cityData, neighborhoodData] = await Promise.all([
                generateCitySummary(location.city, location.country, redisClient),
                generateNeighborhoodSummary(location.neighborhood, location.city, location.country, redisClient)
              ]);

              location.cityData = cityData;
              location.neighborhoodData = neighborhoodData;

              debugLog('Loaded summaries for:', locationKey);
            } catch (err) {
              console.error(`[preloadLocationSummaries] Failed to load summaries for ${locationKey}:`, err.message);
              location.cityData = { summary: null, keyFacts: null };
              location.neighborhoodData = { summary: null, keyFacts: null };
            }
          })()
        );
      }

      await Promise.all(summaryPromises);

      console.log(`[preloadLocationSummaries] ✅ Preloaded summaries for ${locationSet.size} locations`);
      console.log(`[preloadLocationSummaries] Stop location map:`, JSON.stringify(stopLocationMap, null, 2));
      console.log(`[preloadLocationSummaries] Location summaries keys:`, Object.keys(locationSummaries));

      return {
        locationSummaries,
        stopLocationMap  // Map of stop index -> location key for lookup
      };

    } catch (err) {
      console.error('[preloadLocationSummaries] Failed to preload location summaries:', err);
      // Return empty summaries on error - script generation will use tour-level context
      return {
        locationSummaries: {},
        stopLocationMap: {}
      };
    }
  };
}

