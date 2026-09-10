import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { formatCompactValue } from '@/lib/format'
import type { HeatCell } from '@/lib/heatmap'

export interface HeatmapProps {
  /** Week columns, oldest first; each column holds 7 Monday-first cells */
  cells: HeatCell[][]
  /** Short month label for a column head (locale-driven by the caller) */
  formatMonth: (date: Date) => string
  /** Optional formatter for cell values (defaults to formatCompactValue) */
  formatValue?: (n: number) => string
  /** Accessible description announced for the chart image role */
  ariaLabel?: string
  /** Extra classes appended to the wrapper div */
  className?: string
}

/** GitHub-style cell geometry */
const CELL = 11
const GAP = 3
const STEP = CELL + GAP
const LABEL_H = 16

/** Fill scale shared with the legend (level 0-4, theme-aware via tokens) */
export const HEAT_FILLS = [
  'fill-muted',
  'fill-accent/20',
  'fill-accent/45',
  'fill-accent/70',
  'fill-accent',
] as const

/** HTML background twin of HEAT_FILLS for non-SVG surfaces (legend) */
export const HEAT_BGS = [
  'bg-muted',
  'bg-accent/20',
  'bg-accent/45',
  'bg-accent/70',
  'bg-accent',
] as const

function cellDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/**
 * Calendar heatmap (GitHub-contributions style): one column per week,
 * Monday-first rows, intensity relative to the window maximum. Hover shows
 * the exact day value in an HTML bubble (never a native tooltip).
 */
export function Heatmap({ cells, formatMonth, formatValue, ariaLabel, className }: HeatmapProps) {
  const fmt = formatValue ?? formatCompactValue
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null)
  // Stale hover must not survive a data refresh: the 30s auto-refresh swaps
  // the svg nodes out from under the pointer, mouseleave never fires on the
  // detached tree, and the bubble would float stuck over the card
  useEffect(() => {
    setHover(null)
  }, [cells])

  if (cells.length === 0) {
    return (
      <div
        role="img"
        aria-label={ariaLabel}
        className={cn('flex h-full min-h-[120px] items-center justify-center', className)}
      >
        <span className="text-xs text-subtle">&mdash;</span>
      </div>
    )
  }

  const W = cells.length * STEP - GAP
  const rows = cells[0]?.length ?? 0
  const H = rows * STEP - GAP + LABEL_H

  // Month tag per column: label when the column's first real day enters a
  // new month (ragged leading column inherits the tag of its first day).
  // Tags sit UNDER the grid like the reference design.
  let lastMonth = -1
  const monthTags = cells.map((col) => {
    const first = col.find((c) => c.day !== null)
    if (!first?.day) return ''
    const month = cellDate(first.day).getMonth()
    if (month === lastMonth) return ''
    lastMonth = month
    return formatMonth(cellDate(first.day))
  })

  const active = hover ? cells[hover.c]?.[hover.r] ?? null : null
  const ax = hover ? (hover.c * STEP + CELL / 2) / W : 0
  // Flip below whenever the headroom above the cell cannot fit the bubble.
  // A fixed ~36-unit budget covers the single-line bubble at any card width;
  // checking only row 0 missed rows 1-2, whose bubbles still bleed past the
  // grid top (same class of bug as LineChart's peak clipping).
  const NEED_UNITS = 36
  const below = hover != null && hover.r * STEP < NEED_UNITS
  const ay = hover && active ? (hover.r * STEP + (below ? CELL : 0)) / H : 0

  return (
    <div role="img" aria-label={ariaLabel} className={cn('relative w-max', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        aria-hidden="true"
        className="block"
        onMouseLeave={() => setHover(null)}
      >
        {monthTags.map((tag, c) =>
          tag ? (
            <text
              key={`m-${c}`}
              x={c * STEP}
              y={H - 4}
              fontSize={9}
              fill="var(--color-subtle)"
            >
              {tag}
            </text>
          ) : null,
        )}
        {cells.map((col, c) =>
          col.map((cell, r) =>
            cell.day === null ? null : (
              <rect
                key={`${cell.day}`}
                x={c * STEP}
                y={r * STEP}
                width={CELL}
                height={CELL}
                rx={2.5}
                className={cn(HEAT_FILLS[cell.level], 'cursor-pointer')}
                stroke={hover?.c === c && hover?.r === r ? 'var(--color-accent)' : 'none'}
                strokeWidth={hover?.c === c && hover?.r === r ? 1.5 : 0}
                onMouseEnter={() => setHover({ c, r })}
              />
            ),
          ),
        )}
      </svg>

      {active?.day && (
        <div
          className={cn(
            'pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium tabular-nums text-foreground shadow-md',
            ax < 0.15 ? 'left-0' : ax > 0.85 ? 'right-0' : '',
          )}
          style={{
            top: `${ay * 100}%`,
            ...(ax < 0.15 || ax > 0.85
              ? { transform: below ? 'translateY(8px)' : 'translateY(calc(-100% - 8px))' }
              : {
                  left: `${ax * 100}%`,
                  transform: below ? 'translate(-50%, 8px)' : 'translate(-50%, calc(-100% - 8px))',
                }),
          }}
        >
          {active.tip ?? active.day} · {fmt(active.value)}
        </div>
      )}
    </div>
  )
}
