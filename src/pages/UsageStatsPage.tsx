import { BarChart3 } from 'lucide-react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { LocalUsageCard } from '@/components/overview/LocalUsageCard'
import { formatCompactValue } from '@/lib/format'

function costText(costUsd: number): string {
  return costUsd > 0 ? `$${costUsd.toFixed(costUsd < 1 ? 3 : 2)}` : '—'
}

/** Usage statistics: live local-agent totals (today/month/all-time) + model detail */
export function UsageStatsPage() {
  const t = useT()
  const { agentUsage, agentUsageLoading, refreshAgentUsage, settings } = useData()
  const mode = settings.usageDisplayMode
  const hasData = agentUsage.allTimeTotal.tokens > 0

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
