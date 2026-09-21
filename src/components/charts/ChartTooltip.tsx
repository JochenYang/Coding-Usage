import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'

/** One value row of a hover bubble */
export interface TooltipRow {
  label: string
  value: string
  /** A CSS colour reference (a var(--color-*) token); omit for rows that are not
      tied to a plotted series (e.g. a per-model breakdown of one point) */
  color?: string
  /** Must match the series' legend swatch */
  shape?: 'dot' | 'square'
}

export interface ChartTooltipProps {
  title: string
  rows: TooltipRow[]
  /** Optional footnote (e.g. "this figure is estimated") */
  note?: string
  className?: string
  style?: CSSProperties
}

/** Fraction of the plot width inside which a bubble pins to the nearer edge */
const EDGE = 0.15

/**
 * Hover bubble shared by every chart.
 *
 * Rendered as HTML rather than SVG text so the type stays at a fixed size while
 * the SVG scales with the card. The chart that owns the hover state positions
 * it; the bubble only decides what a row looks like, which is what keeps the
 * tooltips of different charts identical.
 */
export function ChartTooltip({ title, rows, note, className, style }: ChartTooltipProps) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute z-10 min-w-36 max-w-56 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-lg',
        className,
      )}
      style={style}
    >
      <div className="truncate font-medium tabular-nums text-foreground">{title}</div>
      {rows.length > 0 && (
        <div className="mt-1 space-y-0.5 border-t border-border/60 pt-1 text-muted-foreground">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 tabular-nums">
              <span className="flex min-w-0 items-center gap-1.5">
                {/* The swatch is only drawn for rows tied to a plotted series.
                    Rendering it unconditionally left a colourless 8px box plus
                    its gap on rows that have no colour, which read as an
                    unexplained indent. */}
                {row.color !== undefined && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'shrink-0',
                      row.shape === 'square' ? 'h-2 w-2 rounded-[3px]' : 'h-2 w-2 rounded-full',
                    )}
                    style={{ backgroundColor: row.color }}
                  />
                )}
                <span className="truncate">{row.label}</span>
              </span>
              <span className="text-foreground/90">{row.value}</span>
            </div>
          ))}
        </div>
      )}
      {note && <div className="mt-1 whitespace-normal text-[10px] text-subtle">{note}</div>}
    </div>
  )
}

/**
 * Placement for a hover bubble anchored at `anchorX` (a 0..1 fraction of the
 * plot width). Near either edge the bubble pins to that side instead of
 * centring, so it can never overflow the card; `top` is passed through as given
 * because each chart anchors to a different line (plot top vs. the hovered
 * point). `offsetY` is the gap kept from that anchor.
 */
export function tooltipAnchor(
  anchorX: number,
  top: string,
  offsetY = 6,
): { className: string; style: CSSProperties } {
  if (anchorX < EDGE) {
    return { className: 'left-0', style: { top, transform: `translateY(${offsetY}px)` } }
  }
  if (anchorX > 1 - EDGE) {
    return { className: 'right-0', style: { top, transform: `translateY(${offsetY}px)` } }
  }
  return {
    className: '',
    style: { top, left: `${anchorX * 100}%`, transform: `translate(-50%, ${offsetY}px)` },
  }
}
