import { TourLoadingCard } from './TourLoadingCard'
import * as LucideIcons from 'lucide-react'

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

type TourSuggestionsProps = {
  tours: Tour[]
  selectedTourId: string | null
  onSelectTour: (tour: Tour) => void
  onGoBack: () => void
  neighborhood: string | null
  city: string | null
  isLoading: boolean
  loadingStatus: string
  loadingIcon: string
  expectedTourCount?: number // Expected total number of tours (for progressive loading)
  interestingMessages?: Array<{ icon: string; message: string }>
  currentMessageIndex?: number
}

export function TourSuggestions({
  tours,
  selectedTourId,
  onSelectTour,
  onGoBack,
  neighborhood,
  city,
  isLoading,
  loadingStatus,
  loadingIcon,
  expectedTourCount = 4, // Default to 4 tours
  interestingMessages = [],
  currentMessageIndex = 0
}: TourSuggestionsProps) {
  // Calculate how many loading cards to show
  const loadingCardsToShow = isLoading ? Math.max(0, expectedTourCount - tours.length) : 0

  // Get current interesting message for the first loading card
  const currentInterestingMessage = interestingMessages.length > 0
    ? interestingMessages[currentMessageIndex % interestingMessages.length]
    : null

  return (
    <div className="rounded-3xl bg-white/80 shadow-lg shadow-sky-900/5 border border-sky-900/5 p-8">
      <button
        type="button"
        onClick={onGoBack}
        className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-slate-600 hover:text-slate-900 transition"
      >
        <span>←</span>
        <span>Go Back</span>
      </button>

      <header className="mb-6 text-center">
        <h1 className="text-3xl font-semibold text-slate-900 mb-2">
          {isLoading ? 'Preparing Your Tours' : 'Choose Your Tour'}
        </h1>
        <p className="text-sm text-slate-600">
          {isLoading ? (
            <span className="inline-flex items-center gap-2">
              <span className="relative flex size-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75"></span>
                <span className="relative inline-flex size-3 rounded-full bg-sky-500"></span>
              </span>
              Looking around you...
            </span>
          ) : (
            neighborhood || city
              ? `Starting near ${neighborhood || city}.`
              : 'Here are a few routes we prepared for you.'
          )}
        </p>
      </header>

      <div className="space-y-4">
        <div className="-mx-4 overflow-x-auto pb-2">
          <div className="flex gap-4 px-1">
            {/* Show actual tours */}
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
                  {tour.stops.map((stop, idx) => {
                    const walkText = stop.walkMinutesFromPrevious > 0 ? `walk ${stop.walkMinutesFromPrevious} min` : null
                    const dwellText = stop.dwellMinutes > 0 ? `dwell ${stop.dwellMinutes} min` : null
                    const details = [walkText, dwellText].filter(Boolean).join(' · ')

                    return (
                      <li key={`${tour.id}-stop-${idx}`} className="flex gap-2">
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

                <button
                  type="button"
                  onClick={() => onSelectTour(tour)}
                  className="inline-flex w-full items-center justify-center rounded-xl bg-[#f36f5e] px-3 py-2 text-xs font-semibold text-white shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
                >
                  {selectedTourId === tour.id ? 'Selected' : 'Select this tour'}
                </button>
              </article>
            ))}

            {/* Show loading cards for remaining tours */}
            {Array.from({ length: loadingCardsToShow }).map((_, idx) => {
              // Show interesting message in the first loading card only
              const isFirstCard = tours.length === 0 && idx === 0
              const messageToShow = isFirstCard ? currentInterestingMessage : null

              return (
                <TourLoadingCard
                  key={`loading-${tours.length + idx}`}
                  tourNumber={tours.length + idx + 1}
                  interestingMessage={messageToShow}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

