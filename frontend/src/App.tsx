import { useCallback, useEffect, useRef, useState } from 'react'

const API_BASE_URL = import.meta.env.MODE === 'production'
  ? 'https://hear-and-there-production.up.railway.app'
  : 'http://localhost:4000';

const FRONTEND_VERSION = '1.0.8'; // Update this with each commit

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
  const [tours, setTours] = useState<Tour[]>([])
  const [city, setCity] = useState<string | null>(null)
  const [neighborhood, setNeighborhood] = useState<string | null>(null)
  const [selectedTourId, setSelectedTourId] = useState<string | null>(null)
  const [selectedTour, setSelectedTour] = useState<Tour | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)
  const [audioguideGenerating, setAudioguideGenerating] = useState<boolean>(false)
  const [audioguideData, setAudioguideData] = useState<any>(null)
  const [audioguideError, setAudioguideError] = useState<string | null>(null)
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null)
  const [toursGenerated, setToursGenerated] = useState<boolean>(false)

  const progressIntervalRef = useRef<number | null>(null)
  const audioguidePollingRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

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
      setToursGenerated(hasTours)
      setMessage(
        hasTours
          ? mapStageToMessage('tours_ranked', data.tours.length)
          : 'Session saved! Your journey is being prepared.',
      )
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

  const handleSelectTour = useCallback(async (tour: Tour) => {
    setSelectedTourId(tour.id)
    setSelectedTour(tour)
    setMessage(`Tour selected: "${tour.title}"`)

    try {
      // Check if Google Maps is loaded
      if (!window.google || !window.google.maps) {
        throw new Error('Google Maps not loaded')
      }

      setMapError(null)
      // Stay on tours view, map will render inline
    } catch (error) {
      console.error('Error loading map:', error)
      setMapError(error instanceof Error ? error.message : 'Failed to load map')
      setMessage(`Selected "${tour.title}". Map unavailable.`)
    }
  }, [])

  const stopAudioguidePolling = useCallback(() => {
    if (audioguidePollingRef.current !== null) {
      window.clearInterval(audioguidePollingRef.current)
      audioguidePollingRef.current = null
    }
  }, [])

  const startAudioguidePolling = useCallback((sessionIdForPolling: string, tourIdForPolling: string) => {
    if (!sessionIdForPolling || !tourIdForPolling) return

    stopAudioguidePolling()

    audioguidePollingRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/session/${sessionIdForPolling}/tour/${tourIdForPolling}/audioguide`
        )

        if (!res.ok) {
          if (res.status === 404) {
            // Not found yet, keep polling
            return
          }
          console.error('Audioguide polling HTTP error:', res.status)
          return
        }

        const data = await res.json()
        console.log('Audioguide status:', data.status)

        if (data.status === 'complete') {
          setAudioguideData(data)
          setAudioguideGenerating(false)
          setAudioguideError(null)
          setMessage('Audioguide ready! Click play to listen.')
          stopAudioguidePolling()
        } else if (data.status === 'failed') {
          setAudioguideGenerating(false)
          setAudioguideError(data.error || 'Audioguide generation failed. Please try again.')
          setMessage('Audioguide generation failed.')
          stopAudioguidePolling()
        }
      } catch (err) {
        console.error('Audioguide polling failed:', err)
      }
    }, 2000) // Poll every 2 seconds
  }, [stopAudioguidePolling])

  const handleGenerateAudioguide = useCallback(async () => {
    if (!sessionId || !selectedTour) return

    setAudioguideGenerating(true)
    setAudioguideData(null)
    setAudioguideError(null)
    setMessage('Generating audioguide scripts and audio files...')

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/session/${sessionId}/tour/${selectedTour.id}/audioguide`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const data = await response.json()
      console.log('Audioguide generation started:', data)
      setMessage('Audioguide generation in progress...')

      // Start polling for status
      startAudioguidePolling(sessionId, selectedTour.id)
    } catch (error) {
      console.error('Failed to start audioguide generation:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to start audioguide generation'
      setAudioguideError(errorMessage)
      setMessage('Failed to start audioguide generation')
      setAudioguideGenerating(false)
    }
  }, [sessionId, selectedTour, startAudioguidePolling])

  const handlePlayAudio = useCallback((audioUrl: string, audioId: string) => {
    // Stop currently playing audio
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    // If clicking the same audio, just pause
    if (playingAudioId === audioId) {
      setPlayingAudioId(null)
      return
    }

    // Play new audio - audioUrl is already a full GCS URL
    const audio = new Audio(audioUrl)
    audio.play()
    audioRef.current = audio
    setPlayingAudioId(audioId)

    audio.onended = () => {
      setPlayingAudioId(null)
      audioRef.current = null
    }
  }, [playingAudioId])

  const handlePauseAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setPlayingAudioId(null)
  }, [])

  useEffect(() => {
    return () => {
      stopProgressPolling()
      stopAudioguidePolling()
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [stopProgressPolling, stopAudioguidePolling])

  useEffect(() => {
    if (status === 'success' || status === 'error') {
      const timeout = setTimeout(() => {
        setStatus('idle')
      }, 5000)
      return () => clearTimeout(timeout)
    }
  }, [status])

  // Add effect to initialize map when tour is selected
  useEffect(() => {
    if (selectedTour && window.google && window.google.maps) {
      initializeMap()
    }
  }, [selectedTour])

  // Add map initialization function
  const initializeMap = useCallback(async () => {
    if (!selectedTour || !latitude || !longitude) return
    
    try {
      const mapElement = document.getElementById('tour-map')
      if (!mapElement) return
      
      // Initialize map centered on user's starting location
      const map = new window.google.maps.Map(mapElement, {
        zoom: 15,
        center: { lat: Number(latitude), lng: Number(longitude) },
        mapTypeId: window.google.maps.MapTypeId.ROADMAP,
      })
      
      // Add marker for starting location
      new window.google.maps.Marker({
        position: { lat: Number(latitude), lng: Number(longitude) },
        map: map,
        title: 'Start Point',
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="8" fill="#10b981" stroke="white" stroke-width="2"/>
              <circle cx="12" cy="12" r="3" fill="white"/>
            </svg>
          `),
          scaledSize: new window.google.maps.Size(24, 24),
        }
      })
      
      // Add markers for each stop
      selectedTour.stops.forEach((stop, index) => {
        new window.google.maps.Marker({
          position: { lat: stop.latitude, lng: stop.longitude },
          map: map,
          title: `${index + 1}. ${stop.name}`,
          label: {
            text: String(index + 1),
            color: 'white',
            fontWeight: 'bold',
          },
          icon: {
            url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="16" cy="16" r="12" fill="#f36f5e" stroke="white" stroke-width="2"/>
              </svg>
            `),
            scaledSize: new window.google.maps.Size(32, 32),
          }
        })
      })
      
      // Create directions service and renderer
      const directionsService = new window.google.maps.DirectionsService()
      const directionsRenderer = new window.google.maps.DirectionsRenderer({
        suppressMarkers: true, // We're using custom markers
        polylineOptions: {
          strokeColor: '#f36f5e',
          strokeWeight: 4,
          strokeOpacity: 0.8,
        }
      })
      
      directionsRenderer.setMap(map)
      
      // Build waypoints (all stops except the last one)
      const waypoints = selectedTour.stops.slice(0, -1).map(stop => ({
        location: { lat: stop.latitude, lng: stop.longitude },
        stopover: true,
      }))
      
      // Request directions
      const request = {
        origin: { lat: Number(latitude), lng: Number(longitude) },
        destination: { 
          lat: selectedTour.stops[selectedTour.stops.length - 1].latitude, 
          lng: selectedTour.stops[selectedTour.stops.length - 1].longitude 
        },
        waypoints: waypoints,
        travelMode: window.google.maps.TravelMode.WALKING,
      }
      
      directionsService.route(request, (result, status) => {
        if (status === 'OK' && result) {
          directionsRenderer.setDirections(result)
          setMessage(`Map loaded for "${selectedTour.title}". Ready to explore!`)
        } else {
          console.error('Directions request failed:', status)
          setMapError(`Failed to load walking directions: ${status}`)
        }
      })
      
    } catch (error) {
      console.error('Error initializing map:', error)
      setMapError(error instanceof Error ? error.message : 'Failed to initialize map')
    }
  }, [selectedTour, latitude, longitude])

  // Add Google Maps script loading
  useEffect(() => {
    const loadGoogleMaps = () => {
      if (window.google && window.google.maps) {
        return Promise.resolve()
      }

      return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
        
        if (!apiKey) {
          reject(new Error('Google Maps API key not configured'))
          return
        }

        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=geometry`
        script.async = true
        script.defer = true
        
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('Failed to load Google Maps'))
        
        document.head.appendChild(script)
      })
    }

    // Load Google Maps when component mounts
    loadGoogleMaps().catch(error => {
      console.error('Error loading Google Maps:', error)
    })
  }, [])

  return (
    <div className="min-h-screen bg-[#fefaf6] text-slate-900 flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-2xl space-y-6">
        {/* STEP 1: Input Form */}
        <div className={`rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8 transition-opacity ${toursGenerated ? 'opacity-50' : ''}`}>
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
          </div>

        {/* STEP 2: Tour Selection */}
        {toursGenerated && tours.length > 0 && (
          <div className={`rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8 transition-opacity ${selectedTour ? 'opacity-50' : ''}`}>
            <header className="mb-6 text-center">
              <p className="text-xs font-semibold tracking-[0.3em] uppercase text-sky-700 mb-2">
                Hear &amp; There
              </p>
              <h1 className="text-3xl font-semibold text-slate-900 mb-2">
                Choose Your Tour
              </h1>
              <p className="text-sm text-slate-600">
                {neighborhood || city
                  ? `Starting near ${neighborhood || city}.`
                  : 'Here are a few routes based on your starting point.'}
              </p>
            </header>

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
                          onClick={() => handleSelectTour(tour)}
                          className="inline-flex w-full items-center justify-center rounded-xl bg-[#f36f5e] px-3 py-2 text-xs font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
                        >
                          {selectedTourId === tour.id ? 'Selected' : 'Select this tour'}
                        </button>
                      </article>
                    ))}
                  </div>
                </div>

            </div>
          </div>
        )}

        {/* STEP 3: Map View */}
        {selectedTour && (
          <div className={`rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8 transition-opacity ${audioguideData || audioguideGenerating || audioguideError ? 'opacity-50' : ''}`}>
            <header className="mb-6 text-center">
              <h2 className="text-2xl font-semibold text-slate-900 mb-2">{selectedTour.title}</h2>
              <p className="text-sm text-slate-600">{selectedTour.abstract}</p>
            </header>

            {mapError ? (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                {mapError}
              </div>
            ) : (
              <div
                id="tour-map"
                className="w-full h-96 rounded-xl border border-slate-200 bg-slate-100 mb-6"
              />
            )}

            <div className="bg-slate-50 rounded-xl p-4 mb-6">
              <h3 className="text-sm font-semibold text-slate-800 mb-2">Tour Details</h3>
              <p className="text-xs text-slate-600 mb-3">
                ⏱️ ~{selectedTour.estimatedTotalMinutes} min · {selectedTour.stops.length} stops
              </p>

              <ol className="space-y-2 text-xs text-slate-600">
                {selectedTour.stops.map((stop, idx) => (
                  <li key={`${selectedTour.id}-stop-${idx}`} className="flex gap-2">
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
            </div>

            {/* STEP 4: Generate Audioguide Button */}
            {!audioguideData && !audioguideGenerating && !audioguideError && (
              <button
                type="button"
                onClick={handleGenerateAudioguide}
                className="w-full inline-flex items-center justify-center rounded-xl bg-[#f36f5e] px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
              >
                🎧 Generate Audioguide
              </button>
            )}
          </div>
        )}

        {/* STEP 5: Audioguide Status/Player */}
        {selectedTour && audioguideGenerating && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <div className="rounded-2xl border border-sky-200 bg-sky-50/50 p-6">
              <h3 className="text-sm font-semibold text-sky-900 mb-4">
                🎧 Generating Audioguide
              </h3>
              <p className="text-xs text-sky-700 mb-4">
                Creating engaging narration for your tour. This may take a few minutes...
              </p>
              <div className="flex items-center gap-3 text-xs">
                <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-sky-700">Generating scripts and audio...</span>
              </div>
            </div>
          </div>
        )}

        {selectedTour && audioguideError && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <div className="rounded-2xl border border-red-200 bg-red-50/50 p-6">
              <h3 className="text-sm font-semibold text-red-900 mb-4">
                ❌ Audioguide Generation Failed
              </h3>
              <p className="text-xs text-red-700 mb-4">
                {audioguideError}
              </p>
              <button
                type="button"
                onClick={handleGenerateAudioguide}
                className="inline-flex items-center justify-center rounded-xl bg-[#f36f5e] px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        {selectedTour && audioguideData && audioguideData.audioFiles && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-6">
              <h3 className="text-sm font-semibold text-emerald-900 mb-4">
                🎧 Audioguide Ready
              </h3>
              <p className="text-xs text-emerald-700 mb-4">
                Your personalized audioguide is ready. Click play to listen to each segment.
              </p>

              <div className="space-y-3">
                {/* Introduction */}
                {audioguideData.audioFiles.intro && audioguideData.audioFiles.intro.url && (
                  <div className="bg-white rounded-xl p-4 border border-emerald-100">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1">
                        <h4 className="text-xs font-semibold text-slate-900 mb-1">
                          Introduction
                        </h4>
                        <p className="text-[11px] text-slate-600">
                          Welcome and tour overview
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          playingAudioId === 'intro'
                            ? handlePauseAudio()
                            : handlePlayAudio(audioguideData.audioFiles.intro.url, 'intro')
                        }
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 transition"
                      >
                        {playingAudioId === 'intro' ? '⏸' : '▶'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Stops */}
                {audioguideData.audioFiles.stops && audioguideData.audioFiles.stops.map((stopAudio: any, index: number) => {
                  if (!stopAudio || !stopAudio.url) return null
                  const stop = selectedTour.stops[index]
                  if (!stop) return null

                  const audioId = `stop-${index}`

                  return (
                    <div key={audioId} className="bg-white rounded-xl p-4 border border-emerald-100">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1">
                          <h4 className="text-xs font-semibold text-slate-900 mb-1">
                            Stop {index + 1}: {stop.name}
                          </h4>
                          <p className="text-[11px] text-slate-600">
                            Historical facts and stories
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            playingAudioId === audioId
                              ? handlePauseAudio()
                              : handlePlayAudio(stopAudio.url, audioId)
                          }
                          className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 transition"
                        >
                          {playingAudioId === audioId ? '⏸' : '▶'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Status Message */}
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
