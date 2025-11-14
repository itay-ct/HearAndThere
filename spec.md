
# Hear & There — Initial Build Specification (v0.1)

> Lightweight, responsive React app for discovering personalized walking tours.  
> **Goal of this milestone:** Set up a hosted, styled, and functional **first screen** that saves user input (location + duration) into Redis under a session ID.

---

## 🎯 Overview

**App Name:** Hear & There
**Framework:** React with Vite
**UI Library:** Tailwind CSS (lightweight and mobile-friendly)
**Backend:** Node.js (Express)
**Data Store:** Redis (session storage only for this step)
**Hosting:** Frontend on Vercel, backend on Railway
**Version:** MVP 0.1 — Focused on functional UI and Redis integration.

---

## 🧩 Features in This Step

1. **Frontend (React + Tailwind)**
   - Responsive design (mobile-first, travel-style look)
   - Optimized for both mobile and desktop with fluid layouts
   - Enhanced visual hierarchy with proper spacing and typography
   - Two user inputs:
     - **Location**
       - Option A: "Use My Location" button (HTML5 Geolocation API)
       - Option B: Manual coordinate input (latitude, longitude)
       - *(Later version will add "Choose on Map")*
     - **Duration Slider**
       - Range: **15 minutes → 4 hours**
       - Step: **5 minutes**
       - Label shows selected duration dynamically.
   - **Propose Tours** button:
     - On click → stores both inputs in Redis with a generated `sessionId`.
     - Add timestamp to the record.
     - Confirmation message: "Session saved! Your journey is being prepared."

2. **Backend (Node.js + Redis)**
   - Simple Express server.
   - One endpoint: `POST /api/session`
     - Body:
       ```json
       {
         "latitude": 32.0809,
         "longitude": 34.7806,
         "durationMinutes": 90
       }
       ```
     - Server generates UUID (`sessionId`), saves record in Redis with timestamp.
     - Example record:
       ```
       session:{sessionId}
         latitude: 32.0809
         longitude: 34.7806
         durationMinutes: 90
         createdAt: 1731600000000
       ```
     - Response:
       ```json
       { "sessionId": "abc123", "status": "saved" }
       ```

3. **Styling Goals**
   - Clean, airy layout with travel theme optimized for all screen sizes
   - Mobile-first responsive design with breakpoint considerations
   - Enhanced visual appeal with proper contrast and accessibility
   - Color palette: soft sand (#fefaf6), ocean blue (#2c6e91), accent coral (#f36f5e).
   - Rounded cards, large buttons, gentle shadows.
   - Use Tailwind utilities for responsive layout and component styling.
   - Simple typography (e.g., Inter or Nunito Sans) with proper font scaling.

---

## 🧠 UX Wireframe Description

**Screen: “Start Your Tour”**

| Element | Description |
|----------|--------------|
| **Header** | “Hear & There” logo/title, centered. |
| **Instruction Text** | “Where are you starting from?” |
| **Location Input** | - Text field for coordinates (Lat, Lon)<br>- Button: “Use My Location” → auto-fills values |
| **Duration Selector** | Slider (15–240 min). Live label “⏱️ 90 minutes”. |
| **Generate Button** | CTA: “Propose Tours” — submits form to backend. |
| **Footer Text** | Small note: “We’ll save this session in Redis to begin your journey.” |

---

## 🚀 Getting Started

### Frontend

1. Clone the repository:
   ```
   git clone https://github.com/your-username/hear-and-there.git
   cd hear-and-there
   ```

2. Install frontend dependencies:
   ```
   cd frontend
   npm install
   ```

3. Start the development server:
   ```
   npm run dev
   ```

4. Open your browser and navigate to `http://localhost:5173` to see the app in action.

### Backend

1. Navigate to the backend directory:
   ```
   cd backend
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the backend server:
   ```
   npm start
   ```

4. The backend server will run on `http://localhost:4000` by default (or on the port specified in the `PORT` environment variable).

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

- **Framework:** Node.js (Express)
- **Database:** Redis
- **Build Tool:** NPM
- **Testing Framework:** Jest
- **Linting Tool:** ESLint
- **Version Control:** Git

### Versioning & Deployment Tracking

- **Version Format:** Semantic versioning (e.g., 1.0.2)
- **Backend Health Endpoint:** `GET /health` returns:
  ```json
  {
    "status": "ok",
    "version": "1.0.2"
  }
  ```
- **Frontend Version Display:** Version shown at bottom of page in light gray text (e.g., "v1.0.2")
- **Version Updates:** Increment patch version (x.x.+1) with each commit for deployment tracking
- **Auto-Deployment:** Both Vercel (frontend) and Railway (backend) deploy automatically on git push to main branch

---

## 📚 Learning Resources

### Frontend

- [React Documentation](https://reactjs.org/docs/getting-started.html)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [Vite Documentation](https://vitejs.dev/guide/) (if using Vite)
- [Next.js Documentation](https://nextjs.org/docs) (if using Next.js)

### Backend

- [Node.js Documentation](https://nodejs.org/en/docs/)
- [Express Documentation](https://expressjs.com/en/4x/api.html) (if using Express)
- [Fastify Documentation](https://www.fastify.io/docs/latest/) (if using Fastify)
- [Redis Documentation](https://redis.io/documentation)

---

## 📝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for more information on how to get started.

---

## 📖 License

This project is released under the [MIT License](LICENSE).
