# Hear & There 🚶‍♂️

A smart walking tour generator that creates personalized audio-guided tours using AI based on your location and preferences.

## Features

### 🗺️ Tour Generation
- **Smart location-based tour generation** - Uses your GPS location or manual coordinates
- **AI-powered route planning** - Google Gemini generates personalized walking tours
- **Multiple tour options** - Choose from 3 AI-generated tours with different themes
- **Flexible duration** - Tours from 15 minutes to 4+ hours
- **Dynamic radius calculation** - POI search adapts to tour duration
- **Real-time walking directions** - Google Maps Directions API validates and displays routes
- **Historical and cultural context** - City and neighborhood summaries from Gemini

### 🎙️ Audio Guide Generation
- **AI-generated scripts** - Gemini creates engaging narratives for each stop
- **Multi-language support** - English and Hebrew audio guides
- **Google Cloud TTS** - High-quality text-to-speech with Chirp3-HD voices
- **Automatic byte limit handling** - Scripts trimmed to fit TTS 5000-byte limit
- **Parallel audio generation** - All audio files generated concurrently
- **Cloud storage** - Audio files hosted on Google Cloud Storage

### 🎧 Tour Player
- **Shareable tour links** - Each tour gets a unique URL (`/tour/:tourId`)
- **Interactive map** - Google Maps with walking route visualization
- **Audio playback** - Play/pause controls for intro and each stop
- **Walking directions** - Step-by-step directions between stops
- **Feedback system** - Rate tours and provide feedback
- **Mobile-responsive** - Optimized for on-the-go use

### 🔍 Observability
- **LangSmith tracing** - Complete visibility into AI workflows
- **External API tracing** - Google Maps, Places, Directions, and TTS calls tracked
- **Error handling** - Automatic fallback from `gemini-3-pro-preview` to `gemini-2.5-pro` on rate limits
- **Performance monitoring** - Track API latency and bottlenecks

## Tech Stack

- **Frontend**: React + TypeScript + Tailwind CSS + Vite
- **Backend**: Node.js + Express + LangGraph
- **AI Models**:
  - Google Gemini 2.5 Flash (tour generation)
  - Google Gemini 3 Pro Preview (audioguide scripts, with fallback to 2.5 Pro)
- **APIs**:
  - Google Maps Geocoding API
  - Google Places API (Nearby Search)
  - Google Directions API
  - Google Cloud Text-to-Speech API
- **Storage**:
  - Redis (sessions, checkpointing, tour data)
  - Google Cloud Storage (audio files)
- **Deployment**:
  - Vercel (frontend)
  - Railway (backend)
- **Monitoring**: LangSmith for AI observability and tracing

## Quick Start

### Prerequisites
- Node.js 18+
- Redis 7+
- Google Cloud Project with:
  - Maps JavaScript API enabled
  - Geocoding API enabled
  - Places API (New) enabled
  - Directions API enabled
  - Text-to-Speech API enabled
  - Cloud Storage bucket created
- Google Gemini API key
- LangSmith account (optional, for tracing)

### Setup
```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/hear-and-there.git
cd hear-and-there

# Backend setup
cd backend && npm install
cp .env.example .env  # Add your API keys

# Frontend setup
cd ../frontend && npm install
cp .env.example .env  # Add Google Maps API key
```

### Environment Variables

**Backend (.env)**
```env
# Redis
REDIS_URL=redis://localhost:6379

# Google APIs
GOOGLE_MAPS_API_KEY=your_maps_api_key
GEMINI_API_KEY=your_gemini_api_key

# Google Cloud (for TTS and Storage)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
GCS_BUCKET_NAME=your-bucket-name

# AI Models
GEMINI_MODEL=gemini-2.5-flash
GEMINI_AUDIOGUIDE_MODEL=gemini-3-pro-preview

# LangSmith (optional)
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=your_langsmith_api_key
LANGCHAIN_PROJECT=hear-and-there

# Server
PORT=4000
```

**Frontend (.env)**
```env
VITE_GOOGLE_MAPS_API_KEY=your_maps_api_key
```

### Run Both Services
```bash
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start Backend
cd backend && npm start

# Terminal 3: Start Frontend
cd frontend && npm run dev
```

Open `http://localhost:5173`

## VS Code Debug
Press F5 and select "Launch Full Stack" to run both backend and frontend with debugging enabled

## API Endpoints

### Tour Generation
- `GET /health` - Health check with version info
- `POST /api/session` - Create tour generation session
  - Body: `{ latitude, longitude, durationMinutes, customization?, language? }`
  - Returns: `{ sessionId, status, city, neighborhood, tours }`

### Audioguide Generation
- `POST /api/session/:sessionId/tour/:tourId/audioguide` - Generate audioguide
  - Body: `{ language? }` (defaults to 'english')
  - Returns: `{ tourId, status, message }`

### Tour Player
- `GET /api/tour/:tourId` - Get shareable tour data
  - Returns: Complete tour with scripts and audio files
- `GET /api/tour/:tourId/feedback` - Get tour feedback
- `POST /api/tour/:tourId/feedback` - Submit tour feedback
  - Body: `{ rating, feedback? }`

## Architecture

### Tour Generation Flow (LangGraph)
1. **collect_context** - Reverse geocode, search POIs, generate city/neighborhood summaries
2. **generate_candidate_tours** - Gemini generates ~10 tour options
3. **validate_walking_times** - Google Directions API validates routes and timing

### Audioguide Generation Flow (LangGraph)
1. **fan_out_scripts** - Generate intro + stop scripts in parallel with Gemini
2. **fan_in_scripts** - Collect all generated scripts
3. **fan_out_audio** - Synthesize all audio files in parallel with Google TTS
4. **fan_in_audio** - Collect all audio URLs

### LangSmith Tracing
All external API calls are wrapped with `@traceable`:
- `reverseGeocode` - Geocoding API
- `searchNearbyPois` - Places API orchestration
- `searchPlacesNearby` - Individual Places API calls
- `buildAreaContext` - Full context building pipeline
- `getWalkingDirections` - Directions API
- `synthesizeAudio` - TTS API + GCS upload

## Deployment

### Frontend (Vercel)
- Automatic deployment on push to `main`
- Environment variables configured in Vercel dashboard
- SPA routing configured via `vercel.json`

### Backend (Railway)
- Automatic deployment on push to `main`
- Redis add-on provisioned
- Environment variables configured in Railway dashboard
- Google Cloud service account credentials added as secret

---
**Version 1.0.10**
