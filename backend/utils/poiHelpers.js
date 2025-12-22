/**
 * POI Helper Functions
 *
 * Functions for fetching, caching, and querying Points of Interest (POIs)
 * from Google Maps API and Redis cache.
 */

import { traceable } from 'langsmith/traceable';
import { reverseGeocode, generateCitySummary, generateNeighborhoodSummary } from './geocodingHelpers.js';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const POI_INDEX_NAME = 'idx:pois';
const MAX_POIS_IN_TOURPLAN_CONTEXT = 60;
const MIN_SECONDARY_RATING = 3.5;
const TOUR_DEBUG = process.env.TOUR_DEBUG === '1' || process.env.TOUR_DEBUG === 'true';

function debugLog(...args) {
  if (TOUR_DEBUG) {
    console.log('[poiHelpers]', ...args);
  }
}

async function safeFetch(url, options) {
  if (typeof fetch === 'undefined') {
    throw new Error('Global fetch is not available. Please use Node 18+ or polyfill fetch.');
  }
  return fetch(url, options);
}

/**
 * Ensure RediSearch index exists for POIs
 */
export async function ensurePoiIndexExists(redisClient) {
  if (!redisClient) {
    console.warn('[poiHelpers] No Redis client available for index creation');
    return false;
  }

  try {
    // Check if index already exists
    try {
      await redisClient.ft.info(POI_INDEX_NAME);
      return true;
    } catch (err) {
      // Index doesn't exist, create it
      const errorMsg = err.message || '';
      if (errorMsg.includes('Unknown index name') || errorMsg.includes('no such index')) {
        console.log(`[poiHelpers] Creating RediSearch index '${POI_INDEX_NAME}'...`);

        await redisClient.ft.create(
          POI_INDEX_NAME,
          {
            '$.name': { type: 'TEXT', AS: 'name' },
            '$.types[*]': { type: 'TAG', AS: 'types' },
            '$.location': { type: 'GEO', AS: 'location' },
            '$.rating': { type: 'NUMERIC', AS: 'rating' },
            '$.primary': { type: 'TAG', AS: 'primary' }
          },
          {
            ON: 'JSON',
            PREFIX: 'poi_cache:'
          }
        );

        console.log(`[poiHelpers] ✅ RediSearch index '${POI_INDEX_NAME}' created successfully`);
        return true;
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('[poiHelpers] Failed to ensure POI index exists:', err);
    return false;
  }
}

/**
 * Cache a single place in Redis
 */
export async function cachePlaceInRedis(redisClient, place) {
  if (!redisClient || !place.id) return;

  const placeKey = `poi_cache:${place.id}`;

  try {
    // Prepare place document
    // Note: RediSearch GEO type requires "longitude,latitude" format as a string
    const placeDoc = {
      place_id: place.id,
      name: place.name,
      types: place.types || [],
      location: `${place.longitude},${place.latitude}`, // GEO format: "lon,lat"
      rating: place.rating,
      primary: place.primary !== undefined ? place.primary : true,
      // Location context fields (populated on-demand during audioguide generation)
      country: place.country || null,
      city: place.city || null,
      neighborhood: place.neighborhood || null
    };

    debugLog('Caching place:', {
      id: place.id,
      name: place.name,
      lat: place.latitude,
      lon: place.longitude,
      key: placeKey
    });

    // Upsert the place document (RediSearch will auto-index it)
    await redisClient.json.set(placeKey, '$', placeDoc);

    // Set TTL to 7 days
    await redisClient.expire(placeKey, 7 * 24 * 60 * 60); // 7 days

    debugLog('Successfully cached place', place.id);
  } catch (err) {
    console.error('[poiHelpers] Failed to cache place', place.id, err);
  }
}

/**
 * Search for places nearby using Google Places API
 */
export const searchPlacesNearby = traceable(async (latitude, longitude, radiusMeters, includedTypes, isPrimary = false) => {
  const url = 'https://places.googleapis.com/v1/places:searchNearby';
  
  const requestBody = {
    includedTypes,
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude, longitude },
        radius: radiusMeters
      }
    }
  };

  debugLog('searchPlacesNearby: requesting', { url, types: includedTypes.length });
  
  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.location,places.rating'
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    console.warn('[poiHelpers] Places search failed with status', res.status);
    debugLog('searchPlacesNearby: non-OK response', res.status);
    return [];
  }

  const data = await res.json();
  const places = Array.isArray(data.places) ? data.places : [];
  debugLog('searchPlacesNearby: got places count', places.length);

  return places
    .filter((place) => {
      // Filter out secondary POIs with rating below MIN_SECONDARY_RATING
      if (!isPrimary) {
        const rating = place.rating || null;
        if (rating === null || rating < MIN_SECONDARY_RATING) {
          const displayName = place.displayName?.text || 'Unknown Place';
          console.log(`[poiHelpers] Discarding secondary POI "${displayName}" with rating ${rating}`);
          return false;
        }
      }
      return true;
    })
    .map((place, index) => {
      const originalTypes = place.types || [];

      // Filter out generic types that don't add value
      let types = originalTypes.filter(t => t !== 'point_of_interest' && t !== 'establishment');

      return {
        id: place.id || `poi_${index + 1}`,
        name: place.displayName?.text || 'Unknown Place',
        latitude: place.location?.latitude || latitude,
        longitude: place.location?.longitude || longitude,
        types: types,
        rating: place.rating || null,
        primary: isPrimary, // Mark as primary or secondary
      };
    });
}, { name: 'searchPlacesNearby', run_type: 'tool' });

