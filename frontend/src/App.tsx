import { useCallback, useEffect, useRef, useState } from 'react'

const API_BASE_URL = import.meta.env.MODE === 'production'
  ? 'https://hear-and-there-production.up.railway.app'
  : 'http://localhost:4000';

const FRONTEND_VERSION = '1.0.3'; // Update this with each commit

type View = 'form' | 'tours'

type TourStop = {
  name: string
  latitude: number
  longitude: number
  dwellMinutes: number
  walkMinutesFromPrevious: number
}

type Tour = {
  id: string
  title: string
  abstract: string
  theme: string
  estimatedTotalMinutes: number
  stops: TourStop[]
}

type Status = 'idle' | 'saving' | 'success' | 'error'

function App() {
  const [latitude, setLatitude] = useState<number | ''>('')
  const [longitude, setLongitude] = useState<number | ''>('')
  const [durationMinutes, setDurationMinutes] = useState<number>(90)
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [view, setView] = useState<View>('form')
  const [tours, setTours] = useState<Tour[]>([])
  const [city, setCity] = useState<string | null>(null)
  const [neighborhood, setNeighborhood] = useState<string | null>(null)
  const [selectedTourId, setSelectedTourId] = useState<string | null>(null)

  const progressIntervalRef = useRef<number | null>(null)

  const stopProgressPolling = useCallback(() => {
    if (progressIntervalRef.current !== null) {
      window.clearInterval(progressIntervalRef.current)
      progressIntervalRef.current = null
    }
  }, [])

  const mapStageToMessage = useCallback(
    (stage: string | null | undefined, tourCount: number | null | undefined) => {
      if (tourCount && tourCount > 0) {
        return `We've prepared ${tourCount} tours for you. Pick the one that fits your mood.`
      }

      switch (stage) {
        case 'area_context_built':
        case 'context_collected':
          return 'Getting to know your area and nearby spots...'
        case 'candidates_generated':
          return 'Brainstorming a few different walking routes...'
        case 'tours_ranked':
          return 'Selecting the best tours for you...'
        default:
          return 'Saving your location and preferences...'
      }
    },
    [],
  )

  const startProgressPolling = useCallback(
    (sessionIdForPolling: string) => {
      if (!sessionIdForPolling) return

      stopProgressPolling()

      progressIntervalRef.current = window.setInterval(async () => {
        try {
          const res = await fetch(
            `${API_BASE_URL}/api/session/${sessionIdForPolling}/progress`,
          )

          if (!res.ok) {
            if (res.status !== 404) {
              console.error('Progress polling HTTP error:', res.status)
            }
            return
          }

          const progress = await res.json()
          const nextMessage = mapStageToMessage(progress.stage, progress.tourCount)
          setMessage(nextMessage)
        } catch (err) {
          console.error('Progress polling failed:', err)
        }
      }, 1000)
    },
    [mapStageToMessage, stopProgressPolling],
  )


  const canSubmit =
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)

  const handleUseMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus('error')
      setMessage('Geolocation is not supported in this browser.')
      return
    }

    setStatus('idle')
    setMessage('Detecting your location...')

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(Number(pos.coords.latitude.toFixed(6)))
        setLongitude(Number(pos.coords.longitude.toFixed(6)))
        setMessage('Location detected. You can fine-tune it if needed.')
      },
      async (err) => {
        console.error('Geolocation error', err)
        
        // Try IP-based location as fallback
        try {
          setMessage('GPS unavailable, trying IP-based location...')
          const response = await fetch('https://ipapi.co/json/')
          const data = await response.json()
          
          if (data.latitude && data.longitude) {
            setLatitude(Number(data.latitude.toFixed(6)))
            setLongitude(Number(data.longitude.toFixed(6)))
            setMessage('Approximate location detected via IP. You can fine-tune it if needed.')
            return
          }
        } catch (ipError) {
          console.error('IP location failed:', ipError)
        }
        
        // Final fallback
        setStatus('error')
        setMessage('Location unavailable. Please enter coordinates manually.')
      },
      {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 300000
      }
    )
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!canSubmit || typeof latitude !== 'number' || typeof longitude !== 'number') {
      setStatus('error')
      setMessage('Please provide a valid latitude, longitude, and duration.')
      return
    }

    setStatus('saving')

    // Create a client-side session id so we can poll progress while the
    // LangGraph pipeline is running on the backend.
    const clientSessionId =
      typeof window !== 'undefined' &&
      'crypto' in window &&
      typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`

    setSessionId(clientSessionId)
    setMessage('Saving your location and preferences...')
    startProgressPolling(clientSessionId)

    try {
      const apiUrl = `${API_BASE_URL}/api/session`
      const payload = { latitude, longitude, durationMinutes, sessionId: clientSessionId }

      console.log('=== API REQUEST DEBUG ===')
      console.log('Environment mode:', import.meta.env.MODE)
      console.log('API_BASE_URL:', API_BASE_URL)
      console.log('Full URL:', apiUrl)
      console.log('Payload:', payload)
      console.log('========================')

      // Test if we can reach the backend at all
      try {
        const healthCheck = await fetch(`${API_BASE_URL}/health`)
        console.log('Health check status:', healthCheck.status)
      } catch (healthError) {
        console.error('Health check failed:', healthError)
        const message =
          healthError instanceof Error
            ? healthError.message
            : 'Unknown health check error'
        throw new Error(`Cannot reach backend: ${message}`)
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      console.log('Response status:', response.status)
      console.log('Response headers:', Object.fromEntries(response.headers.entries()))

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Response error body:', errorText)
        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`)
      }

      const data = await response.json()
      console.log('Response data:', data)

      const hasTours = Array.isArray(data.tours) && data.tours.length > 0

      stopProgressPolling()

      setStatus('success')
      setSessionId(data.sessionId ?? clientSessionId)
      setCity(data.city ?? null)
      setNeighborhood(data.neighborhood ?? null)
      setTours(hasTours ? (data.tours as Tour[]) : [])
      setSelectedTourId(null)
      setMessage(
        hasTours
          ? mapStageToMessage('tours_ranked', data.tours.length)
          : 'Session saved! Your journey is being prepared.',
      )

      if (hasTours) {
        setView('tours')
      }
    } catch (error) {
      stopProgressPolling()

      console.error('=== API ERROR DEBUG ===')
      console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error)
      console.error('Error message:', error instanceof Error ? error.message : 'Unknown error')
      console.error('Full error:', error)
      console.error('=======================')

      setStatus('error')

      // Show detailed error info on screen for debugging
      const baseMessage =
        error instanceof Error ? error.message : 'Unexpected error communicating with API'
      let debugMessage = `Error: ${baseMessage}`
      if (baseMessage.includes('Failed to fetch')) {
        debugMessage += '\n\nPossible causes:\n• Backend not running\n• CORS issue\n• Network connectivity'
      }

      setMessage(`API Error: ${debugMessage}`)
    }
  }


  useEffect(() => {
    return () => {
      stopProgressPolling()
    }
  }, [stopProgressPolling])

  useEffect(() => {
    if (status === 'success' || status === 'error') {
      const timeout = setTimeout(() => {
        setStatus('idle')
      }, 5000)
      return () => clearTimeout(timeout)
    }
  }, [status])

  return (
    <div className="min-h-screen bg-[#fefaf6] text-slate-900 flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
        {view === 'form' ? (
          <>
            <header className="mb-8 text-center">
              <p className="text-xs font-semibold tracking-[0.3em] uppercase text-sky-700 mb-2">
                Hear &amp; There
              </p>
              <h1 className="text-3xl font-semibold text-slate-900 mb-2">Start Your Tour</h1>
              <p className="text-sm text-slate-600">Where are you starting from?</p>
            </header>

            <form onSubmit={handleSubmit} className="space-y-6">
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-800">Your location</h2>
                  <button
                    type="button"
                    onClick={handleUseMyLocation}
                    className="text-xs font-medium text-sky-700 hover:text-sky-900 underline-offset-2 hover:underline"
                  >
                    Use my location
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="flex flex-col text-xs font-medium text-slate-700">
                    Latitude
                    <input
                      type="number"
                      step="0.000001"
                      value={latitude}
                      onChange={(event) => {
                        const value = event.target.value
                        setLatitude(value === '' ? '' : Number(value))
                      }}
                      placeholder="32.0809"
                      className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500/70"
                      required
                    />
                  </label>

                  <label className="flex flex-col text-xs font-medium text-slate-700">
                    Longitude
                    <input
                      type="number"
                      step="0.000001"
                      value={longitude}
                      onChange={(event) => {
                        const value = event.target.value
                        setLongitude(value === '' ? '' : Number(value))
                      }}
                      placeholder="34.7806"
                      className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500/70"
                      required
                    />
                  </label>
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-800">Tour duration</h2>
                  <p className="text-xs text-slate-500">Between 15 minutes and 4 hours</p>
                </div>

                <div className="space-y-3">
                  <input
                    type="range"
                    min={15}
                    max={240}
                    step={5}
                    value={durationMinutes}
                    onChange={(event) => setDurationMinutes(Number(event.target.value))}
                    className="w-full cursor-pointer accent-[#f36f5e]"
                  />
                  <p className="text-xs text-slate-600">
                    <span className="mr-1" aria-hidden="true">
                      ⏱️
                    </span>
                    <span className="font-semibold text-sky-800">{durationMinutes} minutes</span>
                  </p>
                </div>
              </section>

              <div className="pt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="submit"
                  disabled={!canSubmit || status === 'saving'}
                  className="inline-flex items-center justify-center rounded-xl bg-[#f36f5e] px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {status === 'saving' ? 'Saving session…' : 'Propose Tours'}
                </button>

                <div className="text-xs text-slate-500">
                  <p>We’ll save this session in Redis to begin your journey.</p>
                </div>
              </div>
            </form>
          </>
        ) : (
          <>
            <header className="mb-6 text-center">
              <p className="text-xs font-semibold tracking-[0.3em] uppercase text-sky-700 mb-2">
                Hear &amp; There
              </p>
              <h1 className="text-3xl font-semibold text-slate-900 mb-2">Which tour do you prefer?</h1>
              <p className="text-sm text-slate-600">
                {neighborhood || city
                  ? `Starting near ${neighborhood || city}.`
                  : 'Here are a few routes based on your starting point.'}
              </p>
            </header>

            {tours.length === 0 ? (
              <p className="text-sm text-slate-600">
                No tours were generated yet. You can go back and try again.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="-mx-4 overflow-x-auto pb-2">
                  <div className="flex gap-4 px-1">
                    {tours.map((tour) => (
                      <article
                        key={tour.id}
                        className={`min-w-[260px] flex-1 rounded-2xl border px-4 py-4 shadow-sm bg-white/90 ${
                          selectedTourId === tour.id
                            ? 'border-[#f36f5e] ring-1 ring-[#f36f5e]/40'
                            : 'border-slate-200'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div>
                            <h2 className="text-sm font-semibold text-slate-900">{tour.title}</h2>
                            <p className="mt-1 text-xs text-slate-600">{tour.abstract}</p>
                          </div>
                          <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
                            {tour.theme}
                          </span>
                        </div>

                        <p className="mb-3 text-[11px] text-slate-500">
                          ⏱️ ~{tour.estimatedTotalMinutes} min · {tour.stops.length} stops
                        </p>

                        <ol className="mb-3 space-y-1 text-[11px] text-slate-600">
                          {tour.stops.map((stop, idx) => (
                            <li key={`${tour.id}-stop-${idx}`} className="flex gap-2">
                              <span className="font-semibold text-slate-500">{idx + 1}.</span>
                              <span className="flex-1">
                                {stop.name}{' '}
                                <span className="text-slate-400">
                                  · walk {stop.walkMinutesFromPrevious} min · dwell {stop.dwellMinutes} min
                                </span>
                              </span>
                            </li>
                          ))}
                        </ol>

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTourId(tour.id)
                            setMessage(`You selected “${tour.title}”. (MVP: selection is logged only.)`)
                          }}
                          className="inline-flex w-full items-center justify-center rounded-xl bg-[#f36f5e] px-3 py-2 text-xs font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
                        >
                          {selectedTourId === tour.id ? 'Selected' : 'Select this tour'}
                        </button>
                      </article>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500">
                  <button
                    type="button"
                    onClick={() => {
                      setView('form')
                      setTours([])
                      setSelectedTourId(null)
                    }}
                    className="text-xs font-medium text-sky-700 hover:text-sky-900 underline-offset-2 hover:underline"
                  >
                    ← Back to inputs
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {(status !== 'idle' || message) && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-700">
            {message && <p className="mb-1">{message}</p>}
          </div>
        )}
      </div>
      <div className="mt-8 text-center space-y-1">
        {sessionId && (
          <p className="text-xs text-slate-300 font-light">{sessionId}</p>
        )}
        <p className="text-xs text-slate-300 font-light">v{FRONTEND_VERSION}</p>
      </div>
    </div>
  )
}

export default App
