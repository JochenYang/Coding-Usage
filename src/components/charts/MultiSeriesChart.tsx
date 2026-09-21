import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { formatCompactValue } from '@/lib/format'
import { CHART_W, labelIndexes, niceTicks, r2, smoothPath } from '@/lib/chart-math'
import { useChartKeyboard } from '@/lib/hooks/use-chart-keyboard'
import { ChartLegend, type LegendItem } from './ChartLegend'
import { ChartTooltip, tooltipAnchor, type TooltipRow } from './ChartTooltip'

/**
 * Multi-series line chart: one smoothed curve per model.
 *
 * Used by the "split by model" view, where the interesting question is how the
 * mix of models shifted over time rather than what the total was. Series are
 * already filtered/sorted by the caller; this component only lays them out.
 *
 * Curves carry no per-point markers (they turn a busy chart into beads on a
 * string); the hovered column is the one place a value is pinpointed, and the
 * legend doubles as the series filter so switching a model off does not require
 * leaving the chart.
 */

export interface MultiSeries {
  /** Stable unique identity for React keys (truncated labels can collide) */
  id: string
  /** Legend / tooltip label */
  name: string
  /** Colour (a CSS custom property reference, resolved by the browser) */
  color: string
  /** Value per x label; shorter arrays are treated as zero-padded */
  values: number[]
  /** Toggle state when the caller makes the legend interactive */
  active?: boolean
}

export interface MultiSeriesChartProps {
  labels: string[]
  series: MultiSeries[]
  height?: number
  /** Formatter for axis ticks and tooltips */
  formatValue?: (n: number) => string
  /** Tooltip heading, e.g. "输出 tokens" */
  valueLabel: string
  /** Makes the legend entries toggle their series (the caller owns the state) */
  onToggleSeries?: (id: string) => void
  ariaLabel?: string
  /**
   * Appended to the accessible name. The frame is focusable so the arrow keys
   * can drive the readout, and a focusable element has to say what it responds
   * to — otherwise the capability is invisible to the users who need it.
   */
  keyboardHint?: string
  className?: string
}

const W = CHART_W
const PAD = { left: 44, right: 16, top: 12, bottom: 26 } as const

