import type { ReactNode } from 'react'
import { Briefcase, CircleDollarSign, TrendingUp, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { currencySymbol, formatAmount, formatCompactValue } from '@/lib/format'
import type { KpisVM } from '@/lib/overview'
import { StatCard } from '@/components/common/StatCard'
import { useT } from '@/i18n/useT'

export interface KpiRowProps {
  kpis: KpisVM
  /** Display currency the balance figure was converted into (drives the symbol) */
  displayCurrency: string
  className?: string
}

/** Em-dash placeholder keeps all four cards visually aligned when data is missing */
function Dash() {
  return <span className="text-xs text-subtle">&mdash;</span>
}

/** Top row of overview KPI cards: quota / balance / online / today's usage */
export function KpiRow({ kpis, displayCurrency, className }: KpiRowProps) {
  const t = useT()

  const quotaValue =
    kpis.totalQuotaTokens != null ? formatCompactValue(kpis.totalQuotaTokens) : '—'

  // Card 1 footer repeats today's usage as context for the quota figure
  const quotaFooter =
    kpis.todayUsed != null ? (
      <span className="text-xs text-muted-foreground">
        {`+${formatCompactValue(kpis.todayUsed)} ${t.overview.kpiToday}`}
      </span>
    ) : (
      <Dash />
    )

  // Online-rate tone escalates as availability drops
  const rateTone =
    kpis.onlineRatePct >= 60
      ? 'text-online'
      : kpis.onlineRatePct >= 30
        ? 'text-warning'
        : 'text-danger'

  // Day-over-day delta; higher consumption than yesterday reads red
  let todayFooter: ReactNode = <Dash />
  if (kpis.todayUsed != null && kpis.yesterdayUsed != null && kpis.yesterdayUsed > 0) {
    const delta = ((kpis.todayUsed - kpis.yesterdayUsed) / kpis.yesterdayUsed) * 100
    todayFooter = (
      <span className={cn('text-xs', delta >= 0 ? 'text-danger' : 'text-online')}>
        {`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${t.overview.vsYesterday}`}
      </span>
    )
  }

  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}>
      <StatCard title={t.overview.kpiTotalQuota} icon={Briefcase} value={quotaValue} footer={quotaFooter} />
      <StatCard
        title={t.overview.kpiBalance}
        icon={CircleDollarSign}
        iconClassName="text-warning"
        value={
          kpis.balanceDisplay != null
            ? `${currencySymbol(displayCurrency)}${formatAmount(kpis.balanceDisplay)}`
            : '—'
        }
        footer={<Dash />}
      />
      <StatCard
        title={t.overview.kpiOnline}
        icon={Users}
        value={`${kpis.onlineCount} / ${kpis.configuredCount}`}
        footer={
          <span className={cn('text-xs', rateTone)}>
            {`${kpis.onlineRatePct}% ${t.overview.onlineRate}`}
          </span>
        }
      />
      <StatCard
        title={t.overview.kpiToday}
        icon={TrendingUp}
        value={kpis.todayUsed != null ? formatCompactValue(kpis.todayUsed) : '—'}
        footer={todayFooter}
      />
    </div>
  )
}
