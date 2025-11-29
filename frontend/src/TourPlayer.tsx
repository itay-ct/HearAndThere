import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Play, Pause, ChevronDown, ChevronUp } from 'lucide-react'

const API_BASE_URL = import.meta.env.MODE === 'production'
  ? 'https://hear-and-there-production.up.railway.app'
  : 'http://localhost:4000'
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
const FRONTEND_VERSION = __APP_VERSION__ // Injected from package.json by Vite

interface Stop {
  name: string
  placeId?: string
  latitude: number
  longitude: number
  dwellMinutes: number
  walkMinutesFromPrevious: number
  walkingDirections?: {
    distance: string
    duration: string
    steps: Array<{
      instruction: string
      distance: string
      duration: string
    }>
  }
}

interface Tour {
  id: string
  title: string
  abstract: string
  theme: string
  estimatedTotalMinutes: number
  stops: Stop[]
}

interface AudioFile {
  status: string
  url?: string
}

interface AudioFiles {
  intro?: AudioFile
  stops?: AudioFile[]
}

interface Script {
  content: string
}

interface Scripts {
  intro?: Script
  stops?: Script[]
}

interface TourData {
  tourId: string
  status: string
  title: string
  abstract: string
  theme: string
  estimatedTotalMinutes: number
  language: string
  startLatitude?: number
  startLongitude?: number
  tour?: Tour
  scripts?: Scripts
  audioFiles?: AudioFiles
  error?: string
}

