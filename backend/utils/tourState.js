/**
 * Tour State Definition for LangGraph
 * 
 * Defines the state structure used throughout the tour generation workflow.
 * Each node can read from and write to these state fields.
 */

export function createTourState(Annotation, MessagesAnnotation) {
  return Annotation.Root({
    ...MessagesAnnotation.spec,
    
    // Area context (assembled from multiple nodes)
    areaContext: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
    
    // Tour data
    candidateTours: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => [],
    }),
    finalTours: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => [],
    }),
    
    // Cache status
    cacheHit: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => false,
    }),
    poiCacheHit: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => false,
    }),
    poisCount: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => 0,
    }),
    
    // POI data
    pois: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => [],
    }),
    googleMapsFetched: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => false,
    }),

    // Location data
    country: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
    city: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
    neighborhood: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),

    // Area summaries
    cityData: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => ({ summary: null, keyFacts: null }),
    }),
    neighborhoodData: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => ({ summary: null, keyFacts: null }),
    }),

    // Error handling
    error: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
  });
}

