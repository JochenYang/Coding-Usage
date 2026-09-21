import { useReducedMotion } from 'motion/react'
import { cn } from '@/lib/cn'
import { formatCompactValue } from '@/lib/format'
import { modelLabel, type ModelCompareRow } from '@/lib/trend-analysis'

/**
 * Per-model comparison as a ranked list of horizontal bars.
 *
 * A vertical bar chart is the wrong shape for this data: the scan reports dozens
 * of models with long ids, so category labels had to be rotated and truncated
 * until they overlapped, and the handful of models that actually carry the usage
 * were buried under a long tail of near-zero columns. Read sideways, each model
 * id gets a column of its own, every row stays legible at any count, and the
 * ranking — the thing this chart exists to show — becomes the axis.
 *
 * The bar length carries one measure (tokens by default, or call count) and the
 * output speed rides alongside as a plain figure. An earlier design drew that
 * speed as a second curve; it was the wrong call, because two measures sharing
 * one axis leave the reader no way to tell which line belongs to which scale.
 */

export interface ModelCompareChartProps {
  rows: ModelCompareRow[]
  /** Which measure the bar length carries (tokens by default) */
  barMetric?: 'tokens' | 'calls'
  labels: {
    tokens: string
    calls: string
    speed: string
    /** Footnote for the per-model speed figure */
    estimated: string
    /** Caption over the model-name column */
    model: string
  }
  /** Models currently in the filter (the rest recede) */
  selected: string[]
  /** Click handler; the caller decides whether it is additive or exclusive */
  onToggleModel: (model: string) => void
  ariaLabel?: string
  className?: string
}

/** Fixed column widths, shared by the caption row and every data row */
const NAME_COL = 'w-44'
const VALUE_COL = 'w-20'

export function ModelCompareChart({
  rows,
  barMetric = 'tokens',
  labels,
  selected,
  onToggleModel,
  ariaLabel,
  className,
}: ModelCompareChartProps) {
  const reduced = useReducedMotion()

  if (rows.length === 0) {
    return (
      <div aria-label={ariaLabel} className={cn('flex min-h-[120px] items-center justify-center', className)}>
        <span className="text-xs text-subtle">&mdash;</span>
      </div>
    )
  }

  const isTokens = barMetric === 'tokens'
  const barLabel = isTokens ? labels.tokens : labels.calls
  const max = Math.max(...rows.map((r) => (isTokens ? r.tokens : r.messages)), 0) || 1
  const hasSpeed = rows.some((r) => r.tokPerSec != null)

  return (
    <div className={cn('w-full', className)}>
      {/* The two right-hand figures are different measures, so they are named
          rather than left to be inferred from position. */}
      <div className="flex items-center gap-3 px-2 pb-1 text-[11px] text-subtle">
        <span className="w-2.5 shrink-0" aria-hidden="true" />
        <span className={cn(NAME_COL, 'shrink-0')}>{labels.model}</span>
        <span className="flex-1" />
        <span className={cn(VALUE_COL, 'shrink-0 text-right')}>{barLabel}</span>
        {hasSpeed && <span className={cn(VALUE_COL, 'shrink-0 text-right')}>{labels.speed}</span>}
      </div>

      <ul aria-label={ariaLabel} className="space-y-0.5">
        {rows.map((row) => {
          const value = isTokens ? row.tokens : row.messages
          // An empty filter means "everything shown"; a non-empty one recedes
          // everything outside it without removing it from the ranking.
          const on = selected.length === 0 || selected.includes(row.model)
          // Carried on the row rather than derived from its position: these rows
          // re-sort when the metric changes, and a positional colour would
          // repaint every bar on a toggle and disagree with the chart above.
          const color = row.color
          return (
            <li key={row.model}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onToggleModel(row.model)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60',
                  on ? undefined : 'opacity-40',
                )}
              >
                <span
                  aria-hidden="true"
                  data-swatch={row.model}
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: color }}
                />
                {/* Full id (provider included) truncated by the column, so two
                    providers serving the same model stay distinguishable */}
                <span
                  className={cn(NAME_COL, 'shrink-0 truncate text-[11px] text-muted-foreground')}
                  title={modelLabel(row.model)}
                >
                  {modelLabel(row.model)}
                </span>
                <span className="flex-1">
                  <span
                    className={cn('block h-3.5 rounded-[3px]', reduced ? undefined : 'transition-[width] duration-300')}
                    // A non-zero figure that rounds to under a pixel still has to
                    // read as "some", not as "none"
                    style={{ width: `${(value / max) * 100}%`, minWidth: value > 0 ? 2 : 0, backgroundColor: color }}
                  />
                </span>
                <span className={cn(VALUE_COL, 'shrink-0 text-right text-[11px] tabular-nums text-foreground')}>
                  {isTokens ? formatCompactValue(row.tokens) : String(row.messages)}
                </span>
                {hasSpeed && (
                  <span className={cn(VALUE_COL, 'shrink-0 text-right text-[11px] tabular-nums text-subtle')}>
                    {row.tokPerSec != null ? `${row.tokPerSec.toFixed(1)} tok/s` : '—'}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {hasSpeed && <p className="mt-2 px-2 text-[11px] text-subtle">{labels.estimated}</p>}
    </div>
  )
}
