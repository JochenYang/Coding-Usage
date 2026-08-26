import { CircleDollarSign } from 'lucide-react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { formatCompactValue } from '@/components/charts/DonutChart'

function costText(costUsd: number): string {
  return costUsd > 0 ? `$${costUsd.toFixed(costUsd < 1 ? 3 : 2)}` : '—'
}

/** Shared cost bar list: label + token/cost with a proportional accent bar */
function CostList({
  rows,
  maxCost,
}: {
  rows: { label: string; tokens: number; costUsd: number }[]
  maxCost: number
}) {
  return (
    <div className="mt-3 space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="space-y-1">
          <div className="flex items-center gap-3 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatCompactValue(row.tokens)}</span>
            <span className="w-20 shrink-0 text-right tabular-nums text-foreground">{costText(row.costUsd)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${maxCost > 0 ? Math.max(2, (row.costUsd / maxCost) * 100) : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Cost analysis: current-month spend by provider and by model (real tokscale cost) */
export function CostAnalysisPage() {
  const t = useT()
  const { agentUsage } = useData()
  const hasCost = agentUsage.monthTotal.costUsd > 0

  if (!hasCost) {
    return (
      <div className="space-y-4">
        <PageHeader title={t.nav.costAnalysis} />
        <EmptyState
          icon={<CircleDollarSign className="h-6 w-6" />}
          title={t.overview.emptyTitle}
          description={t.overview.emptyDesc}
        />
      </div>
    )
  }

  const maxProvider = Math.max(...agentUsage.monthCostByProvider.map((r) => r.costUsd), 0)
  const maxModel = Math.max(...agentUsage.monthCostByModel.map((r) => r.costUsd), 0)

  return (
    <div className="space-y-4">
      <PageHeader title={t.nav.costAnalysis} />

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {costText(agentUsage.monthTotal.costUsd)}
          </span>
          <span className="text-xs text-muted-foreground">
            {t.overview.monthCol} · {formatCompactValue(agentUsage.monthTotal.tokens)} tokens
          </span>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">{t.overview.colProvider}</h2>
          <CostList rows={agentUsage.monthCostByProvider} maxCost={maxProvider} />
        </section>
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">{t.overview.colModel}</h2>
          <CostList rows={agentUsage.monthCostByModel.slice(0, 10)} maxCost={maxModel} />
        </section>
      </div>
    </div>
  )
}
