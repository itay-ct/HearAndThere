
# Hear & There — Product Specification (v1.0.12)

> AI-powered walking tour generator with audio guides, shareable tours, and real-time navigation.
> **Current Status:** Production-ready with modular architecture, two-tier caching, and comprehensive observability.

---

## 🎯 Overview

**App Name:** Hear & There
**Framework:** React with Vite + TypeScript
**UI Library:** Tailwind CSS (mobile-first, responsive design)
**Backend:** Node.js (Express) with LangGraph + Gemini
**Data Store:** Redis Stack with RediSearch (sessions, checkpointing, caching, geospatial queries)
**Cloud Services:** Google Cloud (TTS, Storage)
**Hosting:** Frontend on Vercel, backend on Railway
**Monitoring:** LangSmith for AI observability
**Version:** 1.0.12 — Modular architecture with enhanced caching and performance optimization

---

## 🧩 Core Features

### 1. **Tour Generation Interface**
   - **Responsive design** - Mobile-first, travel-style aesthetic
   - **Location input**:
     - "Use My Location" button (HTML5 Geolocation API)
     - Manual coordinate input (latitude, longitude)
   - **Duration slider**:
     - Range: **15 minutes → 4+ hours**
     - Step: **5 minutes**
     - Dynamic label shows selected duration
   - **Optional customization**:
     - Text input for preferences (e.g., "historical sites", "food tour")
   - **Language selection**:
     - English or Hebrew
   - **"Propose Tours" button**:
     - Calls `POST /api/session` with location, duration, customization, language
     - Shows loading state with progress messages
     - Displays top 3 AI-generated tours on success

### 2. **Tour Selection Screen**
   - **Tour cards** - Display title, theme, abstract, duration, stop count
   - **Stop details** - Expandable list of POIs with dwell times
   - **Walking time estimates** - Both LLM estimates and Google Maps validated times
   - **Interactive map** - Google Maps with walking route visualization
   - **"Generate Audioguide" button** - Creates audio-guided tour

### 3. **Audioguide Generation**
   - **AI script generation** - Gemini creates engaging narratives
   - **Multi-language support** - English and Hebrew
   - **Text-to-Speech** - Google Cloud TTS with Chirp3-HD voices
   - **Parallel processing** - All audio files generated concurrently
   - **Progress tracking** - Real-time status updates
   - **Shareable tour creation** - Generates unique tour ID and URL

### 4. **Tour Player (Shareable)**
   - **Unique URL** - `/tour/:tourId` for sharing
   - **Interactive map** - Google Maps with walking directions
   - **Audio playback** - Play/pause controls for intro and each stop
   - **Walking directions** - Step-by-step navigation between stops
   - **Expandable content** - Show/hide directions and scripts
   - **Feedback system** - 5-star rating and text feedback
   - **Mobile-optimized** - Touch-friendly controls and responsive layout
   - **Version display** - Shows app version in footer

### 5. **Backend API**

#### **Tour Generation** - `POST /api/session`
   - **Request body**:
     ```json
     {
       "latitude": 32.0809,
       "longitude": 34.7806,
       "durationMinutes": 90,
       "customization": "historical sites and local food",
       "language": "english"
     }
     ```
   - **Behavior**:
     - Generate UUID (`sessionId`)
     - Store session in Redis (`session:{sessionId}`)
     - Run LangGraph tour generation workflow:
       1. **collect_context** - Reverse geocode, search POIs, generate summaries
       2. **generate_candidate_tours** - Gemini creates ~10 tour options
       3. **validate_walking_times** - Google Directions API validates routes
     - Persist tours to Redis with LangGraph checkpointing
   - **Response**:
     ```json
     {
       "sessionId": "abc123",
       "status": "tours-ready",
       "city": "Tel Aviv-Yafo",
       "neighborhood": "Florentin",
       "tours": [
         {
           "id": "tour_1",
           "title": "Seaside Promenade Highlights",
           "abstract": "A relaxed 90-minute coastal walk...",
           "theme": "History & Seafront",
           "estimatedTotalMinutes": 85,
           "stops": [
             {
               "name": "Point of Interest A",
               "latitude": 32.0809,
               "longitude": 34.7806,
               "dwellMinutes": 15,
               "walkMinutesFromPrevious": 0,
               "walkMinutesFromPrevious_llm": 0,
               "walkingDirections": {
                 "distance": "1.2 km",
                 "duration": "15 mins",
                 "steps": [...]
               }
             }
           ]
         }
       ]
     }
     ```