/**
 * Search for nearby POIs using Google Maps API and cache them
 */
export const searchNearbyPois = traceable(async (latitude, longitude, durationMinutes = 90, redisClient = null) => {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('[poiHelpers] GOOGLE_MAPS_API_KEY is not set; skipping POI search.');
    debugLog('searchNearbyPois: missing GOOGLE_MAPS_API_KEY');
    return [];
  }

  // Calculate radius based on duration
  const walkingTimeMinutes = durationMinutes * 0.4;
  const maxWalkingMeters = walkingTimeMinutes * 83;
  const calculatedRadius = Math.round(maxWalkingMeters / 2);
  const radiusMeters = Math.max(500, Math.min(3000, calculatedRadius));

  debugLog('searchNearbyPois: calculated radius', radiusMeters, 'meters for duration', durationMinutes, 'minutes');

  const primaryTypesGroup1 = [
    'historical_place', 'historical_landmark', 'monument', 'cultural_landmark', 'museum',
    'art_gallery', 'sculpture', 'performing_arts_theater', 'opera_house', 'philharmonic_hall',
    'concert_hall', 'cultural_center', 'community_center', 'library',
    'city_hall', 'courthouse', 'embassy', 'church', 'amusement_park',
    'hindu_temple', 'mosque', 'synagogue', 'market'
  ];

  const primaryTypesGroup2 = [
    'park', 'national_park', 'state_park', 'botanical_garden', 'garden',
    'plaza', 'visitor_center', 'beach', 'wildlife_park', 'wildlife_refuge',
    'zoo', 'aquarium', 'marina', 'hiking_area', 'observation_deck',
    'athletic_field', 'playground', 'dog_park', 'skateboard_park', 'picnic_ground',
    'campground', 'rv_park', 'tourist_attraction'
  ];

  const secondaryTypes = [
    'restaurant', 'cafe', 'coffee_shop', 'ice_cream_shop', 'bakery',
    'bar', 'pub', 'wine_bar', 'tea_house', 'fast_food_restaurant',
    'pizza_restaurant', 'hamburger_restaurant', 'seafood_restaurant', 'steak_house', 'sushi_restaurant',
    'breakfast_restaurant', 'brunch_restaurant', 'mexican_restaurant', 'indian_restaurant', 'chinese_restaurant',
    'japanese_restaurant', 'thai_restaurant', 'mediterranean_restaurant', 'middle_eastern_restaurant', 'turkish_restaurant',
    'greek_restaurant', 'italian_restaurant', 'spanish_restaurant', 'vegan_restaurant', 'vegetarian_restaurant',
    'bagel_shop', 'donut_shop', 'dessert_shop', 'dessert_restaurant', 'confectionery',
    'candy_store', 'acai_shop', 'juice_shop', 'cat_cafe', 'dog_cafe',
    'bar_and_grill', 'food_court', 'fine_dining_restaurant', 'shopping_mall', 'gift_shop',
    'spa', 'local_government_office', 'auditorium', 'movie_theater'
  ];

  const allResults = [];

  // Query primary types in 2 groups (20 results each) + secondary types (20 results)
  const [primaryResults1, primaryResults2, secondaryResults] = await Promise.all([
    searchPlacesNearby(latitude, longitude, radiusMeters, primaryTypesGroup1, true),
    searchPlacesNearby(latitude, longitude, radiusMeters, primaryTypesGroup2, true),
    searchPlacesNearby(latitude, longitude, radiusMeters, secondaryTypes, false)
  ]);

  allResults.push(...primaryResults1, ...primaryResults2, ...secondaryResults);

  // Remove duplicates by place_id (keep first occurrence which preserves primary flag)
  const uniqueResults = [];
  const seenIds = new Set();
  for (const place of allResults) {
    if (!seenIds.has(place.id)) {
      seenIds.add(place.id);
      uniqueResults.push(place);
    }
  }

  // Note: POI caching is now handled by the savePoiToCache node
  // This allows caching to happen asynchronously without blocking the user request

  console.log(`[poiHelpers] 📍 POI search results - Primary Group 1: ${primaryResults1.length}, Primary Group 2: ${primaryResults2.length}, Secondary: ${secondaryResults.length}, Total unique: ${uniqueResults.length}`);

  // Return all unique results (up to 60 from 3 API calls)
  // Don't limit here - let the caller decide how many to use
  return uniqueResults;
}, { name: 'searchNearbyPois', run_type: 'tool' });

