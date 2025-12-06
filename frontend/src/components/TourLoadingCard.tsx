type TourLoadingCardProps = {
  tourNumber: number
}

export function TourLoadingCard({ tourNumber }: TourLoadingCardProps) {
  return (
    <article className="min-w-[260px] flex-1 rounded-2xl border border-slate-200 px-4 py-4 bg-white/90 animate-pulse">
      <div className="flex items-center justify-center h-full min-h-[300px]">
        <div className="text-center">
          <div className="relative inline-block">
            {/* Pulsing background circle */}
            <div className="absolute inset-0 rounded-full bg-sky-200 opacity-30"></div>

            {/* Main number */}
            <div className="relative w-32 h-32 rounded-full border-4 border-sky-300 bg-sky-50 flex items-center justify-center">
              <span className="text-6xl font-bold text-sky-600">{tourNumber}</span>
            </div>
          </div>

          <p className="mt-4 text-xs text-slate-500">Loading tour...</p>
        </div>
      </div>
    </article>
  )
}

