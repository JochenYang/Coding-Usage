import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface StatCardProps {
  title: string
  icon: LucideIcon
  iconClassName?: string
  /** Fully replaces the default icon chip when provided (e.g. brand logos) */
  iconSlot?: ReactNode
  value: string
  /** Fully replaces the value line when provided (e.g. to wrap it in a tooltip) */
  valueSlot?: ReactNode
  footer?: ReactNode
  /**
   * Decorative brand illustration for the card's free bottom-right corner
   * (overview KPI cards, see DESIGN_SYSTEM §1.2). Purely visual: it sits
   * under the text, ignores the pointer and is hidden from assistive tech.
   */
  illustration?: ReactNode
  className?: string
}

/** Metric card: title + icon chip, large tabular value, optional footer line */
export function StatCard({
  title,
  icon,
  iconClassName,
  iconSlot,
  value,
  valueSlot,
  footer,
  illustration,
  className,
}: StatCardProps) {
  const Icon = icon

  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-card p-5',
        // Below xl the KPI cards are not stretched by the trend card beside
        // them, so the card has to make room for the illustration itself:
        // 4px clear of the footer + the 68px art + its 2px inset. Under sm the
        // art is not shown (enhancement), so neither is the room.
        illustration && 'relative isolate sm:pb-[74px]',
        className,
      )}
    >
      {/* The clipping edge belongs to this layer, not to the card: an
          illustration bleeding past the corner is cut to the radius, while
          the card itself keeps overflow visible for focus rings and bubbles
          anchored inside it (same split as CardWatermark) */}
      {illustration && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl max-sm:hidden"
        >
          <div className="absolute inset-x-0 bottom-0 flex justify-end">{illustration}</div>
        </div>
      )}
      <div className={cn(illustration && 'relative z-20')}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{title}</span>
          {iconSlot ?? (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft">
              <Icon className={cn('h-4 w-4 text-accent', iconClassName)} />
            </div>
          )}
        </div>
        {valueSlot ?? (
          <div className="mt-2 text-[28px] font-semibold leading-tight tabular-nums text-foreground">
            {value}
          </div>
        )}
        {footer && <div className="mt-1 text-xs">{footer}</div>}
      </div>
    </div>
  )
}