/**
 * Query POIs from Redis using RediSearch FT.SEARCH with intelligent fallback logic
 * 1. Query primary POIs within radiusMeters (limited to MAX_POIS_IN_TOURPLAN_CONTEXT, sorted by distance)
 * 2. If < MAX_POIS_IN_TOURPLAN_CONTEXT, query all POIs within radiusMeters (limited to MAX_POIS_IN_TOURPLAN_CONTEXT, sorted by distance)
 * 3. If still < MAX_POIS_IN_TOURPLAN_CONTEXT, query all POIs within radiusMeters * 1.5 (limited to MAX_POIS_IN_TOURPLAN_CONTEXT, sorted by distance)
 *
 * Uses FT.SEARCH with:
 * - GEO query to filter by distance
 * - LIMIT to cap results at MAX_POIS_IN_TOURPLAN_CONTEXT
 * - Automatic distance-based sorting
 */
export const queryPoisFromRedis = traceable(async (latitude, longitude, radiusMeters, redisClient) => {
  if (!redisClient) {
    console.warn('[poiHelpers] No Redis client available for POI query');
    return [];
  }

  // Ensure index exists (safe to call multiple times)
  await ensurePoiIndexExists(redisClient);

  // Helper function to execute RediSearch geospatial query and parse results
  const searchAndParsePois = async (radius, filterPrimary = false) => {
    // RediSearch GEO query syntax: @location:[lon lat radius unit]
    let query = `@location:[${longitude} ${latitude} ${radius} m]`;
    if (filterPrimary) {
      query += ' @primary:{true}';
    }

    try {
      debugLog('RediSearch FT.SEARCH query:', query);

      const results = await redisClient.ft.search(POI_INDEX_NAME, query, {
        LIMIT: { from: 0, size: MAX_POIS_IN_TOURPLAN_CONTEXT },
      });

      debugLog('RediSearch FT.SEARCH returned', results.total, 'documents');

      // Parse results from FT.SEARCH
      const pois = [];
      if (results.documents) {
        for (const doc of results.documents) {
          try {
            const { value } = doc;

            if (!value) {
              console.warn(`[poiHelpers] Document has no value:`, doc);
              continue;
            }

            // Extract fields from document
            const locationStr = value.location;
            const placeId = value.place_id;
            const name = value.name;
            const typesRaw = value.types;
            const rating = value.rating;
            const primary = value.primary;
            const country = value.country;
            const city = value.city;
            const neighborhood = value.neighborhood;

            if (locationStr && placeId) {
              // Parse location string "lon,lat" to extract coordinates
              const [lon, lat] = locationStr.split(',').map(parseFloat);

              // Parse types - FT.SEARCH returns the JSON array directly
              let types = [];
              if (Array.isArray(typesRaw)) {
                types = typesRaw;
              } else if (typeof typesRaw === 'string') {
                // Fallback: try parsing as JSON string
                try {
                  types = JSON.parse(typesRaw);
                } catch (e) {
                  types = [];
                }
              }

              // Filter out generic types that don't add value
              types = types.filter(t => t !== 'point_of_interest' && t !== 'establishment');

              pois.push({
                id: placeId,
                name: name || 'Unknown Place',
                latitude: lat,
                longitude: lon,
                types: types,
                rating: rating ? parseFloat(rating) : null,
                primary: primary === 'true' || primary === true || primary === '1' || primary === 1,
                country: country || null,
                city: city || null,
                neighborhood: neighborhood || null
              });
            }
          } catch (err) {
            console.warn(`[poiHelpers] Failed to parse POI document:`, err.message);
          }
        }
      }

      return pois;
    } catch (err) {
      console.error('[poiHelpers] RediSearch FT.SEARCH query failed:', err);
      console.error('[poiHelpers] Query was:', query);
      return [];
    }
  };

  try {
    console.log(`[poiHelpers] Querying RediSearch for POIs near (${latitude}, ${longitude}) within ${radiusMeters}m`);

    // Step 1: Query primary POIs within radiusMeters
    let pois = await searchAndParsePois(radiusMeters, true);
    console.log(`[poiHelpers] Found ${pois.length} primary POIs within ${radiusMeters}m`);

    // Step 2: If < MAX_POIS_IN_TOURPLAN_CONTEXT primary POIs, include all POIs (primary + secondary)
    if (pois.length < MAX_POIS_IN_TOURPLAN_CONTEXT) {
      console.log(`[poiHelpers] Less than ${MAX_POIS_IN_TOURPLAN_CONTEXT} primary POIs, including secondary POIs`);
      pois = await searchAndParsePois(radiusMeters, false);
      console.log(`[poiHelpers] Found ${pois.length} total POIs within ${radiusMeters}m`);

      // Step 3: If still < MAX_POIS_IN_TOURPLAN_CONTEXT, expand radius by 1.5x
      if (pois.length < MAX_POIS_IN_TOURPLAN_CONTEXT) {
        const expandedRadius = Math.round(radiusMeters * 1.5);
        console.log(`[poiHelpers] Still less than ${MAX_POIS_IN_TOURPLAN_CONTEXT} POIs, expanding radius to ${expandedRadius}m`);
        pois = await searchAndParsePois(expandedRadius, false);
        console.log(`[poiHelpers] Found ${pois.length} POIs within ${expandedRadius}m`);
      }
    }

    console.log(`[poiHelpers] Returning ${pois.length} POIs for tour generation`);
    return pois;

  } catch (err) {
    console.error('[poiHelpers] Failed to query POIs from Redis:', err);
    return [];
  }
}, { name: 'queryPoisFromRedis', run_type: 'tool' });


