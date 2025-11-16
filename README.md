# Hear & There 🚶‍♂️

A smart walking tour generator that creates personalized tours using AI based on your location and preferences.

## Features

- Smart location-based tour generation
- AI-powered route planning with Google Gemini
- Multiple tour options with different themes
- Flexible duration (30 minutes to 3+ hours)
- Historical and cultural context from Wikipedia

## Tech Stack

- **Frontend**: React + TypeScript + Tailwind CSS
- **Backend**: Node.js + Express + LangGraph
- **AI**: Google Gemini for tour generation
- **Storage**: Redis for sessions
- **Deployment**: Vercel (frontend), Railway (backend)
- **Monitoring**: LangSmith for AI observability

## Quick Start

### Prerequisites
- Node.js 18+, Redis, Google Maps API key, Gemini API key

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
```

### Environment Variables
**Backend (.env)**
```env
REDIS_URL=redis://localhost:6379
GOOGLE_MAPS_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here
PORT=4000
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
Press F5 and select "Launch Full Stack" to run both backend and frontend

## API
- `GET /health` - Health check
- `POST /api/session` - Create tour session

---
**Version 1.0.3**
