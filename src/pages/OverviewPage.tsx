import { useEffect, useMemo, useState } from 'react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import {
  DIST_OTHER_COLOR,
  buildAgentRows,
  buildBalanceProviders,
  buildDistribution,
  buildKpis,
  buildTrendPoints,
  foldSlices,
} from '@/lib/overview'
import { displayDayTokens, displayTokens } from '@/lib/agent-usage'
import { alertDetail, alertTitle } from '@/lib/alert-text'
import { formatClock } from '@/lib/format'
import { KpiRow } from '@/components/overview/KpiRow'
import { TrendCard } from '@/components/overview/TrendCard'
import { DistributionCard } from '@/components/overview/DistributionCard'
import { RecentActivity, type ActivityItem } from '@/components/overview/RecentActivity'
import { AccountStatusCard, type AccountStatusItem } from '@/components/overview/AccountStatusCard'
import { LocalUsageCard } from '@/components/overview/LocalUsageCard'

/** Recent-activity entries on the canvas; the rest stay on the alerts page */
const MAX_ACTIVITY_ITEMS = 4
/** Agent tiles in the account usage card */
const MAX_ACCOUNT_STATUS_ITEMS = 3

/**
 * Overview page: KPI row + trend (top), local usage, then distribution +
 * recent activity + account usage (bottom). All models come from lib/overview
 * builders and the agent-usage view model; this component only wires data to
 * presentational pieces.
 *
 * The full agents table and plan cards used to repeat here — both detail
 * views keep living on their own pages, so the overview only surfaces what
 * happened lately and what needs attention (error accounts + live alerts).
 * No early return when nothing is configured/fetched yet: the framework always
 * renders, and each card degrades to its own honest empty state.
 */
