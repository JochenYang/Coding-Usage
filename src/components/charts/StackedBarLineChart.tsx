import { useEffect, useId, useState } from 'react'
import { cn } from '@/lib/cn'
import { formatCompactValue } from '@/lib/format'
import { CHART_W, barPath, labelIndexes, niceTicks, r2, smoothPath } from '@/lib/chart-math'
import { useChartKeyboard } from '@/lib/hooks/use-chart-keyboard'
import { ChartLegend, type LegendItem } from './ChartLegend'
import { ChartTooltip, tooltipAnchor, type TooltipRow } from './ChartTooltip'
import type { TrendBucket } from '@/lib/trend-analysis'

/**
 * Stacked-bar + dual-axis line chart for the aggregate usage trend.
 *
 * Left axis: token volume, split into cache-read / input / output segments.
 * Right axis: weighted output speed (tok/s) as a smoothed curve.
 *
 * The stack is drawn as a single-hue ramp so the column reads as one quantity
 * with a breakdown rather than three competing categories, and the speed curve
 * wears the one accent hue that means "output speed" everywhere in the app. The
 * legend above the plot names both, because a stack whose segments are only
 * distinguished by lightness is unreadable without one.
 *
 * Follows the conventions established by LineChart (fixed 560-unit viewBox
 * scaled by width="100%", "nice" ticks, hover cleared when the data identity
 * changes, HTML tooltip at a fixed font size so hover text stays crisp
 * regardless of card width). The two differ in composition, not in primitives,
 * so a reader who knows LineChart can read this one.
 */

export interface StackedBarLineChartProps {
  buckets: TrendBucket[]
  /** viewBox height; drives the aspect ratio */
  height?: number
  /**
   * Leave the cache-read segment out of the stack (the no-cache accounting
   * mode). The axis follows suit, so the bars stay proportionate to the
   * headline figure the KPI row reports.
   */
  dropCache?: boolean
  /** Formatter for the token axis */
  formatTokens?: (n: number) => string
  /** Legend / tooltip labels for the three stack segments */
  labels: { cacheRead: string; input: string; output: string; speed: string }
  ariaLabel?: string
  /** Appended to the accessible name; see MultiSeriesChart for why it exists */
  keyboardHint?: string
  className?: string
}

const W = CHART_W
const PAD = { left: 46, right: 46, top: 14, bottom: 28 } as const

/** Stack segments, calmest first — cache carries the volume, output the cost */
const CACHE_COLOR = 'var(--color-stack-cache)'
const INPUT_COLOR = 'var(--color-stack-input)'
const OUTPUT_COLOR = 'var(--color-stack-output)'
/** Output speed wears this colour in every chart that plots it */
const SPEED_COLOR = 'var(--color-chart-4)'

