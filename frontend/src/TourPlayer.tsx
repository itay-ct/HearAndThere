import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY

interface Stop {
  name: string
  placeId: string
  location: { lat: number; lng: number }
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

      const map = new google.maps.Map(mapRef.current!, {
        zoom: 14,
        center: tourData.tour.stops[0].location,
      })

      mapInstanceRef.current = map

      // Add markers for each stop
      tourData.tour.stops.forEach((stop, index) => {
        new google.maps.Marker({
          position: stop.location,
          map,
          label: `${index + 1}`,
          title: stop.name,
        })
      })

      // Draw route
      const path = tourData.tour.stops.map(stop => stop.location)
      new google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#f36f5e',
        strokeOpacity: 1.0,
        strokeWeight: 3,
        map,
      })
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
    } else {
      // Pause all others
      Object.values(audioRefs.current).forEach(a => a?.pause())

      // Play this one
      if (!audio) {
        const newAudio = new Audio(url)
        audioRefs.current[key] = newAudio
        newAudio.onended = () => setCurrentlyPlaying(null)
        newAudio.play()
      } else {
        audio.play()
      }
      setCurrentlyPlaying(key)
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
    <div className="min-h-screen bg-[#fefaf6] text-slate-900 px-4 py-10">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
          <div className="text-center mb-6">
            <p className="text-xs font-semibold tracking-[0.3em] uppercase text-sky-700 mb-2">
              Hear &amp; There
            </p>
            <h1 className="text-3xl font-semibold text-slate-900 mb-2">{tourData.title}</h1>
            <p className="text-sm text-slate-600 mb-4">{tourData.abstract}</p>
            <div className="flex items-center justify-center gap-4 text-xs text-slate-500">
              <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-3 py-1 font-semibold uppercase tracking-wide text-sky-700">
                {tourData.theme}
              </span>
              <span>⏱️ ~{tourData.estimatedTotalMinutes} min</span>
              <span>📍 {tourData.tour?.stops.length || 0} stops</span>
            </div>
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
            <h2 className="text-xl font-semibold text-slate-900 mb-6">🎧 Audioguide</h2>

            <div className="space-y-4">
              {/* Intro */}
              {tourData.audioFiles.intro && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center gap-3 mb-3">
                    {tourData.audioFiles.intro.status === 'generating' ? (
                      <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                    ) : tourData.audioFiles.intro.url ? (
                      <button
                        onClick={() => handlePlayPause('intro', tourData.audioFiles!.intro!.url!)}
                        className="w-8 h-8 rounded-full bg-[#f36f5e] text-white flex items-center justify-center hover:bg-[#e35f4f] transition"
                      >
                        {currentlyPlaying === 'intro' ? '⏸' : '▶'}
                      </button>
                    ) : null}
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-slate-900">Introduction</h3>
                      <p className="text-xs text-slate-500">Welcome to your tour</p>
                    </div>
                  </div>

                  {tourData.scripts?.intro && (
                    <div className="mt-3">
                      <button
                        onClick={() => toggleScript('intro')}
                        className="text-xs text-sky-600 hover:text-sky-800 font-medium"
                      >
                        {expandedScripts.has('intro') ? '▼ Hide script' : '▶ Show script'}
                      </button>
                      {expandedScripts.has('intro') && (
                        <div className="mt-2 p-3 bg-slate-50 rounded-lg text-xs text-slate-700 leading-relaxed">
                          {tourData.scripts.intro.content}
                        </div>
                      )}
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
                  <div key={index} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center gap-3 mb-3">
                      {audioFile?.status === 'generating' ? (
                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                      ) : audioFile?.url ? (
                        <button
                          onClick={() => handlePlayPause(audioKey, audioFile.url!)}
                          className="w-8 h-8 rounded-full bg-[#f36f5e] text-white flex items-center justify-center hover:bg-[#e35f4f] transition"
                        >
                          {currentlyPlaying === audioKey ? '⏸' : '▶'}
                        </button>
                      ) : null}
                      <div className="flex-1">
                        <h3 className="text-sm font-semibold text-slate-900">
                          {index + 1}. {stop.name}
                        </h3>
                        <p className="text-xs text-slate-500">
                          Dwell {stop.dwellMinutes} min
                        </p>
                      </div>
                    </div>

                    {script && (
                      <div className="mt-3">
                        <button
                          onClick={() => toggleScript(audioKey)}
                          className="text-xs text-sky-600 hover:text-sky-800 font-medium"
                        >
                          {expandedScripts.has(audioKey) ? '▼ Hide script' : '▶ Show script'}
                        </button>
                        {expandedScripts.has(audioKey) && (
                          <div className="mt-2 p-3 bg-slate-50 rounded-lg text-xs text-slate-700 leading-relaxed">
                            {script.content}
                          </div>
                        )}
                      </div>
                    )}

                    {stop.walkingDirections && index < tourData.tour!.stops.length - 1 && (
                      <div className="mt-3">
                        <button
                          onClick={() => toggleDirections(index)}
                          className="text-xs text-emerald-600 hover:text-emerald-800 font-medium"
                        >
                          {expandedDirections.has(index) ? '▼ Hide directions' : '▶ Show directions to next stop'}
                        </button>
                        {expandedDirections.has(index) && (
                          <div className="mt-2 p-3 bg-emerald-50 rounded-lg">
                            <p className="text-xs text-emerald-900 font-semibold mb-2">
                              Walking to {tourData.tour!.stops[index + 1].name}
                            </p>
                            <p className="text-xs text-emerald-700 mb-2">
                              {stop.walkingDirections.distance} · {stop.walkingDirections.duration}
                            </p>
                            <ol className="space-y-1">
                              {stop.walkingDirections.steps.map((step, stepIdx) => (
                                <li key={stepIdx} className="text-xs text-emerald-800">
                                  <span className="font-semibold">{stepIdx + 1}.</span>{' '}
                                  <span dangerouslySetInnerHTML={{ __html: step.instruction }} />
                                  {' '}
                                  <span className="text-emerald-600">({step.distance})</span>
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
        )}
      </div>
    </div>
  )
}