#### **Audioguide Generation** - `POST /api/session/:sessionId/tour/:tourId/audioguide`
   - **Request body**:
     ```json
     {
       "language": "hebrew"
     }
     ```
   - **Behavior**:
     - Generate shareable tour ID
     - Store tour data in Redis (`tour:{tourId}`)
     - Run LangGraph audioguide generation workflow:
       1. **fan_out_scripts** - Generate intro + stop scripts in parallel
       2. **fan_in_scripts** - Collect all scripts
       3. **fan_out_audio** - Synthesize all audio files in parallel
       4. **fan_in_audio** - Collect all audio URLs
     - Update tour status to 'complete'
   - **Response**:
     ```json
     {
       "tourId": "tour_abc123",
       "status": "generating",
       "message": "Audioguide generation started"
     }
     ```

#### **Tour Player** - `GET /api/tour/:tourId`
   - **Response**:
     ```json
     {
       "tourId": "tour_abc123",
       "status": "complete",
       "tour": { /* tour data */ },
       "scripts": {
         "intro": { "content": "Welcome to..." },
         "stops": [{ "content": "This historic site..." }]
       },
       "audioFiles": {
         "intro": { "url": "https://storage.googleapis.com/...", "status": "complete" },
         "stops": [{ "url": "https://storage.googleapis.com/...", "status": "complete" }]
       },
       "createdAt": "2024-11-24T10:30:00Z",
       "completedAt": "2024-11-24T10:35:00Z"
     }
     ```

#### **Feedback** - `POST /api/tour/:tourId/feedback`
   - **Request body**:
     ```json
     {
       "rating": 5,
       "feedback": "Amazing tour!"
     }
     ```
   - **Response**:
     ```json
     {
       "success": true,
       "message": "Feedback submitted"
     }
     ```

---

## 🧮 LangGraph Workflows

### Tour Generation Graph (Modular Architecture v1.0.11)

**Modular Structure:**
```
backend/
├── tourGeneration.js          # Main graph definition (302 lines)
├── nodes/                     # 10 modular node files
│   ├── cache/                 # Caching layer (3 nodes)
│   ├── poi/                   # POI discovery (2 nodes)
│   ├── context/               # Context building (3 nodes)
│   └── tours/                 # Tour generation (2 nodes)
└── utils/                     # Shared utilities (4 files)
```

**Workflow:**
```
START
  ↓
check_cache_for_tour_suggestions
  ├─ [Cache HIT] → END (return cached tours)
  └─ [Cache MISS] ↓
check_poi_cache
  ├─ [40+ POIs in cache] → query_pois
  └─ [< 40 POIs] → fetch_pois_from_google_maps → query_pois
                                                ↓
reverse_geocode (parallel) ──┐
generate_area_summaries ──────┤
                              ↓
assemble_area_context
  ↓
generate_candidate_tours
  ↓
validate_walking_times
  ↓
save_tour_suggestions_to_cache
  ↓
END
```

**Nodes:**

1. **check_cache_for_tour_suggestions** (`nodes/cache/`)
   - Checks RediSearch index `idx:tour_suggestions`
   - Query: exact duration + language + location within 50m
   - Returns up to 10 cached tours if found
   - Skips cache if customization provided

2. **check_poi_cache** (`nodes/cache/`)
   - Checks RediSearch index `idx:pois`
   - Counts POIs within dynamic radius (500m-3000m based on duration)
   - Routes to Google Maps fetch if < 40 primary POIs

3. **fetch_pois_from_google_maps** (`nodes/poi/`)
   - Calls Google Places API for primary and secondary POIs
   - Caches each POI in Redis with 7-day TTL
   - Creates RediSearch index if not exists

4. **query_pois** (`nodes/poi/`)
   - Queries POIs from RediSearch index
   - Geospatial query with dynamic radius
   - Returns up to 20 POIs for tour generation

5. **reverse_geocode** (`nodes/context/`)
   - Google Maps Geocoding API → city + neighborhood
   - Traced with LangSmith

6. **generate_area_summaries** (`nodes/context/`)
   - Runs in parallel with reverse_geocode
   - Gemini 2.5 Flash generates city and neighborhood summaries
   - Provides cultural and historical context

7. **assemble_area_context** (`nodes/context/`)
   - Combines city, neighborhood, POIs, and summaries
   - Prepares complete context for tour generation

