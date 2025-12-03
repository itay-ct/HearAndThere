/**
 * POI Helper Functions
 * 
 * Functions for fetching, caching, and querying Points of Interest (POIs)
 * from Google Maps API and Redis cache.
 */

import { traceable } from 'langsmith/traceable';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const POI_INDEX_NAME = 'idx:pois';
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
      console.log(`[poiHelpers] RediSearch index '${POI_INDEX_NAME}' already exists`);
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
    // Check if place already exists
    let existingPlace = null;
    try {
      const existing = await redisClient.json.get(placeKey, { path: '$' });
      existingPlace = existing && existing[0];
    } catch (jsonErr) {
      // Key doesn't exist or not JSON, that's fine
      debugLog('No existing place found for', place.id);
    }

    // Prepare place document
    // Note: RediSearch GEO type requires "longitude,latitude" format as a string
    const placeDoc = {
      place_id: place.id,
      name: place.name,
      types: place.types || [],
      location: `${place.longitude},${place.latitude}`, // GEO format: "lon,lat"
      rating: place.rating,
      primary: place.primary !== undefined ? place.primary : true,
      source: 'google_places_api',
      fetched_at: new Date().toISOString(),
      pinned: existingPlace?.pinned || false,
      notes: existingPlace?.notes || null,
      tags: existingPlace?.tags || [],
      images: existingPlace?.images || []
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

    // Set TTL only if not pinned (7 days)
    if (!placeDoc.pinned) {
      await redisClient.expire(placeKey, 7 * 24 * 60 * 60); // 7 days
    }

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

  return places.map((place, index) => ({
    id: place.id || `poi_${index + 1}`,
    name: place.displayName?.text || 'Unknown Place',
    latitude: place.location?.latitude || latitude,
    longitude: place.location?.longitude || longitude,
    types: place.types || [],
    rating: place.rating || null,
    primary: isPrimary, // Mark as primary or secondary
  }));
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

  debugLog('searchNearbyPois: got unique results count', uniqueResults.length);
  return uniqueResults.slice(0, 20);
}, { name: 'searchNearbyPois', run_type: 'tool' });

/**
 * Query POIs from Redis using RediSearch FT.AGGREGATE with intelligent fallback logic
 * 1. Query primary POIs within radiusMeters (limited to 40, sorted by distance)
 * 2. If < 40, query all POIs within radiusMeters (limited to 40, sorted by distance)
 * 3. If still < 40, query all POIs within radiusMeters * 1.5 (limited to 40, sorted by distance)
 *
 * Uses FT.AGGREGATE with:
 * - GEODISTANCE to calculate distance from center point
 * - SORTBY to sort by distance ascending
 * - MAX 40 to limit results natively in Redis
 */
export const queryPoisFromRedis = traceable(async (latitude, longitude, radiusMeters, redisClient) => {
  if (!redisClient) {
    console.warn('[poiHelpers] No Redis client available for POI query');
    return [];
  }

  // Ensure index exists (safe to call multiple times)
  await ensurePoiIndexExists(redisClient);

  try {
    console.log(`[poiHelpers] Querying RediSearch for POIs near (${latitude}, ${longitude}) within ${radiusMeters}m`);

    // Helper function to execute RediSearch geospatial query using FT.AGGREGATE
    // This uses native Redis sorting by distance and limits to 40 results
    const searchPois = async (radius, filterPrimary = false) => {
      // RediSearch GEO query syntax: @location:[lon lat radius unit]
      // Build query with GEO filter + optional primary filter
      let query = `@location:[${longitude} ${latitude} ${radius} m]`;
      if (filterPrimary) {
        query += ' @primary:{true}';
      }

      try {
        debugLog('RediSearch FT.AGGREGATE query:', query);

        // Use FT.AGGREGATE with LOAD, APPLY (GEODISTANCE), SORTBY, and LIMIT
        // This performs sorting and limiting natively in Redis
        const results = await redisClient.ft.aggregate(POI_INDEX_NAME, query, {
          LOAD: ['$.place_id', '$.name', '$.location', '$.types', '$.rating', '$.primary'],
          STEPS: [
            {
              type: 'APPLY',
              expression: `geodistance(@location, ${longitude}, ${latitude})`,
              AS: 'distance'
            },
            {
              type: 'SORTBY',
              BY: '@distance'
            },
            {
              type: 'LIMIT',
              from: 0,
              size: 40
            }
          ]
        });

        debugLog('RediSearch FT.AGGREGATE returned', results.total, 'results');

        // Parse results from FT.AGGREGATE
        const pois = [];
        if (results.results) {
          for (const result of results.results) {
            try {
              // FT.AGGREGATE returns results as key-value pairs
              const getValue = (key) => {
                const index = result.findIndex(item => item === key);
                return index !== -1 && index + 1 < result.length ? result[index + 1] : null;
              };

              const locationStr = getValue('$.location');
              const placeId = getValue('$.place_id');
              const name = getValue('$.name');
              const typesStr = getValue('$.types');
              const rating = getValue('$.rating');
              const primary = getValue('$.primary');

              if (locationStr && placeId) {
                // Parse location string "lon,lat" to extract coordinates
                const [lon, lat] = locationStr.split(',').map(parseFloat);

                // Parse types array (stored as JSON string)
                let types = [];
                if (typesStr) {
                  try {
                    types = JSON.parse(typesStr);
                  } catch (e) {
                    types = [];
                  }
                }

                pois.push({
                  id: placeId,
                  name: name || 'Unknown Place',
                  latitude: lat,
                  longitude: lon,
                  types: types,
                  rating: rating ? parseFloat(rating) : null,
                  primary: primary === 'true' || primary === true
                });
              }
            } catch (err) {
              console.warn(`[poiHelpers] Failed to parse POI result:`, err.message);
            }
          }
        }

        return pois;
      } catch (err) {
        console.error('[poiHelpers] RediSearch FT.AGGREGATE query failed:', err);
        console.error('[poiHelpers] Query was:', query);
        return [];
      }
    };

    // Step 1: Query primary POIs within radiusMeters
    let pois = await searchPois(radiusMeters, true);
    console.log(`[poiHelpers] Found ${pois.length} primary POIs within ${radiusMeters}m`);

    // Step 2: If < 40 primary POIs, include all POIs (primary + secondary)
    if (pois.length < 40) {
      console.log(`[poiHelpers] Less than 40 primary POIs, including secondary POIs`);
      pois = await searchPois(radiusMeters, false);
      console.log(`[poiHelpers] Found ${pois.length} total POIs within ${radiusMeters}m`);

      // Step 3: If still < 40, expand radius by 1.5x
      if (pois.length < 40) {
        const expandedRadius = Math.round(radiusMeters * 1.5);
        console.log(`[poiHelpers] Still less than 40 POIs, expanding radius to ${expandedRadius}m`);
        pois = await searchPois(expandedRadius, false);
        console.log(`[poiHelpers] Found ${pois.length} POIs within ${expandedRadius}m`);
      }
    }

    // POIs are already limited to 40 and sorted by distance from FT.AGGREGATE
    console.log(`[poiHelpers] Returning ${pois.length} POIs for tour generation`);
    return pois;

  } catch (err) {
    console.error('[poiHelpers] Failed to query POIs from Redis:', err);
    return [];
  }
}, { name: 'queryPoisFromRedis', run_type: 'tool' });

