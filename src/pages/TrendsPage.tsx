import { Activity, Database, Gauge, Hash, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import type { DayPointVM } from '@/lib/agent-usage'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { StatCard } from '@/components/common/StatCard'
import { Tooltip } from '@/components/common/Tooltip'
import { StackedBarLineChart } from '@/components/charts/StackedBarLineChart'
import { MultiSeriesChart } from '@/components/charts/MultiSeriesChart'
import { ModelCompareChart } from '@/components/charts/ModelCompareChart'
import { formatCompactValue } from '@/lib/format'
import { cn } from '@/lib/cn'
import {
  RANGE_DAYS,
  bucketize,
  buildModelRows,
  computeTotals,
  groupModelDaily,
  modelColor,
  shortModelName,
  sliceRange,
  type ModelCompareRow,
  type TrendRange,
} from '@/lib/trend-analysis'

/** How many models the split view draws before it stops being readable */
const SPLIT_SERIES_LIMIT = 8

/**
 * Usage trends: the aggregate, cross-agent view of historic consumption.
 *
 * Unlike the overview (live quota state) or the agents page (per-client
 * standing), this page answers structural questions over time — how much was
 * cache vs fresh input, which models carried the load, and how the mix shifted.
 *
 * Data granularity: the tokscale scan yields ONE record per calendar day with a
 * day-level active time. There are no per-call timestamps, so the range
 * selector narrows the window but never subdivides it, and "output speed" is a
 * weighted estimate rather than a measured generation rate (see speedHint).
 */
export function TrendsPage() {
  const t = useT()
  const { agentUsage, agentDailySeries, sections, settings } = useData()
  const mode = settings.usageDisplayMode

  // Grouped before anything reads it: the scan keys a model by the endpoint that
  // served it, and every view on this page is per model.
  const modelDaily = useMemo(() => groupModelDaily(agentUsage.modelDaily), [agentUsage.modelDaily])

  const [range, setRange] = useState<TrendRange>(30)
  const [view, setView] = useState<'aggregate' | 'byModel'>('byModel')
  /** Measure the comparison bars carry (token volume vs call count) */
  const [compareMetric, setCompareMetric] = useState<'tokens' | 'calls'>('tokens')
  /** Model filter; empty = no filter (everything shown) */
  const [picked, setPicked] = useState<string[]>([])

  // Graph-derived daily series (immediately available) with the local archive
  // as fallback, mirroring the previous implementation's sourcing order.
  const archived = useMemo(
    () => (agentUsage.dailySeries.length >= 2 ? [] : agentDailySeries(90)),
    [agentUsage.dailySeries.length, agentDailySeries],
  )

  const source: DayPointVM[] = useMemo(() => {
    if (agentUsage.dailySeries.length >= 2) return agentUsage.dailySeries
    if (archived.length >= 2) {
      // Archive points carry only a total: model/active-time dimensions are
      // genuinely absent, and are left at zero rather than invented.
      return archived.map((p) => ({
        label: p.label,
        value: p.value,
        input: p.value,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        activeTimeMs: 0,
        messages: 0,
      }))
    }
    return []
  }, [agentUsage.dailySeries, archived])

  /**
   * Model-filtered view. `modelDaily` carries no input/cache split (tokscale
   * reports the breakdown per day, not per model), so a filtered selection
   * cannot report a cache hit rate — the flag below tells the UI to say
   * "unavailable" instead of rendering a misleading 0%.
   */
  const isFiltered = picked.length > 0

  const filtered: DayPointVM[] = useMemo(() => {
    if (picked.length === 0) return source
    // A day is kept when ANY picked model was active on it; the day's totals
    // are then recomputed from those models alone so the KPI row, the stacked
    // bars and the comparison chart all describe the same selection.
    const pickedSet = new Set(picked)
    const rows = modelDaily.filter((m) => pickedSet.has(m.model))
    if (rows.length === 0) return []
    return source.map((day, i) => {
      let output = 0
      let messages = 0
      let total = 0
      for (const r of rows) {
        messages += r.messages[i] ?? 0
        output += r.output[i] ?? 0
        total += r.total[i] ?? 0
      }
      return { ...day, input: Math.max(0, total - output), output, cacheRead: 0, cacheWrite: 0, value: total, messages }
    })
  }, [source, picked, modelDaily])

  const windowed = useMemo(() => sliceRange(filtered, range), [filtered, range])
  const buckets = useMemo(() => bucketize(windowed), [windowed])
  const totals = useMemo(() => computeTotals(buckets, mode), [buckets, mode])

  const modelRows = useMemo(
    () =>
      buildModelRows(
        modelDaily.filter((m) => picked.length === 0 || picked.includes(m.model)),
        windowed.length,
        windowed.map((d) => d.activeTimeMs),
        windowed.map((d) => d.messages),
      ),
    [modelDaily, picked, windowed],
  )

  // Split view: the largest models by output over the window, in a stable
  // order so colours do not reshuffle as the range changes.
  const topModels = useMemo(() => {
    const windowSize = windowed.length
    const sumOverWindow = (values: number[]): number => {
      const start = Math.max(0, values.length - windowSize)
      let s = 0
      for (let i = start; i < values.length; i++) s += values[i] ?? 0
      return s
    }
    return modelDaily
      .filter((m) => picked.length === 0 || picked.includes(m.model))
      .map((m) => ({ m, output: sumOverWindow(m.output) }))
      .sort((a, b) => b.output - a.output)
      .slice(0, SPLIT_SERIES_LIMIT)
      .map((x) => x.m)
  }, [modelDaily, picked, windowed.length])

  const splitSeries = useMemo(() => {
    const offset = Math.max(0, agentUsage.dailySeries.length - windowed.length)
    const pickedSet = new Set(picked)
    return topModels.map((m, i) => ({
      // Identity stays the raw id (unique); the label is display-only and can
      // collide after truncation, so it must never key a React list.
      id: m.model,
      name: shortModelName(m.model),
      color: modelColor(m.model, i),
      values: m.output.slice(offset, offset + windowed.length),
      // An empty filter means "everything shown"; the chart's legend uses this
      // to dim the curves a filter has switched off.
      active: picked.length === 0 || pickedSet.has(m.model),
    }))
  }, [topModels, agentUsage.dailySeries.length, windowed.length, picked])

  const hasLocal = agentUsage.allTimeTotal.tokens > 0 || source.length > 0
  const apiFallbackOnly = !hasLocal && sections.length > 0

  if (!hasLocal && !apiFallbackOnly) {
    return (
      <div className="space-y-4">
        <PageHeader title={t.nav.trends} description={t.trends.pageDesc} />
        <EmptyState
          icon={<TrendingUp className="h-6 w-6" />}
          title={t.trends.emptyTitle}
          description={t.trends.emptyDesc}
        />
      </div>
    )
  }

  const toggleModel = (model: string) => {
    setPicked((prev) => (prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]))
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t.nav.trends} description={t.trends.pageDesc} />

      {/* Range control. The aggregate / by-model switch lives on the chart card
          itself — it selects what that one chart plots, so it belongs there. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t.trends.rangeLabel}</span>
        <div role="tablist" aria-label={t.trends.rangeLabel} className="flex items-center gap-0.5 rounded-full bg-muted p-1">
          {RANGE_DAYS.map((r) => (
            <button
              key={String(r)}
              role="tab"
              aria-selected={range === r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs transition-colors',
                range === r ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r === null ? t.trends.rangeAll : t.trends.rangeDays(r)}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title={t.trends.kpiTokens}
          icon={Database}
          value={formatCompactValue(totals.tokens)}
          footer={
            <span className="tabular-nums text-muted-foreground">
              {t.trends.seriesCacheRead} {formatCompactValue(totals.cacheRead)} · {t.trends.seriesInput}{' '}
              {formatCompactValue(totals.input)} · {t.trends.seriesOutput} {formatCompactValue(totals.output)}
            </span>
          }
        />
        <StatCard title={t.trends.kpiCalls} icon={Hash} value={formatCompactValue(totals.messages)} />
        <StatCard
          title={t.trends.kpiHitRate}
          icon={Activity}
          value={isFiltered ? '—' : `${totals.hitRatePct.toFixed(1)}%`}
          valueSlot={
            isFiltered ? (
              <Tooltip text={t.trends.hitRateUnavailable} bubbleClassName="w-64 whitespace-normal">
                <div className="mt-2 inline-block cursor-help text-[28px] font-semibold leading-tight tabular-nums text-subtle underline decoration-dotted underline-offset-4">
                  —
                </div>
              </Tooltip>
            ) : undefined
          }
          footer={
            isFiltered ? (
              <span className="text-muted-foreground">{t.trends.hitRateUnavailableShort}</span>
            ) : (
              <ProgressMeter pct={totals.hitRatePct} />
            )
          }
        />
        <StatCard
          title={t.trends.kpiSpeed}
          icon={Gauge}
          value={totals.weightedTokPerSec != null ? `${totals.weightedTokPerSec.toFixed(1)} tok/s` : '—'}
          valueSlot={
            <Tooltip text={t.trends.speedHint} bubbleClassName="w-64 whitespace-normal">
              <div className="mt-2 inline-block cursor-help text-[28px] font-semibold leading-tight tabular-nums text-foreground underline decoration-dotted decoration-subtle underline-offset-4">
                {totals.weightedTokPerSec != null ? `${totals.weightedTokPerSec.toFixed(1)} tok/s` : '—'}
              </div>
            </Tooltip>
          }
        />
      </div>

      {/* Model filter */}
      {modelDaily.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">{t.trends.filterTitle}</h2>
              {picked.length > 0 && (
                <span className="text-[11px] tabular-nums text-muted-foreground">{t.trends.filterSelected(picked.length)}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPicked([])}
                className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t.trends.filterAll}
              </button>
              {picked.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPicked([])}
                  className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {t.trends.filterClear}
                </button>
              )}
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {modelDaily.slice(0, 24).map((m, i) => {
              const on = picked.includes(m.model)
              return (
                <button
                  key={m.model}
                  type="button"
                  aria-pressed={on}
                  // Grouped names are already provider-free and decoded, so the
                  // id doubles as the full label
                  title={m.model}
                  onClick={() => toggleModel(m.model)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    on ? 'border-transparent bg-muted font-medium text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: modelColor(m.model, i) }} />
                  {shortModelName(m.model, 22)}
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* Main chart: aggregate stack or per-model split */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            {view === 'aggregate' ? t.trends.chartTrend : t.trends.chartSplit}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* The aggregate view needs no subtitle: the legend the chart draws
                above the plot already names every series in it. */}
            {view === 'byModel' && <span className="text-[11px] text-subtle">{t.trends.chartSplitHint}</span>}
            <div
              role="tablist"
              aria-label={t.trends.viewAggregate}
              className="flex items-center gap-0.5 rounded-full bg-muted p-1"
            >
              {(
                [
                  ['aggregate', t.trends.viewAggregate],
                  ['byModel', t.trends.viewByModel],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs transition-colors',
                    view === v ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3">
          {view === 'aggregate' ? (
            buckets.length >= 1 && totals.tokens > 0 ? (
              <StackedBarLineChart
                buckets={buckets}
                dropCache={mode === 'no-cache'}
                labels={{
                  cacheRead: t.trends.seriesCacheRead,
                  input: t.trends.seriesInput,
                  output: t.trends.seriesOutput,
                  speed: t.trends.seriesSpeed,
                }}
                ariaLabel={t.trends.chartTrend}
              />
            ) : (
              <p className="py-10 text-center text-xs text-subtle">{t.trends.gathering}</p>
            )
          ) : splitSeries.length > 0 ? (
            <MultiSeriesChart
              labels={windowed.map((d) => d.label)}
              series={splitSeries}
              valueLabel={t.trends.seriesOutput}
              onToggleSeries={toggleModel}
              ariaLabel={t.trends.chartSplit}
            />
          ) : (
            <p className="py-10 text-center text-xs text-subtle">{t.trends.gathering}</p>
          )}
        </div>
        <p className="mt-2 text-[11px] text-subtle">
          {isFiltered
            ? t.trends.filteredSplitNote
            : windowed.length > 30
              ? t.trends.weeklyNote
              : windowed.length > 0
                ? t.trends.speedHint
                : ''}
        </p>
      </section>

      {/* Model comparison */}
      {modelRows.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">{t.trends.chartCompare}</h2>
            <div className="flex flex-wrap items-center gap-2">
              {/* One measure per chart: the bars carry either token volume or the
                  call count, never both, so the right axis stays unambiguous */}
              <div
                role="tablist"
                aria-label={t.trends.chartCompare}
                className="flex items-center gap-0.5 rounded-full bg-muted p-1"
              >
                {(
                  [
                    ['tokens', t.trends.kpiTokens],
                    ['calls', t.trends.seriesCalls],
                  ] as const
                ).map(([metric, label]) => (
                  <button
                    key={metric}
                    role="tab"
                    aria-selected={compareMetric === metric}
                    type="button"
                    onClick={() => setCompareMetric(metric)}
                    className={cn(
                      'rounded-full px-3 py-1.5 text-xs transition-colors',
                      compareMetric === metric
                        ? 'bg-card font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-subtle">{t.trends.chartCompareHint}</span>
            </div>
          </div>
          <div className="mt-3">
            <ModelCompareChart
              rows={rankedRows(modelRows, compareMetric)}
              barMetric={compareMetric}
              labels={{
                tokens: t.trends.kpiTokens,
                calls: t.trends.seriesCalls,
                speed: t.trends.seriesSpeed,
                estimated: t.trends.estimated,
                model: t.overview.colModel,
              }}
              selected={picked}
              onToggleModel={toggleModel}
              ariaLabel={t.trends.chartCompare}
            />
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * Rank comparison rows by the measure actually being plotted.
 *
 * buildModelRows sorts by token volume, which would leave the bars in an order
 * that contradicts their own lengths once they carry call counts.
 */
function rankedRows(rows: ModelCompareRow[], metric: 'tokens' | 'calls'): ModelCompareRow[] {
  return [...rows].sort((a, b) => (metric === 'tokens' ? b.tokens - a.tokens : b.messages - a.messages))
}

/** Thin inline meter under the hit-rate figure; width is the percentage itself */
function ProgressMeter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-accent" style={{ width: `${clamped}%` }} />
    </div>
  )
}