/**
 * Enrich POI with location context (city, neighborhood, and their summaries)
 *
 * This function:
 * 1. Checks if POI already has city/neighborhood cached
 * 2. If not, performs reverse geocoding to get city/neighborhood
 * 3. Updates the POI cache with the location data
 * 4. Fetches city and neighborhood summaries (with caching)
 * 5. Returns POI-specific area context
 *
 * @param {Object} poi - POI object with latitude, longitude, id, name
 * @param {Object} redisClient - Redis client instance
 * @returns {Promise<Object>} Area context object with city, neighborhood, cityData, neighborhoodData
 */
export async function enrichPoiWithLocationContext(poi, redisClient) {
  try {
    debugLog('enrichPoiWithLocationContext: processing POI', poi.id, poi.name);

    let country = poi.country || null;
    let city = poi.city || null;
    let neighborhood = poi.neighborhood || null;

    // If POI doesn't have city/neighborhood, perform reverse geocoding
    if (!city && !neighborhood) {
      console.log(`[poiHelpers] POI "${poi.name}" missing location context, performing reverse geocoding...`);

      // Pass redisClient for proactive summary caching
      const geocodeResult = await reverseGeocode(poi.latitude, poi.longitude, redisClient);
      country = geocodeResult.country;
      city = geocodeResult.city;
      neighborhood = geocodeResult.neighborhood;

      debugLog('enrichPoiWithLocationContext: reverse geocoded', { country, city, neighborhood });

      // Update POI cache with location data
      if (redisClient && poi.id) {
        try {
          const placeKey = `poi_cache:${poi.id}`;
          const existingPlace = await redisClient.json.get(placeKey);

          if (existingPlace) {
            // Update city, neighborhood, and country fields
            await redisClient.json.set(placeKey, '$.country', country);
            await redisClient.json.set(placeKey, '$.city', city);
            await redisClient.json.set(placeKey, '$.neighborhood', neighborhood);
            debugLog('enrichPoiWithLocationContext: updated cache with location data');
          }
        } catch (err) {
          console.warn('[poiHelpers] Failed to update POI cache with location data:', err.message);
        }
      }
    } else {
      debugLog('enrichPoiWithLocationContext: using cached location data', { country, city, neighborhood });
    }

    // Fetch city and neighborhood summaries (with caching)
    // Use hierarchical cache keys: country:city and country:city:neighborhood
    const [cityData, neighborhoodData] = await Promise.all([
      generateCitySummary(city, country, redisClient),
      generateNeighborhoodSummary(neighborhood, city, country, redisClient)
    ]);

    debugLog('enrichPoiWithLocationContext: fetched summaries');

    return {
      country,
      city,
      neighborhood,
      cityData,
      neighborhoodData
    };

  } catch (err) {
    console.error('[poiHelpers] Failed to enrich POI with location context:', err);
    // Return empty context on error
    return {
      country: null,
      city: null,
      neighborhood: null,
      cityData: { summary: null, keyFacts: null },
      neighborhoodData: { summary: null, keyFacts: null }
    };
  }
}

