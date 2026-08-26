import { useId, useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { formatCompactValue } from './DonutChart'

export interface LineChartPoint {
  label: string
  value: number
}

export interface LineChartProps {
  /** Data points in drawing order; at least 2 are required to draw */
  points: LineChartPoint[]
  /** Chart height in viewBox units, drives the aspect ratio (default 220) */
  height?: number
  /** Optional formatter for y-axis ticks and point tooltips (defaults to formatCompactValue) */
  formatValue?: (n: number) => string
  /** Accessible description announced for the chart image role */
  ariaLabel?: string
  /** Extra classes appended to the wrapper div */
  className?: string
}

/** Fixed viewBox width; the SVG scales proportionally via width="100%" */
const W = 560

/** Inner padding: left hosts y ticks, bottom hosts x labels */
const PAD = { left: 44, right: 10, top: 10, bottom: 24 } as const

/** Approximate number of horizontal grid lines */
const TICK_COUNT = 4

/** Maximum x-axis labels rendered (evenly thinned) so dates never crowd */
const MAX_X_LABELS = 7

/**
 * Build "nice" ticks (steps of 1/2/5 x 10^k) from 0 up to a rounded max
 * covering `max`. A non-positive max falls back to 1.
 */
function niceTicks(max: number): number[] {
  const safeMax = max > 0 ? max : 1
  const rawStep = safeMax / TICK_COUNT
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  const step = factor * magnitude
  const steps = Math.ceil(safeMax / step)
  return Array.from({ length: steps + 1 }, (_, i) => i * step)
}

/** Round to 2 decimals to keep path data compact and stable */
function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Area line chart with hover crosshair + value tooltip.
 * X labels are thinned to stay readable, y ticks use the compact formatter.
 */
export function LineChart({
  points,
  height = 220,
  formatValue,
  ariaLabel,
  className,
}: LineChartProps) {
  // Hooks must run before the early empty-state return
  const rawId = useId()
  // Sanitize useId output so it is always safe inside url(#id) references
  const gradientId = `line-grad-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const fmt = formatValue ?? formatCompactValue
  const [hover, setHover] = useState<number | null>(null)

  if (points.length < 2) {
    return (
      <div
        role="img"
        aria-label={ariaLabel}
        className={cn('flex h-full min-h-[120px] items-center justify-center', className)}
      >
        {/* Empty state placeholder; callers own the real empty copy */}
        <span className="text-xs text-subtle">&mdash;</span>
      </div>
    )
  }

  const H = height
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const baselineY = PAD.top + innerH

  const ticks = niceTicks(Math.max(...points.map((p) => p.value)))
  const maxTick = ticks[ticks.length - 1]

  const xAt = (i: number) => PAD.left + (i / (points.length - 1)) * innerW
  const yAt = (v: number) => baselineY - (v / maxTick) * innerH

  const coords = points.map((p, i) => ({ x: xAt(i), y: yAt(p.value), point: p }))
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${r2(c.x)} ${r2(c.y)}`).join(' ')
  const areaPath = `${linePath} L${r2(coords[coords.length - 1].x)} ${r2(baselineY)} L${r2(coords[0].x)} ${r2(baselineY)} Z`

  // Evenly thin x labels: always show first/last, fill the middle evenly
  const labelIndexes = useMemo(() => {
    if (points.length <= MAX_X_LABELS) return points.map((_, i) => i)
    const out = new Set<number>([0, points.length - 1])
    for (let k = 1; k < MAX_X_LABELS - 1; k++) {
      out.add(Math.round((k * (points.length - 1)) / (MAX_X_LABELS - 1)))
    }
    return [...out].sort((a, b) => a - b)
  }, [points.length])

  // Map a mouse event to the nearest point index (SVG viewBox coords)
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * W
    let best = 0
    let bestDist = Infinity
    coords.forEach((c, i) => {
      const d = Math.abs(c.x - vbX)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    })
    setHover(best)
  }

  const active = hover != null ? coords[hover] : null

  return (
    <div role="img" aria-label={ariaLabel} className={cn('relative w-full', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        aria-hidden="true"
        className="block"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Horizontal dashed grid lines; the bottom baseline stays solid */}
        {ticks.map((t, i) => {
          const y = r2(yAt(t))
          return (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeDasharray={i === 0 ? undefined : '3 3'}
              />
              <text
                x={PAD.left - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize={10}
                fill="var(--color-subtle)"
              >
                {fmt(t)}
              </text>
            </g>
          )
        })}

        {/* Gradient area under the trend line */}
        <path d={areaPath} fill={`url(#${gradientId})`} />

        {/* Trend line */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* Data points */}
        {coords.map((c, i) => (
          <circle
            key={`${c.point.label}-${i}`}
            cx={r2(c.x)}
            cy={r2(c.y)}
            r={hover === i ? 4.5 : 3}
            fill="var(--color-accent)"
            stroke="var(--color-card)"
            strokeWidth={2}
          >
            <title>{`${c.point.label}: ${fmt(c.point.value)}`}</title>
          </circle>
        ))}

        {/* Hover crosshair + highlighted point (bubble lives in HTML below) */}
        {active && (
          <g>
            <line
              x1={r2(active.x)}
              x2={r2(active.x)}
              y1={PAD.top}
              y2={baselineY}
              stroke="var(--color-accent)"
              strokeOpacity={0.35}
              strokeDasharray="4 3"
            />
            <circle cx={r2(active.x)} cy={r2(active.y)} r={4.5} fill="var(--color-accent)" stroke="var(--color-card)" strokeWidth={2} />
          </g>
        )}

        {/* X axis labels (thinned) */}
        {labelIndexes.map((i) => (
          <text
            key={`x-${i}`}
            x={r2(coords[i].x)}
            y={H - 8}
            textAnchor="middle"
            fontSize={10}
            fill="var(--color-subtle)"
          >
            {coords[i].point.label}
          </text>
        ))}
      </svg>

      {/* HTML tooltip: rendered at fixed font size (independent of the SVG's
          proportional scaling) so hover data stays crisp at any card width */}
      {active && (
        <div
          className={cn(
            'pointer-events-none absolute z-10 -translate-y-full whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md',
            active.x / W < 0.15 ? 'left-0' : active.x / W > 0.85 ? 'right-0' : 'left-1/2 -translate-x-1/2',
          )}
          style={{ top: `${(active.y / H) * 100}%`, marginTop: -8 }}
        >
          {active.point.label} · {fmt(active.point.value)}
        </div>
      )}
    </div>
  )
}
