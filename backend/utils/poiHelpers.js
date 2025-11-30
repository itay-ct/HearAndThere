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

  // Split primary types into 2 balanced groups to maximize API results (20 per query)
  const primaryTypesGroup1 = [
    'historical_place', 'historical_landmark', 'monument', 'cultural_landmark',
    'museum', 'art_gallery', 'sculpture', 'performing_arts_theater',
    'cultural_center', 'park', 'botanical_garden', 'plaza', 'garden',
    'visitor_center', 'church', 'hindu_temple', 'mosque', 'synagogue',
    'observation_deck', 'wildlife_park', 'zoo', 'amusement_center'
  ];

  const primaryTypesGroup2 = [
    'tourist_attraction', 'city_hall', 'courthouse', 'public_bathroom',
    'cemetery', 'library', 'planetarium', 'opera_house', 'street_art',
    'landmark', 'bridge', 'aquarium', 'viewpoint', 'architecture_landmark',
    'marina', 'art_studio', 'local_government_office', 'beach', 'farm', 'ranch'
  ];

  const secondaryTypes = [
    'ice_cream_shop', 'coffee_shop', 'adventure_sports_center', 'dog_park',
    'picnic_ground', 'roller_coaster', 'skateboard_park', 'wildlife_refuge',
    'acai_shop', 'bagel_shop', 'cat_cafe', 'dog_cafe', 'bakery', 'cafe',
    'confectionery', 'juice_shop', 'vegan_restaurant', 'wine_bar', 'embassy',
    'campground', 'playground', 'ski_resort', 'athletic_field',
    'ice_skating_rink', 'ferry_terminal', 'public_bath', 'restaurant'
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
 * Query POIs from Redis using RediSearch with intelligent fallback logic
 * 1. Query primary POIs within radiusMeters
 * 2. If < 40, query all POIs within radiusMeters
 * 3. If still < 40, query all POIs within radiusMeters * 1.5
 * All queries sorted by distance using RediSearch GEO queries
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

    // Helper function to execute RediSearch geospatial query
    const searchPois = async (radius, filterPrimary = false) => {
      // RediSearch GEO query syntax: @location:[lon lat radius unit]
      // Build query with GEO filter + optional primary filter
      let query = `@location:[${longitude} ${latitude} ${radius} m]`;
      if (filterPrimary) {
        query += ' @primary:{true}';
      }

      try {
        debugLog('RediSearch query:', query);

        const results = await redisClient.ft.search(POI_INDEX_NAME, query, {
          LIMIT: { from: 0, size: 100 }
        });

        debugLog('RediSearch returned', results.total, 'results');

        // Parse results
        const pois = [];
        if (results.documents) {
          for (const doc of results.documents) {
            try {
              // Get full document
              const poiDoc = await redisClient.json.get(doc.id, { path: '$' });
              if (poiDoc && poiDoc[0]) {
                // Parse location string "lon,lat" to extract coordinates
                const [lon, lat] = poiDoc[0].location.split(',').map(parseFloat);

                pois.push({
                  id: poiDoc[0].place_id,
                  name: poiDoc[0].name,
                  latitude: lat,
                  longitude: lon,
                  types: poiDoc[0].types || [],
                  rating: poiDoc[0].rating,
                  primary: poiDoc[0].primary
                });
              }
            } catch (err) {
              console.warn(`[poiHelpers] Failed to parse POI document ${doc.id}:`, err.message);
            }
          }
        }

        return pois;
      } catch (err) {
        console.error('[poiHelpers] RediSearch query failed:', err);
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

    // Return top 40 POIs (already sorted by distance from RediSearch)
    const result = pois.slice(0, 40);
    console.log(`[poiHelpers] Returning ${result.length} POIs for tour generation`);
    return result;

  } catch (err) {
    console.error('[poiHelpers] Failed to query POIs from Redis:', err);
    return [];
  }
}, { name: 'queryPoisFromRedis', run_type: 'tool' });

