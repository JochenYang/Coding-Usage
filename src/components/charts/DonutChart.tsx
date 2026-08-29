import { cn } from '@/lib/cn'
import { formatCompactValue } from '@/lib/format'

/** One slice of the donut chart */
export interface DonutSegment {
  label: string
  value: number
  color: string
}

export interface DonutChartProps {
  /** Slices to render; order defines the drawing order around the ring */
  segments: DonutSegment[]
  /** Outer size of the square SVG in px (default 168) */
  size?: number
  /** Ring stroke width in px (default 16) */
  thickness?: number
  /** Big number rendered in the donut hole */
  centerValue: string
  /** Small caption under centerValue */
  centerLabel?: string
  /** Optional formatter for legend values (defaults to formatCompactValue) */
  formatValue?: (n: number) => string
  /** Render the legend list next to the ring (default true) */
  showLegend?: boolean
  /** Ring above and legend below (vertical), or side by side (default) */
  orientation?: 'horizontal' | 'vertical'
  /** Extra classes appended to the outer wrapper */
  className?: string
}

/** Visual gap between consecutive slices, in degrees of the full circle */
const GAP_DEG = 2.5

/** Donut chart with rounded, gapped slices and an HTML legend */
export function DonutChart({
  segments,
  size = 168,
  thickness = 16,
  centerValue,
  centerLabel,
  formatValue,
  showLegend = true,
  orientation = 'horizontal',
  className,
}: DonutChartProps) {
  const fmt = formatValue ?? formatCompactValue
  const radius = (size - thickness) / 2
  const center = size / 2
  const circumference = 2 * Math.PI * radius

  const positive = segments.filter((s) => s.value > 0)
  const total = positive.reduce((sum, s) => sum + s.value, 0)

  // Round caps extend beyond each dash end by thickness/2, so shrink every dash
  // by one cap radius plus half the gap on each side to keep gaps visible.
  const capRadius = thickness / 2
  const inset = capRadius + ((GAP_DEG / 360) * circumference) / 2

  let acc = 0 // accumulated arc length at each slice's nominal start boundary
  const arcs =
    total > 0
      ? positive.map((s, i) => {
          const start = acc
          const full = (s.value / total) * circumference
          acc += full
          const len = Math.max(full - inset * 2, 1) // clamp tiny slices to a visible dot
          return { key: `${s.label}-${i}`, color: s.color, offset: -(start + inset), len, percent: Math.round((s.value / total) * 100), value: s.value, label: s.label }
        })
      : []

  return (
    <div
      className={cn(
        'flex gap-6',
        orientation === 'vertical' ? 'w-full flex-col items-center' : 'items-center',
        className,
      )}
    >
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
          {/* Rotate so dashes start at 12 o'clock and flow clockwise */}
          <g transform={`rotate(-90 ${center} ${center})`}>
            {total > 0
              ? arcs.map((a) => (
                  <circle
                    key={a.key}
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={thickness}
                    strokeDasharray={`${a.len} ${circumference - a.len}`}
                    strokeDashoffset={a.offset}
                    strokeLinecap="round"
                  >
                    <title>{`${a.label}: ${a.percent}% (${fmt(a.value)})`}</title>
                  </circle>
                ))
              : (
                  <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--color-border)" strokeWidth={thickness} />
                )}
          </g>
        </svg>
        {/* pointer-events-none keeps slice hover tooltips reachable */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-xl font-semibold tabular-nums text-foreground">{centerValue}</div>
          {centerLabel && <div className="mt-0.5 text-[11px] text-muted-foreground">{centerLabel}</div>}
        </div>
      </div>

      {showLegend && positive.length > 0 && (
        <ul
          className={cn(
            'min-w-0 space-y-2',
            orientation === 'vertical' ? 'w-full flex-1' : 'flex-1',
          )}
        >
          {/* Zero-value slices would draw legend rows the ring can't show */}
          {positive.map((s, i) => {
            const percent = total > 0 ? Math.round((s.value / total) * 100) : 0
            return (
              <li key={`${s.label}-${i}`} className="flex items-center gap-2 text-xs">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="truncate text-foreground">{s.label}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {percent}% ({fmt(s.value)})
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
