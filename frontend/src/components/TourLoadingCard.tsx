import * as LucideIcons from 'lucide-react'

type TourLoadingCardProps = {
  tourNumber: number
  interestingMessage?: { icon: string; message: string } | null
}

export function TourLoadingCard({ tourNumber, interestingMessage }: TourLoadingCardProps) {
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

  const IconComponent = interestingMessage ? getIconComponent(interestingMessage.icon) : null

  // Debug logging
  console.log(`[TourLoadingCard #${tourNumber}]`, {
    hasInterestingMessage: !!interestingMessage,
    icon: interestingMessage?.icon,
    hasIconComponent: !!IconComponent,
    messagePreview: interestingMessage?.message?.substring(0, 50) + '...'
  })

  return (
    <article className="min-w-[260px] flex-1 rounded-2xl border border-slate-200 px-4 py-4 bg-white/90 animate-pulse">
      <div className="flex items-center justify-center h-full min-h-[300px]">
        {interestingMessage && IconComponent ? (
          // Show interesting message with large icon
          <div className="text-center px-4 py-8">
            <IconComponent className="w-24 h-24 text-slate-900 mx-auto mb-6" strokeWidth={1.5} />
            <p className="text-lg leading-relaxed text-slate-700 font-medium">
              {interestingMessage.message}
            </p>
          </div>
        ) : (
          // Show default loading state with number
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
        )}
      </div>
    </article>
  )
}

