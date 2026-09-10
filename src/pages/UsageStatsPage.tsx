import { BarChart3 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import { useLocale } from '@/i18n/LocaleProvider'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { LocalUsageCard } from '@/components/overview/LocalUsageCard'
import { displayDayTokens } from '@/lib/agent-usage'
import { Heatmap, HEAT_FILLS } from '@/components/charts/Heatmap'
import { buildHeatmapCells, toCumulativeCells, toWeeklyCells } from '@/lib/heatmap'
import { cn } from '@/lib/cn'
import { currencySymbol, formatCompactValue } from '@/lib/format'
import { convertAmount } from '@/lib/rates'

/** Usage statistics: live local-agent totals (today/month/all-time) + model detail */
export function UsageStatsPage() {
  const t = useT()
  const { locale } = useLocale()
  const { agentUsage, agentUsageLoading, refreshAgentUsage, settings, fxRates } = useData()
  const mode = settings.usageDisplayMode
  const hasData = agentUsage.allTimeTotal.tokens > 0
  // 12-week activity heatmap from the graph daily series (mode-aware values)
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short' }), [locale])
  const heatCells = useMemo(() => {
    const days = agentUsage.dailySeries.flatMap((p) =>
      typeof p.day === 'string' ? [{ day: p.day, value: displayDayTokens(p, mode) }] : [],
    )
    return buildHeatmapCells(days, 53)
  }, [agentUsage.dailySeries, mode])
  const heatTotal = useMemo(
    () => heatCells.flat().reduce((s, c) => s + c.value, 0),
    [heatCells],
  )
  /** Grid granularity matching the reference design (daily / weekly / cumulative).
   *  Weekly keeps the same 7-row wall — each cell just reports its week total. */
  const [heatMode, setHeatMode] = useState<'day' | 'week' | 'cumulative'>('day')
  const shownCells = useMemo(() => {
    if (heatMode === 'week') return toWeeklyCells(heatCells)
    if (heatMode === 'cumulative') return toCumulativeCells(heatCells)
    return heatCells
  }, [heatCells, heatMode])
  const heatStats = useMemo(() => {
    const flat = heatCells.flat().filter((c) => c.day !== null)
    let best = { day: '', value: 0 }
    let activeDays = 0
    for (const c of flat) {
      if (c.value <= 0 || c.day === null) continue
      activeDays += 1
      if (c.value > best.value) best = { day: c.day, value: c.value }
    }
    return { activeDays, best }
  }, [heatCells])
  // Cost figures are sourced in USD; render them in the display currency
  const costText = (costUsd: number): string => {
    if (!(costUsd > 0)) return '—'
    const converted = convertAmount(costUsd, 'USD', settings.displayCurrency, fxRates) ?? costUsd
    return `${currencySymbol(settings.displayCurrency)}${converted.toFixed(converted < 1 ? 3 : 2)}`
  }

  if (!hasData) {
    return (
      <div className="space-y-4">
        <PageHeader title={t.nav.usageStats} />
        <EmptyState
          icon={<BarChart3 className="h-6 w-6" />}
          title={t.overview.emptyTitle}
          description={t.overview.emptyDesc}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t.nav.usageStats} />
      <LocalUsageCard usage={agentUsage} loading={agentUsageLoading} onRefresh={refreshAgentUsage} />

      {/* Activity heatmap: rhythm at a glance, exact values on hover */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">{t.overview.heatmapTitle}</h2>
          <div className="flex items-center gap-4">
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatCompactValue(heatTotal)} tokens
            </span>
            <div
              role="tablist"
              aria-label={t.overview.heatmapTitle}
              className="flex items-center gap-0.5 rounded-full bg-muted p-0.5"
            >
              {(
                [
                  ['day', t.overview.heatmapDaily],
                  ['week', t.overview.heatmapWeekly],
                  ['cumulative', t.overview.heatmapCumulative],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={heatMode === v}
                  type="button"
                  onClick={() => setHeatMode(v)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                    heatMode === v
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {heatTotal > 0 ? (
          <div className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-4">
            {/* Fixed-height stage: the wall renders in every mode (weekly cells
                just report their week total), so the card never jumps when
                switching granularity. The scroller stays for narrow screens. */}
            <div className="flex min-h-[132px] min-w-0 flex-1 flex-col justify-center">
              <div className="overflow-x-auto">
                <Heatmap cells={shownCells} formatMonth={(d) => monthFmt.format(d)} ariaLabel={t.overview.heatmapTitle} />
              </div>
            </div>
            <dl className="min-w-36 shrink-0 space-y-3 pt-4">
              <div>
                <dt className="text-[11px] text-subtle">{t.overview.heatmapActiveDays}</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                  {t.overview.heatmapDays(heatStats.activeDays)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-subtle">{t.overview.heatmapBest}</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                  {formatCompactValue(heatStats.best.value)}
                </dd>
                {heatStats.best.day && (
                  <dd className="text-[11px] tabular-nums text-subtle">{heatStats.best.day}</dd>
                )}
              </div>
            </dl>
          </div>
        ) : (
          <p className="py-6 text-center text-xs text-subtle">{t.overview.trendGathering}</p>
        )}
        {heatTotal > 0 && (
          <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-subtle">
            <span>{t.overview.heatmapLess}</span>
            {HEAT_FILLS.map((f) => (
              <span key={f} className={cn('h-2.5 w-2.5 rounded-[3px]', f.replace('fill-', 'bg-'))} />
            ))}
            <span>{t.overview.heatmapMore}</span>
          </div>
        )}
      </section>

      {/* Model detail for today, top by tokens */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">
          {t.overview.todayCol} · {t.overview.colModel}
        </h2>
        {agentUsage.todayByModel.length === 0 ? (
          <p className="mt-3 text-xs text-subtle">{t.overview.emptyTitle}</p>
        ) : (
          <div className="mt-3 divide-y divide-border/60">
            {agentUsage.todayByModel.slice(0, 10).map((row) => (
              <div key={row.label} className="flex items-center gap-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatCompactValue(mode === 'no-cache' ? row.input + row.output : row.tokens)}
                </span>
                <span className="hidden w-20 shrink-0 text-right tabular-nums text-subtle sm:block">
                  {t.overview.colCache} {formatCompactValue(row.cacheRead)}
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                  {costText(row.costUsd)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-subtle">
          {agentUsage.todayTotal.messages} msgs · {costText(agentUsage.todayTotal.costUsd)}
        </p>
      </section>
    </div>
  )
}
