import { useEffect, useMemo, useState } from 'react'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import {
  DIST_COLORS,
  DIST_OTHER_COLOR,
  buildAgentRows,
  buildBalanceProviders,
  buildDistribution,
  buildKpis,
  buildTrendPoints,
} from '@/lib/overview'
import { displayTokens } from '@/lib/agent-usage'
import { alertDetail, alertTitle } from '@/lib/alert-text'
import { KpiRow } from '@/components/overview/KpiRow'
import { TrendCard } from '@/components/overview/TrendCard'
import { DistributionCard } from '@/components/overview/DistributionCard'
import { AttentionList, type AttentionItem } from '@/components/overview/AttentionList'
import { LocalUsageCard } from '@/components/overview/LocalUsageCard'

/**
 * Distribution legend shows the top slices plus one folded "other" bucket:
 * enough to read the spend structure at a glance, few enough that every arc
 * clears the donut's rounded-cap inset (~6% share minimum draws visibly).
 * The threshold is lower than the inset so the donut still shows a couple of
 * small-but-real providers, mirroring the cost analysis page's provider list.
 */
const MAX_DIST_SLICES = 6
const MIN_SLICE_SHARE = 0.03

/**
 * Overview page: KPI row + trend (top), local usage, then attention list +
 * distribution (bottom). All models come from lib/overview builders; this
 * component only wires data to presentational pieces. Recent alerts live in
 * the top bar's hover popover and the alerts page, not on this canvas.
 *
 * The full agents table and plan cards used to repeat here — both detail
 * views keep living on their own pages, so the overview only surfaces what
 * needs attention (error accounts + unread alerts).
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
    // Provider distribution prefers real measured spend (local agents, by
    // provider); the API-quota share is the fallback when no local data
    // exists. Providers are ordered by cost so the donut legend reads like the
    // cost analysis page (which sorts the same list by cost). Long tails fold
    // into "other" so the card renders fully without scrolling.
    if (agentUsage.monthCostByProvider.length > 0) {
      const sorted = [...agentUsage.monthCostByProvider].sort((a, b) => b.costUsd - a.costUsd)
      const monthTotal = agentUsage.monthTotal.tokens || 1
      const slices: { label: string; value: number; color: string }[] = []
      let rest = 0
      for (const r of sorted) {
        // Always keep the biggest slice even when it alone is below the floor,
        // so a flat distribution still shows something other than "other"
        if (
          slices.length < MAX_DIST_SLICES &&
          (r.tokens / monthTotal >= MIN_SLICE_SHARE || slices.length === 0)
        ) {
          slices.push({
            label: r.label,
            value: r.tokens,
            color: DIST_COLORS[slices.length % DIST_COLORS.length],
          })
        } else {
          rest += r.tokens
        }
      }
      // Same muted tone lib/overview's threshold fold uses
      if (rest > 0) slices.push({ label: t.overview.distOther, value: rest, color: DIST_OTHER_COLOR })
      return { slices, total: agentUsage.monthTotal.tokens, asOf: agentUsage.scannedAt }
    }
    return { ...buildDistribution(sections, results, t.overview.distOther), asOf: null }
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
  // Attention items: unread alerts first (they carry the actionable state),
  // then error accounts (a failed fetch is often stale rather than fatal —
  // the next refresh fixes it). Dedup by account: an alert for an errored
  // account is dropped, the account row (with its live error text) wins.
  // Capped — the overview is a dashboard, not the log.
  const attention = useMemo<AttentionItem[]>(() => {
    const items: AttentionItem[] = []
    const erroredKeys = new Set(rows.filter((r) => r.status === 'error').map((r) => r.key))
    for (const a of alerts) {
      if (a.read) continue
      // Alerts embed the account key in their id ("key:kind:metric")
      if (erroredKeys.has(a.accountKey)) continue
      items.push({ key: a.id, title: alertTitle(a, t), detail: alertDetail(a, t), level: a.level })
    }
    for (const r of rows) {
      if (r.status !== 'error') continue
      items.push({ key: r.key, title: r.name, detail: r.errorText, level: 'danger', editKey: r.key })
    }
    return items.slice(0, 6)
  }, [rows, alerts, t])
  // Richest-first providers behind the balance KPI (brand chips on the card)
  const balanceProviders = useMemo(
    () => buildBalanceProviders(sections, results, settings.displayCurrency, fxRates),
    [sections, results, settings.displayCurrency, fxRates],
  )

  // No early return when nothing is configured/fetched yet: the full overview
  // framework always renders, and each card degrades to its own honest empty
  // state (dash KPIs, hint lists, grey donut). A bare "add account" screen hid
  // where numbers WOULD appear and read like a broken dashboard.

  return (
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

      <div className="flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1">
          <AttentionList
            items={attention}
            onEdit={(rowKey) => {
              const split = rowKey.lastIndexOf('-')
              onEditAccount(rowKey.slice(0, split), Number(rowKey.slice(split + 1)))
            }}
            onViewAll={onViewAllAlerts}
            className="h-full"
          />
        </div>
        {/* Stretch to the list's height so the two columns read as one band */}
        <div className="w-full shrink-0 xl:w-[360px]">
          <DistributionCard
            slices={dist.slices}
            total={dist.total}
            centerLabel={dist.asOf != null ? t.overview.distMonthUsage : t.overview.distTotal}
            asOf={dist.asOf}
            className="h-full"
          />
        </div>
      </div>
    </div>
  )
}
