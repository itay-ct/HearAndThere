import { useCallback, useEffect, useRef, useState } from 'react'
import { LocateFixed, MapPinned, MapPinOff, Minus, Plus } from 'lucide-react'
import { TourSuggestions } from './components/TourSuggestions'
import logo from './assets/logo.svg'

const API_BASE_URL = import.meta.env.MODE === 'production'
  ? 'https://api.hearnthere.com'
  : 'http://localhost:4000';

const ENGLISH_VOICE = import.meta.env.VITE_ENGLISH_VOICE || 'en-GB-Wavenet-B';
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
  const [country, setCountry] = useState<string | null>(null)
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
  const [selectedVoice, setSelectedVoice] = useState<string>(ENGLISH_VOICE)
  const [locationDisplayText, setLocationDisplayText] = useState<string>('')
  const [loadingStatus, setLoadingStatus] = useState<string>('')
  const [loadingIcon, setLoadingIcon] = useState<string>('')
  const [showTourSuggestions, setShowTourSuggestions] = useState<boolean>(false)
  const [interestingMessages, setInterestingMessages] = useState<Array<{ icon: string; message: string }>>([])
  const [currentMessageIndex, setCurrentMessageIndex] = useState<number>(0)

  const progressIntervalRef = useRef<number | null>(null)
  const audioguidePollingRef = useRef<number | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const rotatingMessageIntervalRef = useRef<number | null>(null)
  const interestingMessagesRef = useRef<Array<{ icon: string; message: string }>>([])
  // Store auto-detected city/neighborhood/country separately so they can be restored
  const savedCityRef = useRef<string | null>(null)
  const savedNeighborhoodRef = useRef<string | null>(null)
  const savedCountryRef = useRef<string | null>(null)

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

  const stopRotatingMessages = useCallback(() => {
    if (rotatingMessageIntervalRef.current) {
      window.clearInterval(rotatingMessageIntervalRef.current)
      rotatingMessageIntervalRef.current = null
    }
  }, [])

  // Format POI type into user-friendly message
  const formatPoiTypeMessage = useCallback((type: string, count: number): string => {
    // Map common POI types to user-friendly names
    const typeMap: Record<string, string> = {
      'museum': 'museums',
      'park': 'parks',
      'restaurant': 'restaurants',
      'cafe': 'cafes',
      'art_gallery': 'art galleries',
      'church': 'churches',
      'synagogue': 'synagogues',
      'mosque': 'mosques',
      'shopping_mall': 'shopping malls',
      'store': 'stores',
      'tourist_attraction': 'tourist attractions',
      'library': 'libraries',
      'university': 'universities',
      'school': 'schools',
      'hospital': 'hospitals',
      'pharmacy': 'pharmacies',
      'bar': 'bars',
      'night_club': 'night clubs',
      'movie_theater': 'movie theaters',
      'stadium': 'stadiums',
      'gym': 'gyms',
      'spa': 'spas',
      'beauty_salon': 'beauty salons',
      'book_store': 'book stores',
      'clothing_store': 'clothing stores',
      'jewelry_store': 'jewelry stores',
      'shoe_store': 'shoe stores',
      'bakery': 'bakeries',
      'florist': 'florists',
      'hardware_store': 'hardware stores',
      'supermarket': 'supermarkets',
      'convenience_store': 'convenience stores',
      'gas_station': 'gas stations',
      'parking': 'parking areas',
      'train_station': 'train stations',
      'bus_station': 'bus stations',
      'airport': 'airports',
      'subway_station': 'subway stations',
      'taxi_stand': 'taxi stands',
      'atm': 'ATMs',
      'bank': 'banks',
      'post_office': 'post offices',
      'city_hall': 'city halls',
      'courthouse': 'courthouses',
      'embassy': 'embassies',
      'fire_station': 'fire stations',
      'police': 'police stations',
      'local_government_office': 'government offices',
      'lodging': 'hotels',
      'campground': 'campgrounds',
      'rv_park': 'RV parks',
      'cemetery': 'cemeteries',
      'funeral_home': 'funeral homes',
      'place_of_worship': 'places of worship',
      'hindu_temple': 'Hindu temples',
      'buddhist_temple': 'Buddhist temples',
      'aquarium': 'aquariums',
      'zoo': 'zoos',
      'amusement_park': 'amusement parks',
      'bowling_alley': 'bowling alleys',
      'casino': 'casinos',
    }

    const friendlyName = typeMap[type] || type.replace(/_/g, ' ')
    return `Found ${count} ${friendlyName}`
  }, [])

  // Start rotating through interesting messages with icons
  const startRotatingMessages = useCallback((messages: Array<{ icon: string; message: string }>) => {
    console.log('[RotatingMessages] Starting with messages:', messages)
    if (messages.length === 0) {
      console.log('[RotatingMessages] ⚠️ No messages to rotate, exiting')
      return
    }

    stopRotatingMessages()

    // Store messages in ref so interval can always access latest
    interestingMessagesRef.current = messages

    // Set the first message immediately
    console.log('[RotatingMessages] ✅ Setting first message:', messages[0])
    setCurrentMessageIndex(0)
    setLoadingStatus(messages[0].message)
    setLoadingIcon(messages[0].icon)

    // Then start rotating - read from ref to always get latest messages
    rotatingMessageIntervalRef.current = window.setInterval(() => {
      setCurrentMessageIndex(prevIndex => {
        const currentMessages = interestingMessagesRef.current
        if (currentMessages.length === 0) {
          console.warn('[RotatingMessages] ⚠️ No messages in ref, stopping rotation')
          return prevIndex
        }

        const nextIndex = (prevIndex + 1) % currentMessages.length
        console.log('[RotatingMessages] 🔄 Rotating from index', prevIndex, 'to', nextIndex, 'of', currentMessages.length, 'messages')

        // Update the message content based on the new index
        const currentMessage = currentMessages[nextIndex]
        if (currentMessage) {
          setLoadingStatus(currentMessage.message)
          setLoadingIcon(currentMessage.icon)
        } else {
          console.warn('[RotatingMessages] ⚠️ No message at index', nextIndex)
        }

        return nextIndex
      })
    }, 4500) // Rotate every 4.5 seconds

    console.log('[RotatingMessages] ✅ Rotation interval started')
  }, [stopRotatingMessages])

  const mapStageToMessage = useCallback(
    (stage: string | null | undefined, tourCount: number | null | undefined) => {
      if (tourCount && tourCount > 0) {
        return `We've prepared ${tourCount} tours for you. Pick the one that fits your mood.`
      }

      switch (stage) {
        case 'area_context_built':
        case 'context_collected':
          return 'Investigating the area...'
        case 'candidates_generated':
          return 'Generating tour suggestions...'
        case 'tours_ranked':
          return 'Finalizing your tours...'
        default:
          return 'Looking what\'s around...'
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
          console.log('[Progress] Received:', progress)
          const nextMessage = mapStageToMessage(progress.stage, progress.tourCount)
          setMessage(nextMessage)

          // Update tours progressively as they arrive
          if (progress.tours && Array.isArray(progress.tours) && progress.tours.length > 0) {
            console.log('[Progress] Updating tours progressively:', progress.tours.length)
            setTours(progress.tours)
            // Keep status as 'saving' so the loading cards show alongside real tours
          }

          // If we have interesting messages, keep rotating them while still loading
          const hasMessages = progress.interestingMessages && progress.interestingMessages.length > 0
          const allToursComplete = progress.tourCount && progress.tourCount > 0 && progress.tours && progress.tours.length >= progress.tourCount

          console.log('[Progress] Message rotation state:', {
            hasMessages,
            allToursComplete,
            messagesCount: progress.interestingMessages?.length || 0,
            isCurrentlyRotating: !!rotatingMessageIntervalRef.current,
            currentMessagesInState: interestingMessages.length
          })

          if (hasMessages && !allToursComplete) {
            // Update messages state AND ref immediately if they've changed
            if (progress.interestingMessages.length !== interestingMessages.length) {
              console.log('[Progress] ✅ Updating interesting messages:', progress.interestingMessages)
              setInterestingMessages(progress.interestingMessages)
              interestingMessagesRef.current = progress.interestingMessages
            }

            // Start rotating if not already rotating
            if (!rotatingMessageIntervalRef.current) {
              console.log('[Progress] 🔄 Starting rotating messages with:', progress.interestingMessages)
              startRotatingMessages(progress.interestingMessages)
            }
          } else if (allToursComplete) {
            // Only stop rotating messages when ALL tours are complete
            console.log('[Progress] ⏹️ Stopping rotation - all tours complete')
            stopRotatingMessages()
            setLoadingStatus(nextMessage)
          }
        } catch (err) {
          console.error('Progress polling failed:', err)
        }
      }, 1000)
    },
    [mapStageToMessage, stopProgressPolling, startRotatingMessages, stopRotatingMessages],
  )


  const canSubmit =
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)

  // Call reverse geocode API to get city, neighborhood, and country
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

      const { city: cityName, neighborhood: neighborhoodName, country: countryName } = data

      // Update state
      if (cityName) {
        setCity(cityName)
        savedCityRef.current = cityName
      }
      if (neighborhoodName) {
        setNeighborhood(neighborhoodName)
        savedNeighborhoodRef.current = neighborhoodName
      }
      if (countryName) {
        setCountry(countryName)
        savedCountryRef.current = countryName
      }

      // Update display text - show neighborhood / city / country
      const locationParts: string[] = []
      if (neighborhoodName) locationParts.push(neighborhoodName)
      if (cityName) locationParts.push(cityName)
      if (countryName) locationParts.push(countryName)

      if (locationParts.length > 0) {
        setLocationDisplayText(locationParts.join(', '))
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
        const lat = pos.coords.latitude
        const lon = pos.coords.longitude
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
              const lat = pos.coords.latitude
              const lon = pos.coords.longitude
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
      // Save current city/neighborhood/country before switching to manual input
      savedCityRef.current = city
      savedNeighborhoodRef.current = neighborhood
      savedCountryRef.current = country
      setShowLocationInputs(true)
      return
    }

    // Start long press timer for touch/mouse
    longPressTimerRef.current = window.setTimeout(() => {
      // Save current city/neighborhood/country before switching to manual input
      savedCityRef.current = city
      savedNeighborhoodRef.current = neighborhood
      savedCountryRef.current = country
      setShowLocationInputs(true)
    }, 500) // 500ms for long press
  }, [city, neighborhood, country])

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
    setLoadingStatus('Looking what\'s around...')
    setShowTourSuggestions(true) // Show tour suggestions component immediately
    startProgressPolling(clientSessionId)

    // Create AbortController for cancellation
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    try {
      const apiUrl = `${API_BASE_URL}/api/session`
      const payload = {
        latitude,
        longitude,
        durationMinutes,
        sessionId: clientSessionId,
        customization: customization.trim() || undefined,
        language,
        // Only include city/neighborhood/country if NOT in manual input mode
        // When manual input is shown, these should be null so backend will reverse geocode from scratch
        ...(!showLocationInputs && city && { city }),
        ...(!showLocationInputs && neighborhood && { neighborhood }),
        ...(!showLocationInputs && country && { country })
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
        signal: abortController.signal,
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
      stopRotatingMessages()

      setStatus('success')
      setSessionId(data.sessionId ?? clientSessionId)
      setCity(data.city ?? null)
      setNeighborhood(data.neighborhood ?? null)

      // Only update tours if we don't already have tours from streaming
      // This prevents overwriting tours that were progressively loaded via progress polling
      let finalTourCount = 0
      setTours(prevTours => {
        if (prevTours.length > 0) {
          console.log('[POST Complete] Keeping streamed tours:', prevTours.length)
          finalTourCount = prevTours.length
          return prevTours
        }
        console.log('[POST Complete] Using tours from response:', data.tours?.length || 0)
        finalTourCount = data.tours?.length || 0
        return hasTours ? (data.tours as Tour[]) : []
      })

      setSelectedTourId(null)
      setToursGenerated(finalTourCount > 0)
      setMessage(
        finalTourCount > 0
          ? mapStageToMessage('tours_ranked', finalTourCount)
          : '', // Don't show message if no tours
      )
    } catch (error) {
      stopProgressPolling()
      stopRotatingMessages()
      abortControllerRef.current = null

      // Check if this was a user-initiated cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Tour generation cancelled by user')
        setStatus('idle')
        setMessage('')
        return
      }

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

  const handleCancelTourGeneration = useCallback(async () => {
    console.log('Cancelling tour generation...')

    // Abort the ongoing fetch request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }

    // Stop progress polling and rotating messages
    stopProgressPolling()
    stopRotatingMessages()

    // If we have a sessionId, try to cancel the backend processing
    if (sessionId) {
      try {
        await fetch(`${API_BASE_URL}/api/session/${sessionId}/cancel`, {
          method: 'POST',
        })
        console.log('Backend cancellation request sent')
      } catch (error) {
        console.error('Failed to send cancellation to backend:', error)
        // Continue with frontend cleanup even if backend cancellation fails
      }
    }

    // Reset state
    setShowTourSuggestions(false)
    setToursGenerated(false)
    setTours([])
    setSelectedTour(null)
    setSelectedTourId(null)
    setMessage('')
    setLoadingStatus('')
    setLoadingIcon('')
    setInterestingMessages([])
    setCurrentMessageIndex(0)
    setStatus('idle')
  }, [sessionId, stopProgressPolling, stopRotatingMessages])

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
      {/* Logo centered - full width container for proper centering on mobile */}
      <div className="w-full flex justify-center mb-4">
        <img 
          src={logo} 
          alt="Hear & There" 
          className="h-[72px] w-auto"
        />
      </div>
      <div className="w-full max-w-2xl space-y-6">
         <header className="mb-8 text-center px-6 sm:px-0">
          <p className="text-lg font-bold text-slate-900 px-2 sm:px-0">AI-made audio walking tours, created just for you.</p>
        </header>
        {/* STEP 1: Input Form - Hidden when tours are shown */}
        {!showTourSuggestions && (
          <div className={`rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8 transition-opacity ${toursGenerated ? 'opacity-50 pointer-events-none' : ''}`}>
            <form onSubmit={handleSubmit} className="space-y-6">
              <section>
                <h2 className="text-sm font-semibold text-slate-800 mb-3">Start from here</h2>

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
                        <span className="text-sm font-medium">Use my location</span>
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
                      onClick={() => {
                        setShowLocationInputs(false)
                        // Restore saved city/neighborhood/country when going back to auto-detect
                        setCity(savedCityRef.current)
                        setNeighborhood(savedNeighborhoodRef.current)
                        setCountry(savedCountryRef.current)
                      }}
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
                  <h2 className="text-sm font-semibold text-slate-800 mb-3">How much time do you have?</h2>
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
                  <h2 className="text-sm font-semibold text-slate-800">Anything you're in the mood for?</h2>
                  <p className="text-xs text-slate-500">(optional)</p>
                </div>
                <textarea
                  value={customization}
                  onChange={(e) => setCustomization(e.target.value)}
                  placeholder="E.g., 'Make it a circular route', 'Focus on street art', 'Show me hidden gems', 'Add food stops'"
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
                  {status === 'saving' ? 'Generating tours…' : 'Create My Tours'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* STEP 2: Tour Suggestions (with lazy loading) */}
        {showTourSuggestions && !selectedTour && (
          <div className={`transition-opacity ${selectedTour ? 'opacity-50 pointer-events-none' : ''}`}>
            <TourSuggestions
              tours={tours}
              selectedTourId={selectedTourId}
              onSelectTour={handleSelectTour}
              onGoBack={async () => {
                // If still loading, cancel the request
                if (status === 'saving' && tours.length === 0) {
                  await handleCancelTourGeneration()
                } else {
                  // Otherwise just go back
                  setShowTourSuggestions(false)
                  setToursGenerated(false)
                  setTours([])
                  setSelectedTour(null)
                  setSelectedTourId(null)
                  setMessage('')
                  setLoadingStatus('')
                }
              }}
              neighborhood={neighborhood}
              city={city}
              isLoading={status === 'saving'}
              loadingStatus={loadingStatus}
              loadingIcon={loadingIcon}
              expectedTourCount={4}
              interestingMessages={interestingMessages}
              currentMessageIndex={currentMessageIndex}
            />
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

            {/* Legal disclaimer */}
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <p className="text-xs text-amber-800 text-center">
                Routes are AI-generated. Always stay aware of your surroundings and use your own judgment.
              </p>
            </div>

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
                {selectedTour.stops.map((stop, idx) => {
                  const walkText = stop.walkMinutesFromPrevious > 0 ? `walk ${stop.walkMinutesFromPrevious} min` : null
                  const dwellText = stop.dwellMinutes > 0 ? `dwell ${stop.dwellMinutes} min` : null
                  const details = [walkText, dwellText].filter(Boolean).join(' · ')

                  return (
                    <li key={`${selectedTour.id}-stop-${idx}`} className="flex gap-2">
                      <span className="font-semibold text-slate-500">{idx + 1}.</span>
                      <span className="flex-1">
                        {stop.name}{' '}
                        {details && (
                          <span className="text-slate-400">
                            · {details}
                          </span>
                        )}
                      </span>
                    </li>
                  )
                })}
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
                        <option value={ENGLISH_VOICE}>English (UK) - Wavenet (Default)</option>
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
