import { cn } from '@/lib/cn'

/** One legend entry; the swatch shape follows the mark it explains */
export interface LegendItem {
  /** Stable identity for React keys */
  id: string
  label: string
  /** A CSS colour reference (a var(--color-*) token) */
  color: string
  /** 'square' for bars and stacks, 'dot' for lines (the default) */
  shape?: 'dot' | 'square'
  /** When set the entry becomes a toggle for that series */
  onClick?: () => void
  /** Toggle state; ignored when there is no onClick */
  active?: boolean
}

export interface ChartLegendProps {
  items: LegendItem[]
  className?: string
}

/**
 * Legend row drawn above a plot.
 *
 * Shared by every chart so a series always wears the same swatch shape and type
 * size wherever it appears. An entry with `onClick` doubles as the series
 * filter, which is why an off series dims instead of disappearing: the entry has
 * to stay reachable to switch it back on.
 */
export function ChartLegend({ items, className }: ChartLegendProps) {
  if (items.length === 0) return null

  return (
    <ul className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1', className)}>
      {items.map((item) => {
        const off = item.onClick != null && item.active === false
        const swatch = (
          <span
            aria-hidden="true"
            className={cn(
              'shrink-0 transition-opacity',
              item.shape === 'square' ? 'h-2.5 w-2.5 rounded-[3px]' : 'h-2 w-2 rounded-full',
            )}
            style={{ backgroundColor: item.color, opacity: off ? 0.3 : 1 }}
          />
        )
        const label = <span className="truncate">{item.label}</span>

        return (
          <li key={item.id} className="flex min-w-0">
            {item.onClick ? (
              <button
                type="button"
                aria-pressed={!off}
                onClick={item.onClick}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] transition-colors',
                  off ? 'text-subtle hover:text-muted-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {swatch}
                {label}
              </button>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {swatch}
                {label}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