export function MultiSeriesChart({
  labels,
  series,
  height = 260,
  formatValue,
  valueLabel,
  onToggleSeries,
  ariaLabel,
  keyboardHint,
  className,
}: MultiSeriesChartProps) {
  const fmt = formatValue ?? formatCompactValue
  const [hover, setHover] = useState<number | null>(null)
  // Before the empty-state return below: hooks may not sit behind an early exit
  const { keyboard, frameProps } = useChartKeyboard(labels.length, hover, setHover)
  // Keyed on a content signature rather than on the array identities: callers
  // rebuild `labels` on every render, and depending on it cleared the hover each
  // time — the tooltip never survived a frame. The intent is only to drop a
  // hover whose index would point at a different bucket after a refresh.
  const signature = `${labels.join('\u0000')}\u0001${series.map((s) => s.id).join('\u0000')}`
  useEffect(() => {
    setHover(null)
  }, [signature])

  const max = useMemo(() => {
    let m = 0
    for (const s of series) for (const v of s.values) if (v > m) m = v
    return m
  }, [series])

  if (labels.length === 0 || series.length === 0) {
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

  const ticks = niceTicks(max)
  const maxTick = ticks[ticks.length - 1] || 1
  const xAt = (i: number) =>
    labels.length === 1 ? PAD.left + innerW / 2 : PAD.left + (i / (labels.length - 1)) * innerW
  const yAt = (v: number) => baselineY - (v / maxTick) * innerH

  const legendItems: LegendItem[] = series.map((s) => ({
    id: s.id,
    label: s.name,
    color: s.color,
    shape: 'dot',
    onClick: onToggleSeries ? () => onToggleSeries(s.id) : undefined,
    active: s.active,
  }))

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * W
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < labels.length; i++) {
      const d = Math.abs(xAt(i) - vbX)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    setHover(best)
  }

  // Rank rows at the hovered index (largest first), skipping series that were
  // idle that day — a wall of zeros hides the real mix. Ranked once and rendered
  // twice: the bubble needs the short name, which fits its width, while the
  // announcement needs the full id, since a screen reader has no width to fit
  // and an ellipsis is all a listener would hear.
  const activeRanked =
    hover == null
      ? []
      : series
          .map((s) => ({ id: s.id, name: s.name, color: s.color, value: s.values[hover] ?? 0 }))
          .filter((r) => r.value > 0)
          .sort((a, b) => b.value - a.value)
          .slice(0, 8)

  const activeRows: TooltipRow[] = activeRanked.map((r) => ({
    label: r.name,
    color: r.color,
    value: fmt(r.value),
    shape: 'dot' as const,
  }))

  // The crosshair marks the point a bubble describes. With nothing to show —
  // every series idle that day — it would point at empty space, so it follows
  // the bubble rather than the raw hover index.
  const shown = hover != null && activeRows.length > 0 ? hover : null

  // Read out through a live region beside the plot rather than inside it: the
  // announcement is then one stable node whose text changes, instead of a node
  // that appears and disappears with the hovered point. The unit travels with
  // the numbers (the bubble shows it only as a footnote) and the separator is
  // the typographic one the KPI rows already use, so nothing needs translating.
  //
  // A day with no usage announces its position with a zero rather than going
  // silent: the bubble is suppressed there too, and silence would leave a
  // keyboard user unable to tell a working arrow key from a lost one.
  const announcement =
    keyboard && hover != null
      ? [
          labels[hover],
          valueLabel,
          ...(activeRanked.length > 0
            ? activeRanked.map((r) => `${r.id} ${fmt(r.value)}`)
            : ['0']),
        ]
          .filter(Boolean)
          .join(' · ')
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
                  strokeOpacity={i === 0 ? 1 : 0.6}
                />
                <text x={PAD.left - 8} y={y + 3.5} textAnchor="end" fontSize={10} fill="var(--color-subtle)">
                  {fmt(t)}
                </text>
              </g>
            )
          })}

          {/* Curves. Series switched off in the legend stay drawn but recede, so
              the mix they belong to is still readable behind the selection. */}
          {series.map((s) => {
            const coords = labels.map((_, i) => ({ x: xAt(i), y: yAt(s.values[i] ?? 0) }))
            return (
              <path
                key={s.id}
                d={smoothPath(coords)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={s.active === false ? 0.25 : 1}
              />
            )
          })}

          {shown != null && (
            <>
              <line
                x1={r2(xAt(shown))}
                x2={r2(xAt(shown))}
                y1={PAD.top}
                y2={baselineY}
                stroke="var(--color-foreground)"
                strokeOpacity={0.25}
                strokeDasharray="4 3"
              />
              {series.map((s) => (
                <circle
                  key={`d-${s.id}`}
                  cx={r2(xAt(shown))}
                  cy={r2(yAt(s.values[shown] ?? 0))}
                  r={3.5}
                  fill={s.color}
                  stroke="var(--color-card)"
                  strokeWidth={2}
                  opacity={s.active === false ? 0.35 : 1}
                />
              ))}
            </>
          )}

          {labelIndexes(labels.length).map((i) => (
            <text
              key={`x-${i}`}
              x={r2(xAt(i))}
              y={H - 9}
              textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
              fontSize={10}
              fill="var(--color-subtle)"
            >
              {labels[i]}
            </text>
          ))}
        </svg>

        {shown != null && (
          <ChartTooltip
            title={labels[shown]!}
            rows={activeRows}
            note={activeRows.length === 1 ? valueLabel : undefined}
            {...tooltipAnchor(xAt(shown) / W, '6px')}
          />
        )}

        {/* Inside the frame on purpose. `sr-only` is absolutely positioned, so
            outside a positioned ancestor it resolves against the document and
            escapes the scrolling <main> — which stretched the page into a
            second scrollbar. */}
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
    </div>
  )
}
