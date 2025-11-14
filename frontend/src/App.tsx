import { useCallback, useEffect, useState } from 'react'

const API_BASE_URL = import.meta.env.MODE === 'production'
  ? 'https://hear-and-there-production.up.railway.app'
  : 'http://localhost:4000';

const FRONTEND_VERSION = '1.0.2'; // Update this with each commit

type Status = 'idle' | 'saving' | 'success' | 'error'

function App() {
  const [latitude, setLatitude] = useState<number | ''>('')
  const [longitude, setLongitude] = useState<number | ''>('')
  const [durationMinutes, setDurationMinutes] = useState<number>(90)
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')
  const [sessionId, setSessionId] = useState<string | null>(null)

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
      (err) => {
        console.error('Geolocation error', err)
        setStatus('error')
        setMessage('Unable to retrieve your location. You can fill it in manually.')
      },
      {
        enableHighAccuracy: true,
        timeout: 10_000,
      },
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
    setMessage('Saving your tour preferences...')

    try {
      const response = await fetch(`${API_BASE_URL}/api/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ latitude, longitude, durationMinutes }),
      })

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }

      const data: { sessionId?: string; status?: string } = await response.json()

      if (!data.sessionId) {
        throw new Error('Missing sessionId in response')
      }

      setStatus('success')
      setSessionId(data.sessionId)
      setMessage('Session saved! Your journey is being prepared.')
    } catch (error) {
      console.error('Error saving session', error)
      setStatus('error')
      setMessage('Something went wrong while saving your session. Please try again.')
    }
  }

  useEffect(() => {
    if (status === 'success' || status === 'error') {
      const timeout = setTimeout(() => {
        setStatus('idle')
      }, 5000)
      return () => clearTimeout(timeout)
    }
  }, [status])

  return (
    <div className="min-h-screen bg-[#fefaf6] text-slate-900 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
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

        {(status !== 'idle' || message || sessionId) && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-700">
            {message && <p className="mb-1">{message}</p>}
            {sessionId && (
              <p className="font-mono text-[11px] text-slate-500">
                sessionId: <span className="font-semibold text-sky-700">{sessionId}</span>
              </p>
            )}
          </div>
        )}
      </div>
      <div className="mt-8 text-center">
        <p className="text-xs text-slate-300 font-light">
          v{FRONTEND_VERSION}
        </p>
      </div>
    </div>
  )
}

export default App
