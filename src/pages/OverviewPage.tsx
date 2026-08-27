import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Plus } from 'lucide-react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import {
  DIST_COLORS,
  buildAgentRows,
  buildDistribution,
  buildKpis,
  buildPlanCards,
  buildTrendPoints,
} from '@/lib/overview'
import { displayTokens } from '@/lib/agent-usage'
import { KpiRow } from '@/components/overview/KpiRow'
import { TrendCard } from '@/components/overview/TrendCard'
import { DistributionCard } from '@/components/overview/DistributionCard'
import { AgentsTable } from '@/components/overview/AgentsTable'
import { LocalUsageCard } from '@/components/overview/LocalUsageCard'
import { AlertsPanel } from '@/components/overview/AlertsPanel'
import { PlanCardsRow } from '@/components/overview/PlanCardsRow'
import { EmptyState } from '@/components/common/EmptyState'

/**
 * Overview page: KPI row + trend (top), agents table + distribution/alerts
 * (middle), plan cards (bottom). All models come from lib/overview builders;
 * this component only wires data to presentational pieces.
 */
export function OverviewPage({
  onAddAccount,
  onEditAccount,
  onOpenAlerts,
}: {
  onAddAccount: () => void
  /** Open the account drawer for a specific row ("providerId-index") */
  onEditAccount: (providerId: string, index: number) => void
  onOpenAlerts: () => void
}) {
  const t = useT()
  const { sections, results, settings, alerts, agentFilter, agentUsage, agentUsageLoading, refreshAgentUsage, agentDailySeries } =
    useData()

  // Low-frequency clock so stale/offline derivation (10 min STALE_MS) stays
  // honest even when auto-refresh is off and results never change.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const rows = useMemo(() => buildAgentRows(sections, results, now), [sections, results, now])
  const kpis = useMemo(() => {
    const k = buildKpis(
      sections,
      results,
      settings.displayCurrency,
      now,
      agentUsage.allTimeTotal.tokens > 0 ? displayTokens(agentUsage.allTimeTotal, settings.usageDisplayMode) : null,
    )
    // Today's consumption prefers the measured local-agent total over the
    // API-snapshot delta (which only accumulates while the app runs).
    if (agentUsage.todayTotal.tokens > 0) {
      k.todayUsed = displayTokens(agentUsage.todayTotal, settings.usageDisplayMode)
    }
    return k
  }, [sections, results, settings.displayCurrency, settings.usageDisplayMode, now, agentUsage])
  const dist = useMemo(() => {
    // Provider distribution prefers real measured spend (local agents, by
    // provider); the API-quota share is the fallback when no local data exists.
    if (agentUsage.monthCostByProvider.length > 0) {
      return {
        slices: agentUsage.monthCostByProvider.map((r, i) => ({
          label: r.label,
          value: r.tokens,
          color: DIST_COLORS[i % DIST_COLORS.length],
        })),
        total: agentUsage.monthTotal.tokens,
      }
    }
    return buildDistribution(sections, results, t.overview.distOther)
  }, [agentUsage, sections, results, t])
  // Trend prefers the graph-derived daily series; daily archive is the fallback
  const trend = useMemo(() => {
    const toValue = (p: { value: number; input: number; output: number }) =>
      settings.usageDisplayMode === 'no-cache' ? p.input + p.output : p.value
    const local = agentUsage.dailySeries.slice(-7)
    if (local.length >= 2) return local.map((p) => ({ label: p.label, value: toValue(p) }))
    const archived = agentDailySeries(7)
    return archived.length >= 2 ? archived : buildTrendPoints(sections)
  }, [agentUsage, agentDailySeries, sections, settings.usageDisplayMode])
  const plans = useMemo(() => buildPlanCards(sections, results), [sections, results])
  // Top-bar global provider filter ('all' = everything)
  const visibleRows = useMemo(
    () => (agentFilter === 'all' ? rows : rows.filter((r) => r.providerId === agentFilter)),
    [rows, agentFilter],
  )

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 className="h-6 w-6" />}
        title={t.overview.emptyTitle}
        description={t.overview.emptyDesc}
        action={
          <button
            type="button"
            onClick={onAddAccount}
            className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-transform hover:scale-[1.02] hover:bg-accent-strong"
          >
            <Plus className="h-4 w-4" />
            {t.empty.openSettings}
          </button>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1">
          <KpiRow kpis={kpis} displayCurrency={settings.displayCurrency} className="h-full" />
        </div>
        <div className="w-full shrink-0 xl:w-[360px]">
          <TrendCard points={trend} className="h-full" />
        </div>
      </div>

      <LocalUsageCard usage={agentUsage} loading={agentUsageLoading} onRefresh={refreshAgentUsage} />

      <div className="flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1">
          <AgentsTable
            rows={visibleRows}
            onEdit={(rowKey) => {
              const split = rowKey.lastIndexOf('-')
              onEditAccount(rowKey.slice(0, split), Number(rowKey.slice(split + 1)))
            }}
          />
        </div>
        <div className="w-full shrink-0 space-y-4 xl:w-[360px]">
          <DistributionCard slices={dist.slices} total={dist.total} />
          <AlertsPanel alerts={alerts} onViewAll={onOpenAlerts} />
        </div>
      </div>

      <PlanCardsRow cards={plans} onAdd={onAddAccount} />
    </div>
  )
}