8. **generate_candidate_tours** (`nodes/tours/`)
   - Gemini 2.5 Flash generates ~10 tour options
   - Considers user customization and language
   - Fallback: heuristic tours if Gemini unavailable

9. **validate_walking_times** (`nodes/tours/`)
   - Google Directions API validates routes
   - Compares LLM estimates vs. real walking times
   - Adds step-by-step directions
   - Returns top 3 tours

10. **save_tour_suggestions_to_cache** (`nodes/cache/`)
    - Saves each tour individually with unique ID
    - 7-day TTL
    - Indexed by duration, language, and geolocation
    - Skips if customization provided or cache was hit

**Caching Strategy:**
- **Tour Suggestions Cache:** `toursuggest_cache:{UUID}` (7-day TTL)
- **POI Cache:** `poi_cache:{PLACE_ID}` (7-day TTL)
- **Discrete Durations:** Normalized to 30, 60, 90, 120, 180 minutes for better cache hits
- **RediSearch Indices:** Fast geospatial queries with GEO fields

**Checkpointing:** Uses `RedisSaver` for LangGraph state persistence

### Audioguide Generation Graph

**Nodes:**
1. **fan_out_scripts**
   - Generates scripts in parallel using `Send`:
     - Intro script (tour overview)
     - Stop scripts (one per POI)
   - Each script generated by `generateWithRetry()`:
     - Primary model: Gemini 3 Pro Preview
     - Fallback on 429: Gemini 2.5 Pro
     - Max 3 retries with exponential backoff
   - Output: Sends to `generate_script` node for each item

2. **generate_script**
   - Input: Tour data, stop data, area context
   - Calls: `generateWithRetry()` with Gemini
   - Output: Script content

3. **fan_in_scripts**
   - Collects all generated scripts
   - Output: `scripts` object with intro and stops

4. **fan_out_audio**
   - Synthesizes audio in parallel using `Send`:
     - Intro audio
     - Stop audio (one per POI)
   - Output: Sends to `synthesize_audio` node for each item

5. **synthesize_audio**
   - Input: Script text, language
   - Calls: `synthesizeAudio()` (traced)
     - Validates byte length (5000 byte TTS limit)
     - Trims text if necessary
     - Calls Google Cloud TTS API
     - Uploads to Google Cloud Storage
   - Voice selection:
     - English: `en-US-Chirp3-HD-Charon`
     - Hebrew: `he-IL-Chirp3-HD-Alnilam`
   - Output: Audio file URL

6. **fan_in_audio**
   - Collects all audio URLs
   - Output: `audioFiles` object with intro and stops

**Checkpointing:** Uses `RedisSaver` for LangGraph state persistence

---

## 🔍 LangSmith Observability

All external API calls are wrapped with `@traceable` for complete visibility:

### Tour Generation Traces
- `reverseGeocode` - Geocoding API calls
- `searchNearbyPois` - POI discovery orchestration
- `searchPlacesNearby` - Individual Places API requests
- `buildAreaContext` - Full context building pipeline
- `getWalkingDirections` - Directions API calls

### Audioguide Generation Traces
- `synthesizeAudio` - TTS API + GCS upload
- `generateWithRetry` - Gemini script generation (via LangChain)

### Trace Metadata
- Function name and run type (`'tool'`)
- Input parameters
- Output values
- Execution duration
- Error messages and stack traces
- Parent-child relationships

### Benefits
- **Debugging** - See exact inputs/outputs for every API call
- **Performance** - Identify slow operations and bottlenecks
- **Cost tracking** - Monitor API usage and token consumption
- **Error analysis** - Track failure patterns and retry logic
- **Workflow visualization** - Complete trace hierarchy

---


## 🎨 User Experience & Design

**Screen: “Start Your Tour”**

| Element | Description |
|----------|--------------|
| **Header** | “Hear & There” logo/title, centered. |
| **Instruction Text** | “Where are you starting from?” |
| **Location Input** | - Text field for coordinates (Lat, Lon)<br>- Button: “Use My Location” → auto-fills values |
| **Duration Selector** | Slider (15–240 min). Live label “⏱️ 90 minutes”. |
| **Generate Button** | CTA: “Propose Tours” — submits form to backend and transitions into a loading state while tours are being generated. |
| **Footer Text** | Small note: “We’ll save this session in Redis to begin your journey.” |

**Screen: “Which Tour Do You Prefer?”**

