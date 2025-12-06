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
  expectedTourCount = 4 // Default to 4 tours
}: TourSuggestionsProps) {
  // Calculate how many loading cards to show
  const loadingCardsToShow = isLoading ? Math.max(0, expectedTourCount - tours.length) : 0

  // Get the icon component from lucide-react
  const getIconComponent = (iconName: string) => {
    if (!iconName) return null

    // Convert kebab-case to PascalCase (e.g., "map-pin" -> "MapPin")
    const pascalCase = iconName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('')

    // Get the icon from lucide-react
    const IconComponent = (LucideIcons as any)[pascalCase]
    return IconComponent || null
  }

  const IconComponent = getIconComponent(loadingIcon)

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
              <span className="w-4 h-4 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></span>
              {IconComponent && <IconComponent className="w-4 h-4 text-sky-500" />}
              {loadingStatus}
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
                  onClick={() => onSelectTour(tour)}
                  className="inline-flex w-full items-center justify-center rounded-xl bg-[#f36f5e] px-3 py-2 text-xs font-semibold text-white shadow-[#f36f5e]/40 transition hover:bg-[#e35f4f]"
                >
                  {selectedTourId === tour.id ? 'Selected' : 'Select this tour'}
                </button>
              </article>
            ))}

            {/* Show loading cards for remaining tours */}
            {Array.from({ length: loadingCardsToShow }).map((_, idx) => (
              <TourLoadingCard key={`loading-${tours.length + idx}`} tourNumber={tours.length + idx + 1} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

