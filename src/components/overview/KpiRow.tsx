import type { ReactNode } from 'react'
import { Briefcase, CircleDollarSign, TrendingUp, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { currencySymbol, formatAmount, formatCompactValue } from '@/lib/format'
import type { BalanceProviderInfo, KpisVM } from '@/lib/overview'
import { ProviderLogo } from '@/components/ProviderLogo'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/beui/popover'
import { useLocale } from '@/i18n/LocaleProvider'
import { StatCard } from '@/components/common/StatCard'
import { useT } from '@/i18n/useT'

export interface KpiRowProps {
  kpis: KpisVM
  /** Display currency the balance figure was converted into (drives the symbol) */
  displayCurrency: string
  /** Per-provider (+currency) balances, richest first — drives chips & hover list */
  balanceItems?: BalanceProviderInfo[]
  className?: string
}

/** Em-dash placeholder keeps all four cards visually aligned when data is missing */
function Dash() {
  return <span className="text-xs text-subtle">&mdash;</span>
}

/** Top row of overview KPI cards: quota / balance / online / today's usage */
export function KpiRow({ kpis, displayCurrency, balanceItems, className }: KpiRowProps) {
  const t = useT()
  const { locale } = useLocale()

  const balanceInfos = balanceItems ?? []
  // Distinct provider marks for the chip cluster (a provider may appear twice
  // when it holds two currencies)
  const chipDefs = [...new Map(balanceInfos.map((i) => [i.def.id, i.def])).values()]
  const balanceValue =
    kpis.balanceDisplay != null
      ? `${currencySymbol(displayCurrency)}${formatAmount(kpis.balanceDisplay, locale)}`
      : '—'

  // 0 providers → generic glyph; 1 → its brand mark; several → overlapped
  // cluster plus a hover breakdown so multiple pay-as-you-go balances stay
  // tellable apart without cramming the card
  let balanceCard = (
    <StatCard
      title={t.overview.kpiBalance}
      icon={CircleDollarSign}
      iconClassName="text-warning"
      value={balanceValue}
      footer={<Dash />}
    />
  )
  if (balanceInfos.length === 1) {
    balanceCard = (
      <StatCard
        title={t.overview.kpiBalance}
        icon={CircleDollarSign}
        iconSlot={
          <ProviderLogo
            def={balanceInfos[0].def}
            className="h-8 w-8 rounded-lg bg-muted"
            imgClassName="h-4 w-4"
          />
        }
        value={balanceValue}
        footer={<Dash />}
      />
    )
  } else if (balanceInfos.length > 1) {
    balanceCard = (
      <Popover trigger="hover" align="start">
        <PopoverTrigger>
          <div className="w-full cursor-default text-left">
            <StatCard
              title={t.overview.kpiBalance}
              icon={CircleDollarSign}
              iconSlot={
                <span className="flex -space-x-2">
                  {chipDefs.slice(0, 2).map((def) => (
                    <ProviderLogo
                      key={def.id}
                      def={def}
                      className="h-8 w-8 rounded-lg ring-2 ring-accent-soft"
                      imgClassName="h-4 w-4"
                    />
                  ))}
                </span>
              }
              value={balanceValue}
              footer={<Dash />}
            />
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-auto min-w-[16rem] p-3">
          <ul className="space-y-1.5">
            {balanceInfos.map((info) => (
              <li key={`${info.def.id}|${info.unit}`} className="flex items-center gap-2 text-xs">
                <ProviderLogo def={info.def} className="h-5 w-5 rounded-md" imgClassName="h-3 w-3" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {info.def.name}
                  <span className="ml-1 text-subtle">{info.unit}</span>
                </span>
                <span className="tabular-nums text-foreground">
                  {`${currencySymbol(info.unit)}${formatAmount(info.rawAmount, locale)}`}
                </span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    )
  }

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
      {balanceCard}
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
