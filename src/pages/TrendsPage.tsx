import { TrendingUp } from 'lucide-react'
import { useMemo } from 'react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import { buildTrendPoints } from '@/lib/overview'
import { displayTokens } from '@/lib/agent-usage'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { LineChart } from '@/components/charts/LineChart'
import { StatCard } from '@/components/common/StatCard'
import { formatCompactValue } from '@/components/charts/DonutChart'

/** Trends: daily token series from the local-agent archive (accumulates from first scan) */
export function TrendsPage() {
  const t = useT()
  const { agentUsage, agentDailySeries, sections, settings } = useData()
  const { usageDisplayMode: mode } = settings
  // Graph-derived daily series (immediately available), archive as fallback
  const localPoints = agentUsage.dailySeries.length >= 2 ? agentUsage.dailySeries.slice(-30) : null
  const archived = localPoints ? [] : agentDailySeries(30)
  // Fallback: API-snapshot consumption series when no local agent data exists
  const apiFallback = useMemo(() => buildTrendPoints(sections), [sections])
  const hasLocal = agentUsage.allTimeTotal.tokens > 0 || !!localPoints || archived.length > 0
  const chart =
    localPoints
      ? localPoints.map((p) => ({ label: p.label, value: mode === 'no-cache' ? p.input + p.output : p.value }))
      : archived.length >= 2
        ? archived
        : !hasLocal && apiFallback.length >= 2
          ? apiFallback
          : null

  if (!hasLocal && apiFallback.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title={t.nav.trends} />
        <EmptyState
          icon={<TrendingUp className="h-6 w-6" />}
          title={t.overview.emptyTitle}
          description={t.overview.localUsageEmpty}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t.nav.trends} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          title={t.overview.todayCol}
          icon={TrendingUp}
          value={formatCompactValue(displayTokens(agentUsage.todayTotal, mode))}
        />
        <StatCard
          title={t.overview.monthCol}
          icon={TrendingUp}
          value={formatCompactValue(displayTokens(agentUsage.monthTotal, mode))}
        />
        <StatCard
          title={t.overview.allTimeCol}
          icon={TrendingUp}
          value={formatCompactValue(displayTokens(agentUsage.allTimeTotal, mode))}
        />
      </div>

      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">{t.overview.trendTitle}</h2>
        <div className="mt-3">
          {chart ? (
            <LineChart points={chart} height={260} />
          ) : (
            <p className="py-10 text-center text-xs text-subtle">{t.overview.trendGathering}</p>
          )}
        </div>
        <p className="mt-2 text-[11px] text-subtle">{t.overview.localUsageEmpty}</p>
      </section>
    </div>
  )
}
