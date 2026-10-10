import { Activity, Database, Gauge, Hash, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { StatCard } from '@/components/common/StatCard'
import { Tooltip } from '@/components/common/Tooltip'
import { StackedBarLineChart } from '@/components/charts/StackedBarLineChart'
import { MultiSeriesChart } from '@/components/charts/MultiSeriesChart'
import { ModelCompareChart } from '@/components/charts/ModelCompareChart'
import { formatCompactValue } from '@/lib/format'
import { buildTrendPoints } from '@/lib/overview'
import { cn } from '@/lib/cn'
import { displayTokens } from '@/lib/agent-usage'
import {
  RANGE_DAYS,
  bucketize,
  bucketWidthDays,
  buildCumulative,
  buildModelRows,
  computeTotals,
  filterByModels,
  groupModelDaily,
  modelColor,
  modelSlots,
  selectTrendSource,
  shortModelName,
  sliceRange,
  type ModelCompareRow,
  type TrendRange,
} from '@/lib/trend-analysis'

/** How many models the split view draws before it stops being readable */
const SPLIT_SERIES_LIMIT = 8

/** Rows the all-time table lists before folding its tail; the ranking is size-ordered */
const CUMULATIVE_ROWS = 30

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

  /**
   * Provider snapshots are the last resort, and reading them parses
   * localStorage — so this is gated on the two series above being unusable
   * instead of being computed on every refresh.
   */
  const apiFallback = useMemo(
    () => (agentUsage.dailySeries.length >= 2 || archived.length >= 2 ? [] : buildTrendPoints(sections)),
    [agentUsage.dailySeries.length, archived.length, sections],
  )

  /**
   * Source selection lives in trend-analysis so the invariant that matters is
   * structural rather than a comment: the per-model rows describe the SCAN
   * series only, so `hasModelDetail` is false for every fallback. Without that
   * flag the model filter summed scan-indexed rows against archive-indexed
   * columns and plotted a model's first day under the window's last label.
   *
   * The scan series is densified there too (days without usage become zero
   * rows), which is what makes "last 30 days" mean 30 calendar days.
   */
  const source = useMemo(
    () =>
      selectTrendSource({
        scan: agentUsage.dailySeries,
        models: modelDaily,
        archive: archived,
        snapshots: apiFallback,
      }),
    [agentUsage.dailySeries, modelDaily, archived, apiFallback],
  )

  /**
   * The per-model rows that match the charted series. Always `source.models`,
   * never the raw `modelDaily`: densifying the day series inserts zero days, so
   * the raw rows would be off by every inserted position.
   */
  const modelSeries = source.models
  const modelUiEnabled = source.hasModelDetail
  /**
   * The view actually rendered. A fallback source carries no per-model rows, so
   * the split view must not be reachable; forcing it here leaves the user's own
   * choice in `view` intact for when the scan recovers.
   */
  const activeView = modelUiEnabled ? view : 'aggregate'

  /**
   * All-time figures for the block below the comparison chart.
   *
   * Coverage comes from the SCAN series, never from `source.points`: the
   * headline is an all-time figure while a fallback series covers a much
   * shorter window, and pairing the two reported "0 days" beside a non-zero
   * total on a first-day scan.
   *
   * A model filter narrows every other figure on the page, so the headline
   * follows the selection too — `rowSum` is exactly the selected models' total.
   */
  const cumulative = useMemo(() => {
    const selected = modelUiEnabled
      ? picked.length > 0
        ? modelSeries.filter((m) => picked.includes(m.model))
        : modelSeries
      : []
    const vm = buildCumulative(
      agentUsage.dailySeries,
      selected,
      displayTokens(agentUsage.allTimeTotal, mode),
      mode,
    )
    return modelUiEnabled && picked.length > 0 ? { ...vm, tokens: vm.rowSum } : vm
  }, [agentUsage.dailySeries, agentUsage.allTimeTotal, modelUiEnabled, modelSeries, picked, mode])
  /** Without a scan there is no all-time figure to show */
  const showCumulative = agentUsage.allTimeTotal.tokens > 0
  const cumulativeShown = cumulative.rows.slice(0, CUMULATIVE_ROWS)
  const cumulativeRest = cumulative.rows.slice(CUMULATIVE_ROWS)
  const cumulativeRestTokens = cumulativeRest.reduce((s, r) => s + r.tokens, 0)
  /**
   * Model-filtered view. `modelDaily` carries no input/cache split (tokscale
   * reports the breakdown per day, not per model), so a filtered selection
   * cannot report a cache hit rate — the flag below tells the UI to say
   * "unavailable" instead of rendering a misleading 0%.
   */
  const isFiltered = modelUiEnabled && picked.length > 0

  /**
   * The cache hit rate needs a per-day input/cache split, which only the scan
   * series carries: a model filter collapses it (the scan breaks the split down
   * per day, never per model) and a fallback source never had it at all.
   * Rendering "0.0%" there reads as "cache never hit" rather than "not
   * measured", so this — not `isFiltered` alone — drives the unavailable state.
   */
  const hitRateUnavailable = isFiltered || source.kind !== 'scan'

  const filtered = useMemo(
    () => (modelUiEnabled ? filterByModels(source.points, modelSeries, picked) : source.points),
    [source, modelUiEnabled, modelSeries, picked],
  )

  const windowed = useMemo(() => sliceRange(filtered, range), [filtered, range])
  const buckets = useMemo(() => bucketize(windowed), [windowed])
  const totals = useMemo(() => computeTotals(buckets, mode), [buckets, mode])

  // Split view: the largest models by output over the window, in a stable
  // order so the ranking does not reshuffle as the range changes. Computed
  // before the comparison rows because the palette slots depend on which models
  // are actually drawn (see `modelSlots`).
  const topModels = useMemo(() => {
    if (!modelUiEnabled) return []
    const windowSize = windowed.length
    const sumOverWindow = (values: number[]): number => {
      const start = Math.max(0, values.length - windowSize)
      let s = 0
      for (let i = start; i < values.length; i++) s += values[i] ?? 0
      return s
    }
    return modelSeries
      .filter((m) => picked.length === 0 || picked.includes(m.model))
      .map((m) => ({ m, output: sumOverWindow(m.output) }))
      .sort((a, b) => b.output - a.output)
      .slice(0, SPLIT_SERIES_LIMIT)
      .map((x) => x.m)
  }, [modelSeries, modelUiEnabled, picked, windowed.length])

  // One slot per model, shared by the chips, the split legend and the comparison
  // rows, so a model wears one colour everywhere. The drawn models are placed
  // first and therefore never share a colour with each other — see `modelSlots`
  // for why that ordering is load-bearing.
  const slots = useMemo(() => modelSlots(modelSeries, topModels), [modelSeries, topModels])

  const modelRows = useMemo(
    () =>
      buildModelRows(
        modelSeries.filter((m) => picked.length === 0 || picked.includes(m.model)),
        windowed.length,
        windowed.map((d) => d.activeTimeMs),
        windowed.map((d) => d.messages),
        slots,
      ),
    [modelSeries, picked, windowed, slots],
  )

  const splitSeries = useMemo(() => {
    const offset = Math.max(0, source.points.length - windowed.length)
    const pickedSet = new Set(picked)
    return topModels.map((m) => ({
      // Identity stays the raw id (unique); the label is display-only and can
      // collide after truncation, so it must never key a React list.
      id: m.model,
      name: shortModelName(m.model),
      color: modelColor(slots.get(m.model) ?? 0),
      values: m.output.slice(offset, offset + windowed.length),
      // An empty filter means "everything shown"; the chart's legend uses this
      // to dim the curves a filter has switched off.
      active: picked.length === 0 || pickedSet.has(m.model),
    }))
  }, [topModels, slots, source.points.length, windowed.length, picked])

  const hasLocal = agentUsage.allTimeTotal.tokens > 0 || source.points.length > 0
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

  /**
   * Footnote for the main chart card, which annotates the chart directly above
   * it. Each note is therefore gated on the view whose chart it describes:
   * weekly bucketing and the output-speed series exist only in the aggregate
   * stack, and the per-model chart plots daily points, so neither is true of it.
   *
   * A model filter is the exception — it collapses input and cache for the whole
   * page, the KPI row included, so that note holds in either view.
   */
  const chartNote = isFiltered
    ? t.trends.filteredSplitNote
    : activeView !== 'aggregate'
      ? t.trends.splitKpiNote
      : bucketWidthDays(windowed.length) > 1
        ? t.trends.weeklyNote
        : windowed.length > 0
          ? t.trends.speedHint
          : ''

  /**
   * The trailing column often covers a partial period, so its bar is naturally
   * shorter. Saying so is the difference between "quiet week" and "the tool
   * lost data" — the height alone cannot carry that.
   */
  const lastBucketPartial =
    activeView === 'aggregate' && totals.tokens > 0 && buckets[buckets.length - 1]?.partial === true

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
          value={hitRateUnavailable ? '—' : `${totals.hitRatePct.toFixed(1)}%`}
          valueSlot={
            hitRateUnavailable ? (
              <Tooltip text={t.trends.hitRateUnavailable} bubbleClassName="w-64 whitespace-normal">
                <div className="mt-2 inline-block cursor-help text-[28px] font-semibold leading-tight tabular-nums text-subtle underline decoration-dotted underline-offset-4">
                  —
                </div>
              </Tooltip>
            ) : undefined
          }
          footer={
            hitRateUnavailable ? (
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
      {modelUiEnabled && (
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
            {modelSeries.slice(0, 24).map((m) => {
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
                  <span data-swatch={m.model} className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: modelColor(slots.get(m.model) ?? 0) }} />
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
            {activeView === 'aggregate' ? t.trends.chartTrend : t.trends.chartSplit}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* The aggregate view needs no subtitle: the legend the chart draws
                above the plot already names every series in it. */}
            {activeView === 'byModel' && <span className="text-[11px] text-subtle">{t.trends.chartSplitHint}</span>}
            {modelUiEnabled && (
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
            )}
          </div>
        </div>
        <div className="mt-3">
          {activeView === 'aggregate' ? (
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
                keyboardHint={t.common.chartKeyboardHint}
                partialSuffix={t.trends.partialBucketShort}
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
              keyboardHint={t.common.chartKeyboardHint}
            />
          ) : (
            <p className="py-10 text-center text-xs text-subtle">{t.trends.gathering}</p>
          )}
        </div>
        {chartNote !== '' && <p className="mt-2 text-[11px] text-subtle">{chartNote}</p>}
        {lastBucketPartial && (
          <p className="mt-2 text-[11px] text-subtle">{t.trends.partialBucketNote}</p>
        )}
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
      {/* All-time cumulative. Deliberately outside the range selector: this is
          the one block on the page that does not narrow with the window. */}
      {showCumulative && (
        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">{t.trends.cumulativeTitle}</h2>
            <span className="text-[11px] text-subtle">{t.trends.cumulativeDesc}</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-[11px] text-subtle">{t.trends.cumulativeTotalLabel}</dt>
              <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-foreground">
                {formatCompactValue(cumulative.tokens)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-subtle">{t.trends.cumulativeActiveDays}</dt>
              <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-foreground">
                {t.trends.cumulativeDays(cumulative.activeDays)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-subtle">{t.trends.cumulativeSpan}</dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums text-foreground">
                {cumulative.span ? `${cumulative.span.from} – ${cumulative.span.to}` : '—'}
              </dd>
            </div>
          </dl>

          {cumulative.rows.length > 0 && (
            <div className="mt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs font-semibold text-foreground">{t.trends.cumulativeModels}</h3>
                <span className="max-w-2xl text-[11px] text-subtle">{t.trends.cumulativeModelNote}</span>
              </div>
              <div role="table" aria-label={t.trends.cumulativeModels} className="mt-2">
                <div role="row" className="flex items-center gap-3 border-b border-border/60 pb-1 text-[11px] text-subtle">
                  <span role="columnheader" className="min-w-0 flex-1">{t.overview.colModel}</span>
                  <span role="columnheader" className="w-20 shrink-0 text-right">{t.trends.cumulativeColTokens}</span>
                  <span role="columnheader" className="hidden w-28 shrink-0 sm:block">{t.trends.cumulativeColShare}</span>
                  <span role="columnheader" className="hidden w-16 shrink-0 text-right md:block">{t.trends.seriesOutput}</span>
                  <span role="columnheader" className="hidden w-16 shrink-0 text-right md:block">{t.trends.seriesCalls}</span>
                </div>
                {cumulativeShown.map((r) => (
                  <div role="row" key={r.model} className="flex items-center gap-3 border-b border-border/40 py-2 text-xs">
                    <span role="cell" className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-sm"
                          style={{ backgroundColor: modelColor(slots.get(r.model) ?? 0) }}
                        />
                        <span className="truncate font-medium text-foreground" title={r.model}>
                          {shortModelName(r.model, 28)}
                        </span>
                      </span>
                      {/* Below sm the share / output / call columns are hidden,
                          so they fold under the name instead of vanishing. */}
                      <span className="mt-0.5 block text-[10px] tabular-nums text-subtle sm:hidden">
                        {r.sharePct > 0 ? `${r.sharePct.toFixed(1)}%` : '—'} · {t.trends.seriesOutput}{' '}
                        {formatCompactValue(r.output)} · {t.trends.seriesCalls} {formatCompactValue(r.messages)}
                      </span>
                    </span>
                    <span role="cell" className="w-20 shrink-0 text-right tabular-nums text-foreground">
                      {formatCompactValue(r.tokens)}
                    </span>
                    <span role="cell" className="hidden w-28 shrink-0 items-center gap-2 sm:flex">
                      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${r.sharePct}%`, backgroundColor: modelColor(slots.get(r.model) ?? 0) }}
                        />
                      </span>
                      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                        {r.sharePct > 0 ? `${r.sharePct.toFixed(1)}%` : '—'}
                      </span>
                    </span>
                    <span role="cell" className="hidden w-16 shrink-0 text-right tabular-nums text-muted-foreground md:block">
                      {formatCompactValue(r.output)}
                    </span>
                    <span role="cell" className="hidden w-16 shrink-0 text-right tabular-nums text-muted-foreground md:block">
                      {formatCompactValue(r.messages)}
                    </span>
                  </div>
                ))}
                {cumulativeRest.length > 0 && (
                  <div role="row" className="flex items-center gap-3 border-b border-border/40 py-2 text-xs">
                    <span role="cell" className="min-w-0 flex-1 text-muted-foreground">
                      {t.trends.cumulativeMoreModels(cumulativeRest.length)}
                    </span>
                    <span role="cell" className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                      {formatCompactValue(cumulativeRestTokens)}
                    </span>
                    <span role="cell" className="hidden w-28 shrink-0 sm:block" aria-hidden />
                    <span role="cell" className="hidden w-16 shrink-0 md:block" aria-hidden />
                    <span role="cell" className="hidden w-16 shrink-0 md:block" aria-hidden />
                  </div>
                )}
                <div role="row" className="flex items-center gap-3 pt-2 text-xs font-medium text-foreground">
                  <span role="cell" className="min-w-0 flex-1">{t.trends.cumulativeSum}</span>
                  <span role="cell" className="w-20 shrink-0 text-right tabular-nums">
                    {formatCompactValue(cumulative.rowSum)}
                  </span>
                  <span role="cell" className="hidden w-28 shrink-0 sm:block" aria-hidden />
                  <span role="cell" className="hidden w-16 shrink-0 md:block" aria-hidden />
                  <span role="cell" className="hidden w-16 shrink-0 md:block" aria-hidden />
                </div>
              </div>
            </div>
          )}
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
