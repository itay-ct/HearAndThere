import { useCallback, useEffect, useRef, useState } from 'react'
import { LocateFixed, MapPinned, MapPinOff, Minus, Plus } from 'lucide-react'

const API_BASE_URL = import.meta.env.MODE === 'production'
  ? 'https://hear-and-there-production.up.railway.app'
  : 'http://localhost:4000';

const FRONTEND_VERSION = __APP_VERSION__; // Injected from package.json by Vite

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
type LocationStatus = 'idle' | 'detecting' | 'detected' | 'error'

function App() {
  const [latitude, setLatitude] = useState<number | ''>('')
  const [longitude, setLongitude] = useState<number | ''>('')
  const [durationMinutes, setDurationMinutes] = useState<number>(90)
  const [customization, setCustomization] = useState<string>('')
  const [language, setLanguage] = useState<string>('english')
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
  const [shareableTourId, setShareableTourId] = useState<string | null>(null)
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle')
  const [showLocationInputs, setShowLocationInputs] = useState<boolean>(false)
  const [selectedVoice, setSelectedVoice] = useState<string>('en-GB-Wavenet-B')
  const [locationDisplayText, setLocationDisplayText] = useState<string>('')

  const progressIntervalRef = useRef<number | null>(null)
  const audioguidePollingRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const longPressTimerRef = useRef<number | null>(null)

  // Smooth scroll to bottom utility function
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth'
      })
    }, 100) // Small delay to ensure DOM has updated
  }, [])

  // Update default voice when language changes
  useEffect(() => {
    if (language === 'hebrew') {
      setSelectedVoice('he-IL-Standard-D')
    } else {
      setSelectedVoice('en-GB-Wavenet-B')
    }
  }, [language])

  // Scroll to bottom when tours are generated
  useEffect(() => {
    if (toursGenerated && tours.length > 0) {
      scrollToBottom()
    }
  }, [toursGenerated, tours.length, scrollToBottom])

  // Scroll to bottom when a tour is selected
  useEffect(() => {
    if (selectedTour) {
      scrollToBottom()
    }
  }, [selectedTour, scrollToBottom])

  // Scroll to bottom when audioguide generation starts
  useEffect(() => {
    if (audioguideGenerating) {
      scrollToBottom()
    }
  }, [audioguideGenerating, scrollToBottom])

  // Scroll to bottom when audioguide is complete
  useEffect(() => {
    if (audioguideData) {
      scrollToBottom()
    }
  }, [audioguideData, scrollToBottom])

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

  // Call reverse geocode API to get city and neighborhood
  const fetchLocationDetails = useCallback(async (lat: number, lon: number) => {
    try {
      console.log('[Location] Fetching location details for:', { lat, lon })
      const response = await fetch(`${API_BASE_URL}/api/reverse-geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lon })
      })

      if (!response.ok) {
        console.error('[Location] Reverse geocode failed with status:', response.status)
        return
      }

      const data = await response.json()
      console.log('[Location] Reverse geocode result:', data)

      const { city: cityName, neighborhood: neighborhoodName } = data

      // Update state
      if (cityName) setCity(cityName)
      if (neighborhoodName) setNeighborhood(neighborhoodName)

      // Update display text
      if (neighborhoodName && cityName) {
        setLocationDisplayText(`${neighborhoodName}, ${cityName}`)
      } else if (cityName) {
        setLocationDisplayText(cityName)
      } else if (neighborhoodName) {
        setLocationDisplayText(neighborhoodName)
      }
    } catch (error) {
      console.error('[Location] Failed to fetch location details:', error)
    }
  }, [])

  const handleUseMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      console.error('[Location] Geolocation API not supported by browser')
      setLocationStatus('error')
      return
    }

    console.log('[Location] Starting location detection...')
    console.log('[Location] Browser:', navigator.userAgent)
    console.log('[Location] HTTPS:', window.location.protocol === 'https:')

    setLocationStatus('detecting')

    // First attempt: High accuracy (GPS)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        console.log('[Location] ✅ Success! Position:', {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: new Date(pos.timestamp).toISOString()
        })
        const lat = Number(pos.coords.latitude.toFixed(6))
        const lon = Number(pos.coords.longitude.toFixed(6))
        setLatitude(lat)
        setLongitude(lon)
        setLocationStatus('detected')
        setMessage('') // Clear any previous approximate location message

        // Fetch location details (city, neighborhood)
        fetchLocationDetails(lat, lon)
      },
      (err) => {
        console.error('[Location] ❌ High accuracy geolocation failed:', {
          code: err.code,
          message: err.message,
          PERMISSION_DENIED: err.code === 1,
          POSITION_UNAVAILABLE: err.code === 2,
          TIMEOUT: err.code === 3
        })

        // If POSITION_UNAVAILABLE or TIMEOUT, try fallback with lower accuracy
        if (err.code === 2 || err.code === 3) {
          console.log('[Location] Attempting fallback with lower accuracy...')

          // Second attempt: Lower accuracy (WiFi/network-based)
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              console.log('[Location] ✅ Fallback success! Approximate position:', {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                timestamp: new Date(pos.timestamp).toISOString()
              })
              const lat = Number(pos.coords.latitude.toFixed(6))
              const lon = Number(pos.coords.longitude.toFixed(6))
              setLatitude(lat)
              setLongitude(lon)
              setLocationStatus('detected')
              setMessage('⚠️ Approximate location detected. You can fine-tune it manually if needed.')

              // Fetch location details (city, neighborhood)
              fetchLocationDetails(lat, lon)
            },
            (fallbackErr) => {
              console.error('[Location] ❌ Fallback also failed:', {
                code: fallbackErr.code,
                message: fallbackErr.message
              })

              // No more fallbacks - show error
              console.error('[Location] All geolocation attempts failed')
              setLocationStatus('error')
              setMessage('Unable to detect location.')
            },
            {
              enableHighAccuracy: false, // Use network-based location
              timeout: 10000,
              maximumAge: 600000 // Accept cached position up to 10 minutes old
            }
          )
        } else if (err.code === 1) {
          // PERMISSION_DENIED - no fallback possible
          console.error('[Location] Permission denied. User blocked location access.')
          console.error('[Location] Check: Browser permissions, site settings, and system location services')
          setLocationStatus('error')
          setMessage('Location permission denied. Please enable location access in your browser settings.')
        } else {
          console.error('[Location] Unknown error occurred')
          setLocationStatus('error')
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 300000
      }
    )
  }, [])

  const handleLocationButtonPress = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    // Check for Ctrl/Cmd + Click
    if ('ctrlKey' in e && (e.ctrlKey || e.metaKey)) {
      setShowLocationInputs(true)
      return
    }

    // Start long press timer for touch/mouse
    longPressTimerRef.current = window.setTimeout(() => {
      setShowLocationInputs(true)
    }, 500) // 500ms for long press
  }, [])

  const handleLocationButtonRelease = useCallback(() => {
    // Clear long press timer
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const handleLocationButtonClick = useCallback((e: React.MouseEvent) => {
    // If Ctrl/Cmd was pressed, don't trigger location detection
    if (e.ctrlKey || e.metaKey) {
      return
    }

    // Only detect location if not already showing inputs
    if (!showLocationInputs) {
      console.log('[Location] Button clicked, current status:', locationStatus)
      handleUseMyLocation()
    }
  }, [showLocationInputs, handleUseMyLocation, locationStatus])

  const DURATION_OPTIONS = [30, 60, 90, 120, 180]

  const handleDecreaseDuration = useCallback(() => {
    const currentIndex = DURATION_OPTIONS.indexOf(durationMinutes)
    if (currentIndex > 0) {
      setDurationMinutes(DURATION_OPTIONS[currentIndex - 1])
    }
  }, [durationMinutes])

  const handleIncreaseDuration = useCallback(() => {
    const currentIndex = DURATION_OPTIONS.indexOf(durationMinutes)
    if (currentIndex < DURATION_OPTIONS.length - 1) {
      setDurationMinutes(DURATION_OPTIONS[currentIndex + 1])
    }
  }, [durationMinutes])

  const getDurationLabel = (minutes: number) => {
    switch (minutes) {
      case 30: return '30 minutes'
      case 60: return '1 hour'
      case 90: return '1.5 hours'
      case 120: return '2 hours'
      case 180: return '3 hours'
      default: return `${minutes} minutes`
    }
  }

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
      const payload = {
        latitude,
        longitude,
        durationMinutes,
        sessionId: clientSessionId,
        customization: customization.trim() || undefined,
        language,
        ...(city && { city }),
        ...(neighborhood && { neighborhood })
      }

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
    setShareableTourId(null)
    setMessage('Generating audioguide scripts and audio files...')

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/session/${sessionId}/tour/${selectedTour.id}/audioguide`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice: selectedVoice }),
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const data = await response.json()
      console.log('Audioguide generation started:', data)

      // Store the shareable tour ID
      if (data.tourId) {
        setShareableTourId(data.tourId)
      }

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
  }, [sessionId, selectedTour, selectedVoice, startAudioguidePolling])

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

      directionsService.route(request, (result: any, status: string) => {
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
         <header className="mb-8 text-center">
          <h1 className="text-3xl font-semibold text-slate-900 mb-2">Hear &amp; There</h1>
          <p>Generate your own personalized audio-guided walking tour</p>
        </header>
        {/* STEP 1: Input Form */}
        <div className={`rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8 transition-opacity ${toursGenerated ? 'opacity-50 pointer-events-none' : ''}`}>
         

          <form onSubmit={handleSubmit} className="space-y-6">
              <section>
                <h2 className="text-sm font-semibold text-slate-800 mb-3">Your location</h2>

                {!showLocationInputs ? (
                  <button
                    type="button"
                    onClick={handleLocationButtonClick}
                    onMouseDown={handleLocationButtonPress}
                    onMouseUp={handleLocationButtonRelease}
                    onMouseLeave={handleLocationButtonRelease}
                    onTouchStart={handleLocationButtonPress}
                    onTouchEnd={handleLocationButtonRelease}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                      locationStatus === 'detected'
                        ? 'border-green-200 bg-green-50 text-green-700'
                        : locationStatus === 'error'
                        ? 'border-red-200 bg-red-50 text-red-700'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-sky-300 hover:bg-sky-50'
                    }`}
                  >
                    {locationStatus === 'detecting' ? (
                      <>
                        <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-sm font-medium">Detecting location...</span>
                      </>
                    ) : locationStatus === 'detected' ? (
                      <>
                        <MapPinned className="w-5 h-5" />
                        <span className="text-sm font-medium">
                          {locationDisplayText || 'Location Detected'}
                        </span>
                      </>
                    ) : locationStatus === 'error' ? (
                      <>
                        <MapPinOff className="w-5 h-5" />
                        <span className="text-sm font-medium">Location cannot be detected - Try Again</span>
                      </>
                    ) : (
                      <>
                        <LocateFixed className="w-5 h-5" />
                        <span className="text-sm font-medium">Detect my location</span>
                      </>
                    )}
                  </button>
                ) : (
                  <div className="space-y-3">
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
                          className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500/70"
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
                          className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500/70"
                          required
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowLocationInputs(false)}
                      className="text-xs text-slate-600 hover:text-slate-900 underline"
                    >
                      Hide manual input
                    </button>
                  </div>
                )}
              </section>

              <section className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {/* Tour Duration */}
                <div>
                  <h2 className="text-sm font-semibold text-slate-800 mb-3">Tour duration</h2>
                  <div className="inline-flex items-center rounded-xl border border-slate-200 overflow-hidden">
                    {/* Decrease button */}
                    <button
                      type="button"
                      onClick={handleDecreaseDuration}
                      disabled={DURATION_OPTIONS.indexOf(durationMinutes) === 0}
                      className="w-10 h-10 flex items-center justify-center hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition"
                    >
                      <Minus className="w-4 h-4" />
                    </button>

                    {/* Fixed width label */}
                    <div className="w-24 text-center select-none">
                      <p className="text-sm font-semibold text-slate-900">
                        {getDurationLabel(durationMinutes)}
                      </p>
                    </div>

                    {/* Increase button */}
                    <button
                      type="button"
                      onClick={handleIncreaseDuration}
                      disabled={DURATION_OPTIONS.indexOf(durationMinutes) === DURATION_OPTIONS.length - 1}
                      className="w-10 h-10 flex items-center justify-center hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Language - Hidden for now, keeping English as default */}
                <div style={{ display: 'none' }}>
                  <h2 className="text-sm font-semibold text-slate-800 mb-3">Language</h2>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500/70"
                  >
                    <option value="english">English</option>
                    <option value="hebrew">עברית (Hebrew)</option>
                  </select>
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-800">Customization</h2>
                  <p className="text-xs text-slate-500">Optional</p>
                </div>
                <textarea
                  value={customization}
                  onChange={(e) => setCustomization(e.target.value)}
                  placeholder="E.g., 'Focus on street art and modern culture' or 'Include kid-friendly stops'"
                  rows={3}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500/70 resize-none"
                />
              </section>


              <div className="pt-2">
                <button
                  type="submit"
                  disabled={!canSubmit || status === 'saving'}
                  className="w-full inline-flex items-center justify-center rounded-xl bg-[#f36f5e] px-5 py-2.5 text-sm font-semibold text-white shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {status === 'saving' ? 'Saving session…' : 'Propose Tours'}
                </button>
              </div>
            </form>
          </div>

        {/* STEP 1.5: Tour Generation Loading */}
        {status === 'saving' && !toursGenerated && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <div className="rounded-2xl border border-sky-200 bg-sky-50/50 p-6">
              <h3 className="text-sm font-semibold text-sky-900 mb-4">
                🗺️ Generating Tours
              </h3>
              <p className="text-xs text-sky-700 mb-4">
                Creating personalized walking tours for you. This usually takes up to 60 seconds...
              </p>
              <div className="flex items-center gap-3 text-xs">
                <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-sky-700">Analyzing area and generating tours...</span>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: Tour Selection */}
        {toursGenerated && tours.length > 0 && (
          <div className={`rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8 transition-opacity ${selectedTour ? 'opacity-50 pointer-events-none' : ''}`}>
            <button
                type="button"
                onClick={() => {
                  setToursGenerated(false);
                  setTours([]);
                  setSelectedTour(null);
                  setSelectedTourId(null);
                  setMessage(''); // Clear message when going back
                }}
                className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-slate-600 hover:text-slate-900 transition"
              >
                <span>←</span>
                <span>Go Back</span>
              </button>
            <header className="mb-6 text-center">
              
              <h1 className="text-3xl font-semibold text-slate-900 mb-2">
                Choose Your Tour
              </h1>
              <p className="text-sm text-slate-600">
                {neighborhood || city
                  ? `Starting near ${neighborhood || city}.`
                  : 'Here are a few routes we prepared for you.'}
              </p>
            </header>

            <div className="space-y-4">
              
                <div className="-mx-4 overflow-x-auto pb-2">
                  <div className="flex gap-4 px-1">
                    {tours.map((tour) => (
                      <article
                        key={tour.id}
                        className={`min-w-[260px] flex-1 rounded-2xl border px-4 py-4 bg-white/90 ${
                          selectedTourId === tour.id
                            ? 'border-[#f36f5e] ring-1 ring-[#f36f5e]/40'
                            : 'border-slate-200'
                        }`}
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <div className="flex-1">
                            <h2 className="text-sm font-semibold text-slate-900">{tour.title}</h2>
                          </div>

                         <span className="inline-flex items-center justify-center text-center w-24 rounded-2xl border border-sky-200 bg-sky-50 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-tight text-sky-700">
                           {tour.theme}
                         </span>
                        </div>

                        <p className="mt-1 text-xs text-slate-600">{tour.abstract}</p>
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
                          className="inline-flex w-full items-center justify-center rounded-xl bg-[#f36f5e] px-3 py-2 text-xs font-semibold text-white shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
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
          <div className={`rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8 transition-opacity ${audioguideData || audioguideGenerating || audioguideError ? 'opacity-50 pointer-events-none' : ''}`}>
            <button
              type="button"
              onClick={() => {
                setSelectedTour(null);
                setSelectedTourId(null);
                setMessage(''); // Clear message when going back
              }}
              className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-slate-600 hover:text-slate-900 transition"
            >
              <span>←</span>
              <span>Go Back</span>
            </button>

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
                style={{ touchAction: 'pan-x pan-y pinch-zoom' }}
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

            {/* STEP 4: Voice Selection & Generate Audioguide Button */}
            {!audioguideData && !audioguideGenerating && !audioguideError && (
              <div className="space-y-4">
                {/* Voice Selection - Hidden for now, keeping default voice */}
                <div style={{ display: 'none' }}>
                  <label htmlFor="voice-select" className="block text-xs font-medium text-slate-700 mb-2">
                    🎙️ Select Voice
                  </label>
                  <select
                    id="voice-select"
                    value={selectedVoice}
                    onChange={(e) => setSelectedVoice(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
                  >
                    {language === 'hebrew' ? (
                      <>
                        <option value="he-IL-Standard-D">Hebrew - Standard (Default)</option>
                        <option value="he-IL-Chirp3-HD-Alnilam">Hebrew - Chirp3 HD</option>
                      </>
                    ) : (
                      <>
                        <option value="en-GB-Wavenet-B">English (UK) - Wavenet (Default)</option>
                        <option value="en-US-Chirp3-HD-Algenib">English (US) - Chirp3 HD</option>
                      </>
                    )}
                  </select>
                </div>

                {/* Generate Button */}
                <button
                  type="button"
                  onClick={handleGenerateAudioguide}
                  className="w-full inline-flex items-center justify-center rounded-xl bg-[#f36f5e] px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
                >
                  🎧 Generate Audioguide
                </button>
              </div>
            )}
          </div>
        )}


        {selectedTour && shareableTourId && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-6 text-center">
              <h3 className="text-sm font-semibold text-emerald-900 mb-4">
                🎧 Your Audioguide is Being Created!
              </h3>
              <p className="text-xs text-emerald-700 mb-6">
                Your personalized audioguide is being generated. Click the button below to view your tour page.
              </p>
              <button
                onClick={() => window.location.href = `/tour/${shareableTourId}`}
                className="inline-flex items-center justify-center rounded-xl bg-[#f36f5e] px-6 py-3 text-sm font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
              >
                🎧 Take me to my audiotour
              </button>
              <p className="text-xs text-slate-500 mt-4">
                You can share this link with others!
              </p>
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
        <p className="text-xs text-slate-300 font-light opacity-80 hover:opacity-100 transition-opacity">
          Reverse geocoding by{" "}
          <a href="https://locationiq.com" target="_blank" rel="noopener noreferrer" className="hover:text-slate-400 transition-colors opacity-50">
            LocationIQ.com
          </a>
        </p>
        {sessionId && (
          <p className="text-xs text-slate-300 font-light">{sessionId}</p>
        )}
        <p className="text-xs text-slate-300 font-light">v{FRONTEND_VERSION}</p>
      </div>


    </div>
  )
}

export default App