/**
 * Query food POIs from Redis using RediSearch FT.AGGREGATE
 * Returns top 15 secondary (primary: false) POIs that include "food" type,
 * sorted by rating (highest first), within the specified radius.
 *
 * Uses FT.AGGREGATE with:
 * - GEO filter for location
 * - TAG filter for primary:false
 * - TAG filter for types containing food-related types
 * - SORTBY rating descending
 * - LIMIT 15
 *
 * @param {number} latitude - Center latitude
 * @param {number} longitude - Center longitude
 * @param {number} radiusMeters - Search radius in meters
 * @param {Object} redisClient - Redis client instance
 * @returns {Promise<Array>} Array of food POI objects
 */
export const queryFoodPoisFromRedis = traceable(async (latitude, longitude, radiusMeters, redisClient) => {
  if (!redisClient) {
    console.warn('[poiHelpers] No Redis client available for food POI query');
    return [];
  }

  // Ensure index exists (safe to call multiple times)
  await ensurePoiIndexExists(redisClient);

  try {
    console.log(`[poiHelpers] Querying RediSearch for food POIs near (${latitude}, ${longitude}) within ${radiusMeters}m`);

    // Build query: GEO filter + primary:false + types containing "food"
    // Note: Redis Query Engine GEO syntax requires longitude FIRST, then latitude
    const query = `@location:[${longitude} ${latitude} ${radiusMeters} m] @primary:{false} @types:{food}`;

    debugLog('RediSearch FT.SEARCH food query:', query);

    // Use FT.SEARCH with SORTBY rating descending and LIMIT 15
    const results = await redisClient.ft.search(POI_INDEX_NAME, query, {
      SORTBY: {
        BY: 'rating',
        DIRECTION: 'DESC'
      },
      LIMIT: {
        from: 0,
        size: 15
      }
    });

    debugLog('RediSearch FT.SEARCH food query returned', results.total, 'results');

    // Parse results from FT.SEARCH
    const foodPois = [];
    if (results.documents) {
      for (const doc of results.documents) {
        try {
          const data = doc.value;

          if (data && data.location && data.place_id) {
            // Parse location string "lon,lat" to extract coordinates
            const [lon, lat] = data.location.split(',').map(parseFloat);

            foodPois.push({
              id: data.place_id,
              name: data.name || 'Unknown Place',
              latitude: lat,
              longitude: lon,
              types: data.types || [],
              rating: data.rating ? parseFloat(data.rating) : null,
              primary: data.primary === 'true' || data.primary === true
            });
          }
        } catch (err) {
          console.warn(`[poiHelpers] Failed to parse food POI result:`, err.message);
        }
      }
    }

    console.log(`[poiHelpers] Returning ${foodPois.length} food POIs for tour generation`);
    return foodPois;

  } catch (err) {
    console.error('[poiHelpers] Failed to query food POIs from Redis:', err);
    console.error('[poiHelpers] Query details:', { latitude, longitude, radiusMeters });
    return [];
  }
}, { name: 'queryFoodPoisFromRedis', run_type: 'tool' });