export function OverviewPage({
  onEditAccount,
  onViewAllAlerts,
}: {
  /** Open the account drawer for a specific row ("providerId-index") */
  onEditAccount: (providerId: string, index: number) => void
  /** Jump to the alerts page */
  onViewAllAlerts: () => void
}) {
  const t = useT()
  const { sections, results, settings, agentUsage, agentUsageLoading, refreshAgentUsage, agentDailySeries, fxRates, alerts } =
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
      fxRates,
    )
    // Today's consumption prefers the measured local-agent total over the
    // API-snapshot delta (which only accumulates while the app runs).
    if (agentUsage.todayTotal.tokens > 0) {
      k.todayUsed = displayTokens(agentUsage.todayTotal, settings.usageDisplayMode)
    }
    return k
  }, [sections, results, settings.displayCurrency, settings.usageDisplayMode, now, agentUsage])
  const dist = useMemo(() => {
    // Shares are measured local-agent usage by agent, over the rolling seven
    // days — the same agents the usage table above lists, so a slice and a row
    // are the same thing. A summary cached before that window existed still
    // carries the month (by model router); with no local data at all, the
    // provider-reported quota totals stand in. The range chip says which.
    const recent = agentUsage.last7ByAgent
    if (recent && recent.length > 0) {
      // Usage that names no agent is in the period total but in no agent's
      // slice. It belongs in the folded "other" slice, so the ring's slices
      // add up to the figure in its centre.
      const slices = foldSlices(recent, t.overview.distOther)
      const unclassified =
        (agentUsage.last7Total?.tokens ?? 0) - recent.reduce((sum, r) => sum + r.tokens, 0)
      if (unclassified > 0) {
        const rest = slices.find((s) => s.label === t.overview.distOther)
        if (rest) rest.value += unclassified
        else slices.push({ label: t.overview.distOther, value: unclassified, color: DIST_OTHER_COLOR })
      }
      return {
        slices,
        total: agentUsage.last7Total?.tokens ?? recent.reduce((sum, r) => sum + r.tokens, 0),
        rangeLabel: t.overview.distRecent7,
        centerLabel: t.overview.distConsumed,
        asOf: agentUsage.scannedAt,
      }
    }
    if (agentUsage.monthCostByProvider.length > 0) {
      return {
        slices: foldSlices(agentUsage.monthCostByProvider, t.overview.distOther),
        total: agentUsage.monthTotal.tokens,
        rangeLabel: t.overview.monthCol,
        centerLabel: t.overview.distConsumed,
        asOf: agentUsage.scannedAt,
      }
    }
    return {
      ...buildDistribution(sections, results, t.overview.distOther),
      rangeLabel: t.overview.distTotal,
      centerLabel: t.overview.distTotal,
      asOf: null,
    }
  }, [agentUsage, sections, results, t])
  // Trend prefers the graph-derived daily series; daily archive is the fallback
  const trend = useMemo(() => {
    const local = agentUsage.dailySeries.slice(-7)
    if (local.length >= 2) return local.map((p) => ({ label: p.label, value: displayDayTokens(p, settings.usageDisplayMode) }))
    const archived = agentDailySeries(7)
    return archived.length >= 2 ? archived : buildTrendPoints(sections)
  }, [agentUsage, agentDailySeries, sections, settings.usageDisplayMode])
  // Recent activity: error accounts first (they are the ones to act on — a
  // failed fetch is often stale rather than fatal, and the next refresh fixes
  // it), then the alerts still live. An alert for an errored account is
  // dropped: the account row, with its live error text, says it.
  //
  // An alert is shown at the time it was last seen, not when it began: a
  // low balance that has held since September is re-derived on every refresh,
  // and under "recent" its date would read as stale data. When it has held
  // for more than a day, the detail says since when.
  // Capped — the overview is a dashboard, not the log.
  const activity = useMemo<ActivityItem[]>(() => {
    const failed: ActivityItem[] = []
    const erroredKeys = new Set<string>()
    for (const r of rows) {
      if (r.status !== 'error') continue
      erroredKeys.add(r.key)
      const fetchedAt = results[r.key]?.fetchedAt
      failed.push({
        key: r.key,
        title: r.name,
        detail: r.errorText,
        level: 'danger',
        time: fetchedAt != null ? formatClock(fetchedAt, now) : undefined,
        editKey: r.key,
      })
    }
    const DAY_MS = 24 * 60 * 60 * 1000
    const live = alerts
      .filter((a) => !a.resolved && !erroredKeys.has(a.accountKey))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(
        (a): ActivityItem => ({
          key: a.id,
          title: alertTitle(a, t),
          detail:
            a.lastSeenAt - a.firstSeenAt > DAY_MS
              ? [alertDetail(a, t), t.overview.alertSince(formatClock(a.firstSeenAt, now))]
                  .filter(Boolean)
                  .join(' · ')
              : alertDetail(a, t),
          level: a.level,
          time: formatClock(a.lastSeenAt, now),
        }),
      )
    return failed.concat(live).slice(0, MAX_ACTIVITY_ITEMS)
  }, [rows, alerts, results, t, now])
  // The agents with the most usage over the last seven days, with whether they
  // ran today. Ranked by the same window as the distribution card beside it:
  // by all-time usage the two cards disagreed (the week's heaviest agent could
  // be missing here while a long-idle one stayed on top).
  const accountStatus = useMemo<AccountStatusItem[]>(
    () =>
      agentUsage.clients
        .filter((c) => (c.last7?.tokens ?? 0) > 0)
        .sort((a, b) => (b.last7?.tokens ?? 0) - (a.last7?.tokens ?? 0))
        .slice(0, MAX_ACCOUNT_STATUS_ITEMS)
        .map((c) => ({
          client: c.client,
          tokens: c.last7?.tokens ?? 0,
          usedToday: c.today.tokens > 0 || c.today.credits > 0 || c.today.messages > 0,
        })),
    [agentUsage],
  )
  // Richest-first providers behind the balance KPI (brand chips on the card)
  const balanceProviders = useMemo(
    () => buildBalanceProviders(sections, results, settings.displayCurrency, fxRates),
    [sections, results, settings.displayCurrency, fxRates],
  )

  return (
    // The mascot in the page's bottom-right corner is the shell's (it sits on
    // the shell's footer wave); this page only lays out its cards
    <div className="space-y-4">
      <div className="flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1">
          <KpiRow
            kpis={kpis}
            displayCurrency={settings.displayCurrency}
            balanceItems={balanceProviders}
            className="h-full"
          />
        </div>
        <div className="w-full shrink-0 xl:w-[360px]">
          <TrendCard points={trend} className="h-full" />
        </div>
      </div>

      <LocalUsageCard usage={agentUsage} loading={agentUsageLoading} onRefresh={refreshAgentUsage} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-4">
          <DistributionCard
            slices={dist.slices}
            total={dist.total}
            centerLabel={dist.centerLabel}
            rangeLabel={dist.rangeLabel}
            asOf={dist.asOf}
            className="h-full"
          />
        </div>
        <div className="min-w-0 xl:col-span-4">
          <RecentActivity
            items={activity}
            onEdit={(rowKey) => {
              const split = rowKey.lastIndexOf('-')
              onEditAccount(rowKey.slice(0, split), Number(rowKey.slice(split + 1)))
            }}
            onViewAll={onViewAllAlerts}
            className="h-full"
          />
        </div>
        <div className="min-w-0 xl:col-span-4">
          <AccountStatusCard items={accountStatus} className="h-full" />
        </div>
      </div>
    </div>
  )
}