| Element | Description |
|----------|--------------|
| **Header** | “Which tour do you prefer?” |
| **Carousel of Tours** | Horizontally scrollable carousel of the **top 3 tours**. Each card shows title, a theme label (e.g., “History”, “Winery Route”), abstract, estimated total time, and number of stops. |
| **Tour Card Details** | Inside each card: ordered list of key points of interest (bulleted or compact list) and a short indication of walking vs. dwell time (e.g., “~20 min walk · 10–15 min per stop”). |
| **Selection CTA** | Primary button on each card: “Select this tour” (MVP can log/confirm the choice; later steps may use it to drive audio content). |
| **Session Context** | Small caption like “Starting near [approximate area name]” derived from the LangGraph output (e.g., reverse-geocoded neighborhood). |
| **Navigation** | Optional “Back to inputs” link/button to adjust location or duration and recompute tours. |

---

## 🛠️ Development & Deployment

### Technology Stack

**Frontend:**
- React 18 with TypeScript
- Vite (build tool)
- Tailwind CSS (styling)
- Google Maps JavaScript API

**Backend:**
- Node.js 18+ with Express
- LangGraph (AI workflow orchestration)
- LangChain (AI framework)
- Redis 7+ (sessions, checkpointing, data storage)

**AI & APIs:**
- Google Gemini 2.5 Flash (tour generation)
- Google Gemini 3 Pro Preview (audioguide scripts)
- Google Maps APIs (Geocoding, Places, Directions)
- Google Cloud TTS (Chirp3-HD voices)
- Google Cloud Storage (audio hosting)

**Monitoring:**
- LangSmith (AI observability and tracing)

### Environment Configuration

**Required Environment Variables:**
- `GOOGLE_MAPS_API_KEY` - Google Maps Platform API key
- `GEMINI_API_KEY` - Google AI Studio API key
- `GOOGLE_APPLICATION_CREDENTIALS` - Path to GCP service account JSON
- `GCS_BUCKET_NAME` - Google Cloud Storage bucket name
- `REDIS_URL` - Redis connection string
- `LANGCHAIN_API_KEY` - LangSmith API key (optional)

### Deployment

**Frontend (Vercel):**
- Automatic deployment on push to `main`
- Environment variables: `VITE_GOOGLE_MAPS_API_KEY`
- SPA routing via `vercel.json`
- Production URL: `https://hear-and-there.vercel.app`

**Backend (Railway):**
- Automatic deployment on push to `main`
- Redis add-on provisioned
- Environment variables configured in dashboard
- Production URL: `https://hear-and-there-production.up.railway.app`

### Versioning

- **Format:** Semantic versioning (e.g., 1.0.14)
- **Backend Health:** `GET /health` returns `{ status: "ok", version: "1.0.14" }`
- **Frontend Display:** Version shown in tour player footer
- **Updates:** Increment with each deployment

### Cache Troubleshooting

**Common Issues:**

1. **Index is empty despite having documents**
   - **Symptom:** Redis has `toursuggest_cache:*` keys but index shows 0 documents
   - **Cause:** Index created before documents, or incorrect document structure
   - **Fix:** Drop and recreate index: `redis-cli FT.DROPINDEX idx:tour_suggestions` then restart backend

2. **Cache always returns MISS**
   - **Symptom:** Tours never retrieved from cache
   - **Cause:** Duration not normalized, or location tolerance too strict
   - **Fix:** Verify durations are normalized to 30, 60, 90, 120, 180 minutes

3. **Search returns 0 results**
   - **Symptom:** Documents exist but search fails
   - **Cause:** Query syntax error or GEO format incorrect
   - **Fix:** Verify `startLocation` is in format `"longitude,latitude"`

**Required Document Structure:**
```json
{
  "tourId": "uuid-here",
  "duration": 60,
  "language": "english",
  "startLocation": "longitude,latitude",
  "tour": { "id": "uuid", "title": "...", "stops": [...] },
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**RediSearch Index Schema:**
- `idx:tour_suggestions` - Tour suggestions cache
  - `tourId` (TAG), `duration` (NUMERIC), `language` (TAG)
  - `startLocation` (GEO), `title` (TEXT), `createdAt` (TEXT)
  - Prefix: `toursuggest_cache:`

- `idx:pois` - POI cache
  - `name` (TEXT), `types` (TAG array), `location` (GEO)
  - `rating` (NUMERIC), `primary` (TAG)
  - Prefix: `poi_cache:`

---

## 📖 License

This project is released under the [MIT License](LICENSE).
