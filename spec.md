
# Hear & There — Initial Build Specification (v0.1)

> Lightweight, responsive React app for discovering personalized walking tours.
> **Goal of this milestone:** Implement the initial "Start Your Tour" flow plus an AI-powered tour generation pipeline that stores the user's request and top 3 candidate tours in Redis, and displays a "Which tour do you prefer?" selection screen.

---

## 🎯 Overview

**App Name:** Hear & There
**Framework:** React with Vite
**UI Library:** Tailwind CSS (lightweight and mobile-friendly)
**Backend:** Node.js (Express) with LangGraph + Gemini
**Data Store:** Redis (session + AI agent memory)
**Hosting:** Frontend on Vercel, backend on Railway
**Version:** 1.0.3 — MVP flow with AI-native LangGraph tour generation and Redis-backed memory.

---

## 🧩 Features in This Step

1. **Frontend (React + Tailwind) — Start Your Tour**
   - Responsive design (mobile-first, travel-style look)
   - Optimized for both mobile and desktop with fluid layouts
   - Enhanced visual hierarchy with proper spacing and typography
   - Two user inputs:
     - **Location**
       - Option A: "Use My Location" button (HTML5 Geolocation API)
       - Option B: Manual coordinate input (latitude, longitude)
       - *(Later version may add "Choose on Map")*
     - **Duration Slider**
       - Range: **15 minutes → 4 hours**
       - Step: **5 minutes**
       - Label shows selected duration dynamically.
   - **Propose Tours** button:
     - On click → calls backend `POST /api/session` with location + duration.
     - Frontend shows a loading state ("Your journey is being prepared...") while tours are being computed.
     - On success → navigates to the **"Which tour do you prefer?"** screen with the top 3 tours.

2. **Backend (Node.js + Redis + LangGraph + Gemini)**
   - Express server with `POST /api/session`.
   - Request body:
     ```json
     {
       "latitude": 32.0809,
       "longitude": 34.7806,
       "durationMinutes": 90
     }
     ```
   - Behavior (happy path):
     - Generate UUID (`sessionId`) and store base session in Redis (`session:{sessionId}`) with `latitude`, `longitude`, `durationMinutes`, `createdAt`.
     - Run a LangGraph workflow that:
       - reverse-geocodes the start point via Google Maps (city + neighborhood),
       - searches nearby POIs via Google Maps Places,
       - optionally enriches area context via Wikipedia (direct API or Wikipedia MCP),
       - calls **Gemini** to propose ~10 candidate walking tours,
       - scores and keeps the **top tours** (usually 3) matching the duration.
     - Persist context + tours into Redis (see LangGraph section) under keys derived from `session:{sessionId}`.
   - Response:
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
           "abstract": "A relaxed 90-minute coastal walk with historic views and cafés.",
           "theme": "History & Seafront",
           "estimatedTotalMinutes": 85,
           "stops": [
             {
               "name": "Point of Interest A",
               "latitude": 32.0809,
               "longitude": 34.7806,
               "dwellMinutes": 15,
               "walkMinutesFromPrevious": 0
             }
           ]
         }
       ]
     }
     ```
   - Redis core record remains:
     ```
     session:{sessionId}
       latitude: 32.0809
       longitude: 34.7806
       durationMinutes: 90
       createdAt: 1731600000000
       city: Tel Aviv-Yafo
       neighborhood: Florentin
       tours: [JSON-serialized array of top tours]
     ```

3. **Styling Goals**
   - Clean, airy layout with travel theme optimized for all screen sizes
   - Mobile-first responsive design with breakpoint considerations
   - Enhanced visual appeal with proper contrast and accessibility
   - Color palette: soft sand (#fefaf6), ocean blue (#2c6e91), accent coral (#f36f5e).
   - Rounded cards, large buttons, gentle shadows.
   - Use Tailwind utilities for responsive layout and component styling.
   - Simple typography (e.g., Inter or Nunito Sans) with proper font scaling.

4. **AI Tour Generation & Selection**
   - Use LangGraph to orchestrate tool calls (Google Maps MCP + Wikipedia Nearby MCP) to compute candidate tours.
   - Store the top 3 tours in Redis under the user's session.
   - Expose tour data to the frontend so the user can immediately pick a preferred tour on the second screen.

---
## 🧮 LangGraph + Gemini Tour Generation (AI-native)

### Integrations

- **Google Maps (REST or MCP)** – reverse geocode, search POIs near the start point.
- **Wikipedia (REST or MCP)** – fetch simple area/context summaries.
- **Gemini (via @langchain/google-genai)** – generate and refine walking tours.
- **Redis** – primary memory for all stages of the agent, keyed by `session:{sessionId}`.

### Graph (conceptual)

1. **collect_context**
   - Inputs: `sessionId`, `latitude`, `longitude`, `durationMinutes`.
   - Reverse-geocode to get `city` + `neighborhood`.
   - Search nearby POIs via Google Maps.
   - Optionally fetch Wikipedia summaries for `city` / `neighborhood`.
   - Persist to Redis:
     - `session:{sessionId}` – base hash with `city`, `neighborhood`.
     - `session:{sessionId}:pois` – list of POIs.
     - `session:{sessionId}:wikipedia` – hash with summaries.
     - `session:{sessionId}:messages` – internal messages/logs.

2. **generate_candidate_tours**
   - Load area context from Redis.
   - Call Gemini with structured JSON describing start point, POIs, and Wikipedia context.
   - Ask Gemini for ~10 candidate tours with themes and time estimates.
   - Persist candidates to `session:{sessionId}:candidate_tours` and update `stage` in the main hash.

3. **rank_tours**
   - Load candidate tours from Redis (or fall back to heuristic tours from POIs).
   - Score tours by fit to `durationMinutes` and POI variety.
   - Keep the **top tours** (usually 3).
   - Persist final tours to `session:{sessionId}:tours` and mirror them into `tours` on the main hash.

The `POST /api/session` handler invokes this graph and then responds with `{ sessionId, status, city, neighborhood, tours }` based on what was stored in Redis.

---


## 🧠 UX Wireframe Description

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

## 🛠️ Development Environment

### Frontend

- **Framework:** React with Vite
- **UI Library:** Tailwind CSS
- **Build Tool:** Vite
- **State Management:** React Context or Redux (if needed)
- **Testing Framework:** Jest
- **Linting Tool:** ESLint
- **Version Control:** Git

### Backend

- **Framework:** Node.js (Express) with LangGraph
- **Data Store:** Redis (session + generated tours)
- **External Tools (MCP):** Google Maps MCP, Wikipedia Nearby MCP
- **Build Tool:** npm
- **Testing Framework:** Jest
- **Linting Tool:** ESLint
- **Version Control:** Git

### Versioning & Deployment Tracking

- **Version Format:** Semantic versioning (e.g., 1.0.3)
- **Backend Health Endpoint:** `GET /health` returns:
  ```json
  {
    "status": "ok",
    "version": "1.0.3"
  }
  ```
- **Frontend Version Display:** Version shown at bottom of page in light gray text (e.g., "v1.0.3")
- **Version Updates:** Increment the version (often patch, sometimes minor) with each meaningful change for deployment tracking
- **Auto-Deployment:** Both Vercel (frontend) and Railway (backend) deploy automatically on git push to main branch

---

## 📖 License

This project is released under the [MIT License](LICENSE).