export function StackedBarLineChart({
  buckets,
  height = 260,
  dropCache = false,
  formatTokens,
  labels,
  ariaLabel,
  keyboardHint,
  className,
}: StackedBarLineChartProps) {
  const rawId = useId()
  const speedGradient = `speed-grad-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const fmt = formatTokens ?? formatCompactValue
  const [hover, setHover] = useState<number | null>(null)
  // Before the empty-state return below: hooks may not sit behind an early exit
  const { keyboard, frameProps } = useChartKeyboard(buckets.length, hover, setHover)
  // Same stale-hover hazard as LineChart: an auto-refresh swaps the svg subtree
  // mid-hover and mouseleave never fires on the detached node.
  useEffect(() => {
    setHover(null)
  }, [buckets])

  const speeds = buckets.map((b) => b.tokPerSec ?? 0)
  const hasSpeed = speeds.some((s) => s > 0)

  if (buckets.length === 0) {
    return (
      <div role="img" aria-label={ariaLabel} className={cn('flex h-full min-h-[120px] items-center justify-center', className)}>
        <span className="text-xs text-subtle">&mdash;</span>
      </div>
    )
  }

  const H = height
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const baselineY = PAD.top + innerH

  /** Stack segments for a column, top-down order fixed so a colour never moves */
  const segmentsOf = (b: TrendBucket) =>
    [
      ...(dropCache ? [] : [{ v: b.cacheRead, color: CACHE_COLOR }]),
      { v: b.input, color: INPUT_COLOR },
      { v: b.output, color: OUTPUT_COLOR },
    ].filter((s) => s.v > 0)

  // The axis follows the COUNTED total, never the drawn stack: in "all" mode the
  // headline total carries cache writes the stack does not draw, and in no-cache
  // mode the stack drops the cache segment entirely. Deriving the axis from the
  // stack instead would let the bars grow past the top of the plot.
  const axisValue = buckets.reduce((m, b) => Math.max(m, dropCache ? b.input + b.output : b.total), 0)
  const tokenTicks = niceTicks(axisValue)
  const maxTokenTick = tokenTicks[tokenTicks.length - 1] || 1
  const speedTicks = hasSpeed ? niceTicks(Math.max(...speeds, 0)) : []
  const maxSpeedTick = speedTicks.length > 0 ? speedTicks[speedTicks.length - 1]! : 1

  const step = innerW / buckets.length
  // Cap the bar width so a 3-bucket chart does not render as three slabs
  const barW = Math.min(step * 0.6, 28)
  const centerAt = (i: number) => PAD.left + step * (i + 0.5)
  const barX = (i: number) => centerAt(i) - barW / 2
  const yToken = (v: number) => baselineY - (v / maxTokenTick) * innerH
  const ySpeed = (v: number) => baselineY - (v / maxSpeedTick) * innerH

  const speedCoords = buckets.map((_, i) => ({ x: centerAt(i), y: ySpeed(speeds[i]!) }))
  const speedPath = hasSpeed ? smoothPath(speedCoords) : ''

  const legendItems: LegendItem[] = [
    ...(dropCache ? [] : [{ id: 'cacheRead', label: labels.cacheRead, color: CACHE_COLOR, shape: 'square' as const }]),
    { id: 'input', label: labels.input, color: INPUT_COLOR, shape: 'square' as const },
    { id: 'output', label: labels.output, color: OUTPUT_COLOR, shape: 'square' as const },
    ...(hasSpeed ? [{ id: 'speed', label: labels.speed, color: SPEED_COLOR, shape: 'dot' as const }] : []),
  ]

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * W
    const idx = Math.floor((vbX - PAD.left) / step)
    setHover(idx >= 0 && idx < buckets.length ? idx : null)
  }

  const active = hover != null && hover < buckets.length ? buckets[hover]! : null
  // The dimming follows the same guard: a hover index left over from a longer
  // dataset would otherwise match no bar and dim every one of them.
  const dimmed = hover != null && hover < buckets.length ? hover : null
  const activeX = hover != null ? centerAt(hover) : 0
  const activeSpeed = hover != null ? speedCoords[hover] : undefined

  const tooltipRows: TooltipRow[] = active
    ? [
        ...(dropCache ? [] : [{ label: labels.cacheRead, value: fmt(active.cacheRead), color: CACHE_COLOR, shape: 'square' as const }]),
        { label: labels.input, value: fmt(active.input), color: INPUT_COLOR, shape: 'square' as const },
        { label: labels.output, value: fmt(active.output), color: OUTPUT_COLOR, shape: 'square' as const },
        ...(active.tokPerSec != null
          ? [{ label: labels.speed, value: `${active.tokPerSec.toFixed(1)} tok/s`, color: SPEED_COLOR, shape: 'dot' as const }]
          : []),
      ]
    : []

  // Read out through a live region beside the plot rather than inside it: the
  // announcement is then one stable node whose text changes, instead of a node
  // that appears and disappears with the hovered bucket. Every part here is
  // already localised (the caller supplies the row labels), and the separator is
  // the typographic one the KPI rows use, so nothing needs translating.
  const announcement =
    keyboard && active
      ? [active.rangeLabel, ...tooltipRows.map((r) => `${r.label} ${r.value}`)].join(' · ')
      : ''

  return (
    <div className={cn('w-full', className)}>
      <ChartLegend items={legendItems} className="mb-1" />

      <div
        role="group"
        aria-label={[ariaLabel, keyboardHint].filter(Boolean).join(' · ') || undefined}
        {...frameProps}
        className="relative w-full outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          aria-hidden="true"
          className="block"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={speedGradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SPEED_COLOR} stopOpacity={0.18} />
              <stop offset="100%" stopColor={SPEED_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* Left axis (tokens) grid + labels. Solid hairlines only: dashed grid
              under dashed crosshairs under a curve is three line textures too
              many, and the bars are what the eye should be reading. */}
          {tokenTicks.map((t, i) => {
            const y = r2(yToken(t))
            return (
              <g key={`t-${t}`}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y}
                  y2={y}
                  stroke="var(--color-border)"
                  strokeOpacity={i === 0 ? 1 : 0.6}
                />
                <text x={PAD.left - 8} y={y + 3.5} textAnchor="end" fontSize={10} fill="var(--color-subtle)">
                  {fmt(t)}
                </text>
              </g>
            )
          })}

          {/* Right axis (tok/s) labels only — the shared grid above serves both.
              Tinted with the curve's own colour so the mapping needs no reading. */}
          {hasSpeed &&
            speedTicks.map((t) => (
              <text
                key={`s-${t}`}
                x={W - PAD.right + 8}
                y={r2(ySpeed(t)) + 3.5}
                textAnchor="start"
                fontSize={10}
                fill={SPEED_COLOR}
                fillOpacity={0.85}
              >
                {formatCompactValue(t)}
              </text>
            ))}

          {/* Weighted-speed wash, drawn BEFORE the bars so the columns keep
              their exact token colour — a translucent area over them tinted the
              cache slab differently in every column and broke the ramp. */}
          {hasSpeed && (
            <path
              d={`${speedPath} L${r2(speedCoords[speedCoords.length - 1]!.x)} ${r2(baselineY)} L${r2(speedCoords[0]!.x)} ${r2(baselineY)} Z`}
              fill={`url(#${speedGradient})`}
            />
          )}

          {/* Stacked bars. Segments butt directly against each other — the
              lightness steps already separate them, and a gap would break the
              column into floating pieces. Only the value end is rounded.

              The hover dimming is deliberately instantaneous rather than
              transitioned: the index changes on every mouse move, so a fade
              would restart continuously under the cursor and trail the pointer.
              Nothing in this chart animates, which is also why it carries no
              reduced-motion branch. */}
          {buckets.map((b, i) => {
            const segs = segmentsOf(b)
            const topIndex = segs.length - 1
            let cursor = baselineY
            return (
              <g key={`b-${i}`} opacity={dimmed == null || dimmed === i ? 1 : 0.4}>
                {segs.map((s, si) => {
                  const h = (s.v / maxTokenTick) * innerH
                  cursor -= h
                  return (
                    <path
                      key={si}
                      d={barPath(barX(i), cursor, barW, h, si === topIndex ? 3 : 0)}
                      fill={s.color}
                    />
                  )
                })}
              </g>
            )
          })}

          {/* Speed curve over the bars so it stays readable across a tall
              column. No per-point markers: at this density they read as beads
              strung along the line and bury the shape. */}
          {hasSpeed && (
            <>
              <path
                d={speedPath}
                fill="none"
                stroke={SPEED_COLOR}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {activeSpeed && (
                <circle
                  cx={r2(activeSpeed.x)}
                  cy={r2(activeSpeed.y)}
                  r={3.5}
                  fill={SPEED_COLOR}
                  stroke="var(--color-card)"
                  strokeWidth={2}
                />
              )}
            </>
          )}

          {/* Hover crosshair */}
          {active && (
            <line
              x1={r2(activeX)}
              x2={r2(activeX)}
              y1={PAD.top}
              y2={baselineY}
              stroke="var(--color-foreground)"
              strokeOpacity={0.25}
              strokeDasharray="4 3"
            />
          )}

          {/* X labels, edge-anchored inward so they never bleed past the viewBox */}
          {labelIndexes(buckets.length).map((i) => (
            <text
              key={`x-${i}`}
              x={r2(centerAt(i))}
              y={H - 9}
              textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}
              fontSize={10}
              fill="var(--color-subtle)"
            >
              {buckets[i]!.label}
            </text>
          ))}
        </svg>

        {/* HTML tooltip (fixed font size, independent of SVG scaling) */}
        {active && (
          <ChartTooltip
            title={active.rangeLabel}
            rows={tooltipRows}
            {...tooltipAnchor(activeX / W, `${(PAD.top / H) * 100}%`)}
          />
        )}
      </div>

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