export default function TourPlayer() {
  const { tourId } = useParams<{ tourId: string }>()
  const [tourData, setTourData] = useState<TourData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null)
  const [expandedScripts, setExpandedScripts] = useState<Set<string>>(new Set())
  const [expandedDirections, setExpandedDirections] = useState<Set<number>>(new Set())
  const [feedback, setFeedback] = useState<string>('')
  const [rating, setRating] = useState<number>(0)
  const [hoveredRating, setHoveredRating] = useState<number>(0)
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false)
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<google.maps.Map | null>(null)
  const audioRefs = useRef<{ [key: string]: HTMLAudioElement }>({})

  // Fetch tour data
  useEffect(() => {
    if (!tourId) return

    const fetchTourData = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/tour/${tourId}`)
        if (!response.ok) {
          throw new Error('Tour not found')
        }
        const data = await response.json()
        setTourData(data)
        setLoading(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load tour')
        setLoading(false)
      }
    }

    fetchTourData()

    // Poll for updates if still generating
    const interval = setInterval(async () => {
      if (tourData?.status === 'generating') {
        fetchTourData()
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [tourId, tourData?.status])

  // Load Google Maps
  useEffect(() => {
    if (!tourData?.tour || !mapRef.current || mapInstanceRef.current) return

    const loadMap = async () => {
      if (!window.google) {
        const script = document.createElement('script')
        script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`
        script.async = true
        script.defer = true
        await new Promise((resolve) => {
          script.onload = resolve
          document.head.appendChild(script)
        })
      }

      // Determine map center (starting point if available, otherwise first stop)
      const centerLat = tourData.startLatitude ?? tourData.tour?.stops[0].latitude ?? 0
      const centerLng = tourData.startLongitude ?? tourData.tour?.stops[0].longitude ?? 0

      const map = new google.maps.Map(mapRef.current!, {
        zoom: 14,
        center: { lat: centerLat, lng: centerLng },
      })

      mapInstanceRef.current = map

      // Add starting point marker if available
      if (tourData.startLatitude && tourData.startLongitude) {
        new google.maps.Marker({
          position: { lat: tourData.startLatitude, lng: tourData.startLongitude },
          map,
          title: 'Starting Point',
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#10b981',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        })
      }

      // Add markers for each stop
      tourData.tour?.stops.forEach((stop, index) => {
        new google.maps.Marker({
          position: { lat: stop.latitude, lng: stop.longitude },
          map,
          label: `${index + 1}`,
          title: stop.name,
        })
      })

      // Use Directions API to draw actual walking route (not straight lines)
      if (tourData.startLatitude && tourData.startLongitude && tourData.tour?.stops && tourData.tour.stops.length > 0) {
        const directionsService = new google.maps.DirectionsService()
        const directionsRenderer = new google.maps.DirectionsRenderer({
          suppressMarkers: true, // We're using custom markers
          polylineOptions: {
            strokeColor: '#f36f5e',
            strokeWeight: 4,
            strokeOpacity: 0.8,
          }
        })

        directionsRenderer.setMap(map)

        // Build waypoints (all stops except the last one)
        const waypoints = tourData.tour?.stops.slice(0, -1).map(stop => ({
          location: { lat: stop.latitude, lng: stop.longitude },
          stopover: true,
        }))

        // Get the last stop for the destination
        const lastStop = tourData.tour?.stops[tourData.tour?.stops.length - 1]

        // Request directions from starting point through all stops
        const request = {
          origin: { lat: tourData.startLatitude, lng: tourData.startLongitude },
          destination: {
            lat: lastStop!.latitude,
            lng: lastStop!.longitude
          },
          waypoints: waypoints,
          travelMode: google.maps.TravelMode.WALKING,
        }

        directionsService.route(request, (result, status) => {
          if (status === 'OK' && result) {
            directionsRenderer.setDirections(result)
            console.log('[TourPlayer] Walking route loaded successfully')
          } else {
            console.error('[TourPlayer] Directions request failed:', status)
            // Fallback to simple polyline if directions fail
            const path = []
            path.push({ lat: tourData.startLatitude!, lng: tourData.startLongitude! })
            path.push(...tourData.tour!.stops.map(stop => ({ lat: stop.latitude, lng: stop.longitude })))

            new google.maps.Polyline({
              path,
              geodesic: true,
              strokeColor: '#f36f5e',
              strokeOpacity: 1.0,
              strokeWeight: 3,
              map,
            })
          }
        })
      } else if (tourData.tour?.stops && tourData.tour.stops.length > 0) {
        // No starting point, just draw route between stops
        const directionsService = new google.maps.DirectionsService()
        const directionsRenderer = new google.maps.DirectionsRenderer({
          suppressMarkers: true,
          polylineOptions: {
            strokeColor: '#f36f5e',
            strokeWeight: 4,
            strokeOpacity: 0.8,
          }
        })

        directionsRenderer.setMap(map)

        const waypoints = tourData.tour.stops.slice(1, -1).map(stop => ({
          location: { lat: stop.latitude, lng: stop.longitude },
          stopover: true,
        }))

        const firstStop = tourData.tour.stops[0]
        const lastStop = tourData.tour.stops[tourData.tour.stops.length - 1]

        const request = {
          origin: { lat: firstStop.latitude, lng: firstStop.longitude },
          destination: {
            lat: lastStop.latitude,
            lng: lastStop.longitude
          },
          waypoints: waypoints,
          travelMode: google.maps.TravelMode.WALKING,
        }

        directionsService.route(request, (result, status) => {
          if (status === 'OK' && result) {
            directionsRenderer.setDirections(result)
            console.log('[TourPlayer] Walking route loaded successfully')
          } else {
            console.error('[TourPlayer] Directions request failed:', status)
          }
        })
      }
    }

    loadMap()
  }, [tourData?.tour])

  const toggleScript = (key: string) => {
    const newExpanded = new Set(expandedScripts)
    if (newExpanded.has(key)) {
      newExpanded.delete(key)
    } else {
      newExpanded.add(key)
    }
    setExpandedScripts(newExpanded)
  }

  const toggleDirections = (index: number) => {
    const newExpanded = new Set(expandedDirections)
    if (newExpanded.has(index)) {
      newExpanded.delete(index)
    } else {
      newExpanded.add(index)
    }
    setExpandedDirections(newExpanded)
  }

  const handlePlayPause = (key: string, url: string) => {
    const audio = audioRefs.current[key]

    if (currentlyPlaying === key) {
      // Pause current
      audio?.pause()
      setCurrentlyPlaying(null)
      // Clear media session
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused'
      }
    } else {
      // Pause all others
      Object.values(audioRefs.current).forEach(a => a?.pause())

      // Play this one
      if (!audio) {
        const newAudio = new Audio(url)
        audioRefs.current[key] = newAudio
        newAudio.onended = () => {
          setCurrentlyPlaying(null)
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'none'
          }
        }
        
        // Set up media session
        setupMediaSession(newAudio, key)
        newAudio.play()
      } else {
        setupMediaSession(audio, key)
        audio.play()
      }
      setCurrentlyPlaying(key)
    }
  }

  const setupMediaSession = (audio: HTMLAudioElement, key: string) => {
    if ('mediaSession' in navigator) {
      // Get title based on key
      const title = key === 'intro' ? 'Introduction' : 
        key.startsWith('stop-') ? tourData?.tour?.stops[parseInt(key.split('-')[1])]?.name || 'Stop' : 'Audio'
      
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: tourData?.title || 'Hear & There',
        album: 'Audio Tour',
      })

      navigator.mediaSession.setActionHandler('play', () => {
        audio.play()
        setCurrentlyPlaying(key)
        navigator.mediaSession.playbackState = 'playing'
      })

      navigator.mediaSession.setActionHandler('pause', () => {
        audio.pause()
        setCurrentlyPlaying(null)
        navigator.mediaSession.playbackState = 'paused'
      })

      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime) {
          audio.currentTime = details.seekTime
        }
      })

      navigator.mediaSession.playbackState = 'playing'
    }
  }

  const handleSubmitFeedback = async () => {
    if (!tourId || !rating) return

    setFeedbackSubmitting(true)

    try {
      const response = await fetch(`${API_BASE_URL}/api/tour/${tourId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating,
          feedback: feedback.trim() || null,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to submit feedback')
      }

      setFeedbackSubmitted(true)
    } catch (err) {
      console.error('Failed to submit feedback:', err)
      alert('Failed to submit feedback. Please try again.')
    } finally {
      setFeedbackSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fefaf6] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-600">Loading tour...</p>
        </div>
      </div>
    )
  }

  if (error || !tourData) {
    return (
      <div className="min-h-screen bg-[#fefaf6] flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-lg mb-4">❌ {error || 'Tour not found'}</p>
          <a href="/" className="text-sky-600 hover:underline">Go back home</a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#fefaf6] text-slate-900">
      {/* Floating Tour Title */}
      <div className="sticky top-0 z-20 bg-white/35 backdrop-blur-sm border-b border-sky-100 shadow-sm">
        <div className="w-full max-w-4xl mx-auto px-4 py-4">
          <h2 className="text-3xl font-normal text-slate-900 text-center tracking-wider">
            {tourData.title}
          </h2>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Header Info */}
        <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
          <div className="text-center mb-6">
            <div className="flex items-center justify-center gap-4 text-xs text-slate-500 mb-4">
              <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-3 py-1 font-semibold uppercase tracking-wide text-sky-700 text-base">
                {tourData.theme}
              </span>
              <span>⏱️ ~{tourData.estimatedTotalMinutes} min</span>
              <span>📍 {tourData.tour?.stops.length || 0} stops</span>
            </div>
            <p className="text-base text-slate-600">{tourData.abstract}</p>
          </div>

          {/* Map */}
          <div
            ref={mapRef}
            className="w-full h-96 rounded-xl border border-slate-200 bg-slate-100 mb-6"
          />
        </div>

        {/* Audio Player */}
        {tourData.status === 'generating' && (
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

        {tourData.status === 'failed' && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <div className="rounded-2xl border border-red-200 bg-red-50/50 p-6">
              <h3 className="text-sm font-semibold text-red-900 mb-4">
                ❌ Audioguide Generation Failed
              </h3>
              <p className="text-xs text-red-700">
                {tourData.error || 'An error occurred while generating the audioguide'}
              </p>
            </div>
          </div>
        )}

        {/* Audio Files */}
        {tourData.status === 'complete' && tourData.audioFiles && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <h2 className="text-2xl font-semibold text-slate-900 mb-6">🎧 Audioguide</h2>

            <div className="relative pl-8">
              {/* Vertical Timeline */}
              <div className="absolute left-3 top-0 bottom-0 w-0.5 bg-neutral-300"></div>

              <div className="space-y-6">
                {/* Intro */}
                {tourData.audioFiles.intro && (
                  <div className="relative">
                    {/* Timeline Circle */}
                    <div className="absolute -left-[33px] top-6 w-7 h-7 rounded-full bg-neutral-400 border-3 border-white"></div>

                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex items-start gap-4">
                        {tourData.audioFiles?.intro?.status === "generating" ? (
                          <div className="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin shrink-0" />
                        ) : tourData.audioFiles?.intro?.url ? (
                          <button
                            onClick={() => handlePlayPause("intro", tourData.audioFiles!.intro!.url!)}
                            className="w-10 h-10 rounded-full bg-slate-900 text-white flex items-center justify-center hover:bg-slate-800 transition shrink-0"
                          >
                            {currentlyPlaying === "intro" ? <Pause size={20} /> : <Play size={20} />}
                          </button>
                        ) : null}

                        <div className="flex-1">
                          <h3 className="text-lg font-semibold text-slate-900">Introduction</h3>
                          <p className="text-xs text-slate-500">Welcome to your tour</p>
                        </div>

                        {tourData.scripts?.intro && (
                          <button
                            onClick={() => toggleScript("intro")}
                            className="text-xs text-slate-400 hover:text-slate-600 transition flex items-center gap-1"
                          >
                             <span>{expandedScripts.has("intro") ? 'hide script' : 'show script'}</span>
                             {expandedScripts.has("intro") ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </button>
                        )}
                      </div>

                      {tourData.scripts?.intro && expandedScripts.has("intro") && (
                        <div className="mt-4 pt-4 border-t border-slate-100">
                          <div className="p-4 bg-slate-50 rounded-lg text-base text-slate-700 leading-relaxed">
                            {tourData.scripts.intro.content}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              {/* Walking Directions from Starting Point to First Stop */}
              {tourData.tour && tourData.tour.stops.length > 0 && tourData.tour.stops[0].walkingDirections && (
                <div className="my-4 mx-8">
                  <button
                    onClick={() => toggleDirections(-1)}
                    className="text-xs text-slate-400 hover:text-slate-600 transition flex items-center gap-1"
                  >
                    <span>{expandedDirections.has(-1) ? '▼' : '▶'}</span>
                    <span>{expandedDirections.has(-1) ? 'hide directions' : 'show walking directions to the first stop'}</span>
                  </button>
                  {expandedDirections.has(-1) && (
                    <div className="mt-2 p-4 bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl border border-emerald-200/50">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-lg">🚶</span>
                        <div>
                          <p className="text-xs text-emerald-900 font-semibold">
                            Walking to {tourData.tour.stops[0].name}
                          </p>
                          <p className="text-[10px] text-emerald-700">
                            {tourData.tour.stops[0].walkingDirections.distance} · {tourData.tour.stops[0].walkingDirections.duration}
                          </p>
                        </div>
                      </div>
                      <ol className="space-y-2 pl-1">
                        {tourData.tour.stops[0].walkingDirections.steps.map((step, stepIdx) => (
                          <li key={stepIdx} className="text-[11px] text-emerald-800 flex gap-2">
                            <span className="font-semibold text-emerald-600 min-w-[16px]">{stepIdx + 1}.</span>
                            <div className="flex-1">
                              <span dangerouslySetInnerHTML={{ __html: step.instruction }} />
                              <span className="text-emerald-600 ml-1">({step.distance})</span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}

                {/* Stops */}
                {tourData.tour?.stops.map((stop, index) => {
                  const audioFile = tourData.audioFiles?.stops?.[index]
                  const script = tourData.scripts?.stops?.[index]
                  const audioKey = `stop-${index}`

                  return (
                    <div key={index} className="relative">
                      {/* Timeline Marker with Number */}
                      <div className="absolute -left-[33px] top-6 w-7 h-7 rounded-full bg-neutral-400 border-3 border-white flex items-center justify-center">
                        <span className="text-white text-xs font-bold">{index + 1}</span>
                      </div>

                      {/* Stop Card */}
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="flex items-center gap-3">
                          {audioFile?.status === 'generating' ? (
                            <div className="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                          ) : audioFile?.url ? (
                            <button
                              onClick={() => handlePlayPause(audioKey, audioFile.url!)}
                              className="w-10 h-10 rounded-full bg-slate-900 text-white flex items-center justify-center hover:bg-slate-800 transition shrink-0"
                            >
                              {currentlyPlaying === audioKey ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
                            </button>
                          ) : null}
                          <div className="flex-1">
                            <h3 className="text-normal font-semibold text-slate-900">
                              {stop.name}
                            </h3>
                            {stop.dwellMinutes > 0 && (
                              <p className="text-xs text-slate-500">
                                {stop.dwellMinutes} minutes
                              </p>
                            )}
                          </div>
                          {script && (
                            <button
                              onClick={() => toggleScript(audioKey)}
                              className="text-xs text-slate-400 hover:text-slate-600 transition flex items-center gap-1"
                            >
                              <span>{expandedScripts.has(audioKey) ? 'hide script' : 'show script'}</span>
                              {expandedScripts.has(audioKey) ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </button>
                          )}
                        </div>

                        {script && expandedScripts.has(audioKey) && (
                          <div className="mt-3 pt-3 border-t border-slate-100">
                            <div className="p-4 bg-slate-50 rounded-lg text-base text-slate-700 leading-relaxed">
                              {script.content}
                            </div>
                          </div>
                        )}
                      </div>

                    {/* Walking Directions - Floating between stops */}
                    {index < tourData.tour!.stops.length - 1 && tourData.tour!.stops[index + 1].walkingDirections && (
                      <div className="my-4 mx-8">
                        <button
                          onClick={() => toggleDirections(index)}
                          className="text-xs text-slate-400 hover:text-slate-600 transition flex items-center gap-1"
                        >
                          <span>{expandedDirections.has(index) ? '▼' : '▶'}</span>
                          <span>{expandedDirections.has(index) ? 'hide directions' : 'show walking directions'}</span>
                        </button>
                        {expandedDirections.has(index) && (
                          <div className="mt-2 p-4 bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl border border-emerald-200/50">
                            <div className="flex items-center gap-2 mb-3">
                              <span className="text-lg">🚶</span>
                              <div>
                                <p className="text-xs text-emerald-900 font-semibold">
                                  Walking to {tourData.tour!.stops[index + 1].name}
                                </p>
                                <p className="text-[10px] text-emerald-700">
                                  {tourData.tour!.stops[index + 1].walkingDirections?.distance} · {tourData.tour!.stops[index + 1].walkingDirections?.duration}
                                </p>
                              </div>
                            </div>
                            <ol className="space-y-2 pl-1">
                              {tourData.tour!.stops[index + 1].walkingDirections?.steps.map((step, stepIdx) => (
                                <li key={stepIdx} className="text-[11px] text-emerald-800 flex gap-2">
                                  <span className="font-semibold text-emerald-600 min-w-[16px]">{stepIdx + 1}.</span>
                                  <div className="flex-1">
                                    <span dangerouslySetInnerHTML={{ __html: step.instruction }} />
                                    <span className="text-emerald-600 ml-1">({step.distance})</span>
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Feedback Section */}
        {tourData.status === 'complete' && (
          <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">💬 Share Your Feedback</h2>

            {!feedbackSubmitted ? (
              <div className="space-y-4">
                <p className="text-xs text-slate-600">
                  How was your experience with this audioguide? Your feedback helps us improve!
                </p>

                {/* Star Rating */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Rating</label>
                  <div className="flex items-center gap-2">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setRating(star)}
                        onMouseEnter={() => setHoveredRating(star)}
                        onMouseLeave={() => setHoveredRating(0)}
                        disabled={feedbackSubmitting}
                        className="text-3xl transition-all duration-150 hover:scale-110 disabled:cursor-not-allowed"
                      >
                        {star <= (hoveredRating || rating) ? (
                          <span className="text-yellow-400">★</span>
                        ) : (
                          <span className="text-slate-300">☆</span>
                        )}
                      </button>
                    ))}
                    {rating > 0 && (
                      <span className="ml-2 text-sm text-slate-600">
                        {rating} {rating === 1 ? 'star' : 'stars'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Feedback Text (Optional) */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Comments <span className="text-slate-400 font-normal">(optional)</span>
                  </label>
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Share your thoughts about the tour, audio quality, directions, or anything else..."
                    className="w-full px-4 py-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent resize-none"
                    rows={4}
                    disabled={feedbackSubmitting}
                  />
                </div>

                <button
                  onClick={handleSubmitFeedback}
                  disabled={!rating || feedbackSubmitting}
                  className="inline-flex items-center justify-center rounded-xl bg-[#f36f5e] px-6 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {feedbackSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                      Submitting...
                    </>
                  ) : (
                    'Submit Feedback'
                  )}
                </button>
              </div>
            ) : (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-6 text-center">
                <p className="text-sm font-semibold text-emerald-900 mb-2">✓ Thank you!</p>
                <p className="text-xs text-emerald-700">
                  Your feedback has been submitted and will help us improve future tours.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Version Display */}
        <div className="mt-8 text-center space-y-1">
          {tourData && (
            <p className="text-xs text-slate-300 font-light">{tourData.tourId}</p>
          )}
          <p className="text-xs text-slate-300 font-light">v{FRONTEND_VERSION}</p>
        </div>
      </div>
    </div>
  )
}

