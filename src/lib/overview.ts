import type { Section } from './data-context'
import type { ProviderDef, ProviderResult, ProviderStatus } from '../types'
import { convertAmount } from './rates'
import { getConsumedSeries, getTodayConsume } from './snapshots'
import { UNLIMITED_KEY } from './metric-helpers'

/**
 * View-model builders for the overview page. Pure functions from
 * (sections, results, settings) to presentational models — keeps the page
 * components dumb and the data rules testable in one place.
 */

/** A result older than this is treated as offline even when status is ok */
const STALE_MS = 10 * 60_000

/** Share below which a provider is folded into the "Others" bucket */
const DIST_OTHER_THRESHOLD = 0.03

export type AgentStatus = 'online' | 'offline' | 'error'

export interface AgentRowVM {
  key: string
  providerId: string
  providerName: string
  /** Alias when set, else "Provider N" */
  name: string
  logoDef: ProviderDef
  status: AgentStatus
  usagePct: number | null
  used: number | null
  total: number | null
  unlimited: boolean
  balance: { amount: number; currency: string } | null
  errorText: string | null
}

export function buildAgentRows(
  sections: Section[],
  results: Record<string, ProviderResult>,
  now = Date.now(),
): AgentRowVM[] {
  const rows: AgentRowVM[] = []
  for (const sec of sections) {
    for (const card of sec.cards) {
      const result = results[card.key]
      const fresh = result?.status === 'ok' && result.fetchedAt != null && now - result.fetchedAt < STALE_MS
      const status: AgentStatus = fresh ? 'online' : result?.status === 'error' ? 'error' : 'offline'
      const pctMetric = result?.metrics?.find((m) => m.kind === 'percent' && m.percent != null)
      const balMetric = result?.metrics?.find(
        (m) => m.kind === 'balance' && m.remaining != null && m.unit && m.unit !== UNLIMITED_KEY,
      )
      rows.push({
        key: card.key,
        providerId: sec.def.id,
        providerName: sec.def.name,
        name: card.cfg.label?.trim() || `${sec.def.name} ${card.index + 1}`,
        logoDef: sec.def,
        status,
        usagePct: pctMetric?.percent ?? null,
        used: pctMetric?.used ?? null,
        total: pctMetric?.total ?? null,
        unlimited: pctMetric?.unit === UNLIMITED_KEY,
        balance:
          balMetric?.remaining != null && balMetric.unit
            ? { amount: balMetric.remaining, currency: balMetric.unit }
            : null,
        errorText: result?.status === 'error' ? (result.error ?? null) : null,
      })
    }
  }
  return rows
}

export interface KpisVM {
  /** Sum of token-type totals: local agent all-time usage when available,
   *  else provider-reported token quota totals (null = none exposed) */
  totalQuotaTokens: number | null
  /** Cross-account balance converted into the display currency (null = none) */
  balanceDisplay: number | null
  onlineCount: number
  configuredCount: number
  onlineRatePct: number
  todayUsed: number | null
  yesterdayUsed: number | null
}

function tokenTotal(result: ProviderResult | undefined): number | null {
  let sum: number | null = null
  for (const m of result?.metrics ?? []) {
    if (m.kind === 'percent' && m.total != null && m.unit && /token/i.test(m.unit)) {
      sum = (sum ?? 0) + m.total
    }
  }
  return sum
}

export function buildKpis(
  sections: Section[],
  results: Record<string, ProviderResult>,
  displayCurrency: string,
  now = Date.now(),
  localAllTimeTokens: number | null = null,
): KpisVM {
  const rows = buildAgentRows(sections, results, now)
  const online = rows.filter((r) => r.status === 'online')
  let balance: number | null = null
  let apiTokenSum: number | null = null
  for (const sec of sections) {
    for (const card of sec.cards) {
      const result = results[card.key]
      if (result?.status !== 'ok') continue
      const qt = tokenTotal(result)
      if (qt != null) apiTokenSum = (apiTokenSum ?? 0) + qt
      const bal = result.metrics?.find(
        (m) => m.kind === 'balance' && m.remaining != null && m.unit && m.unit !== UNLIMITED_KEY,
      )
      if (bal?.remaining != null && bal.unit) {
        const converted = convertAmount(bal.remaining, bal.unit, displayCurrency)
        if (converted != null) balance = (balance ?? 0) + converted
      }
    }
  }
  // "Total quota" prefers real measured usage (local agents, all-time) over
  // provider-reported quota totals — the two are different scales and mixing
  // them would be misleading.
  const totalQuota = localAllTimeTokens ?? apiTokenSum
  const { today, yesterday } = getTodayConsume(rows.map((r) => r.key))
  return {
    totalQuotaTokens: totalQuota,
    balanceDisplay: balance,
    onlineCount: online.length,
    configuredCount: rows.length,
    onlineRatePct: rows.length > 0 ? Math.round((online.length / rows.length) * 100) : 0,
    todayUsed: today,
    yesterdayUsed: yesterday,
  }
}

export interface DistSliceVM {
  label: string
  value: number
  color: string
}

/** Providers that reported a convertible balance, richest first (KPI brand chips) */
export interface BalanceProviderInfo {
  def: Section['def']
  /** Converted into the display currency (what the aggregated figure uses) */
  amount: number
  /** Native-unit figure straight from the provider metric */
  rawAmount: number
  unit: string
}

/**
 * One entry per provider (and currency), richest first. The KPI card shows
 * the converted total with brand chips; the breakdown powers the hover list
 * so several pay-as-you-go balances stay tellable apart.
 */
export function buildBalanceProviders(
  sections: Section[],
  results: Record<string, ProviderResult>,
  displayCurrency: string,
): BalanceProviderInfo[] {
  const per = new Map<string, BalanceProviderInfo>()
  for (const sec of sections) {
    for (const card of sec.cards) {
      const result = results[card.key]
      if (result?.status !== 'ok') continue
      const bal = result.metrics?.find(
        (m) => m.kind === 'balance' && m.remaining != null && m.unit && m.unit !== UNLIMITED_KEY,
      )
      if (bal?.remaining == null || !bal.unit) continue
      // Key includes the unit: one provider paying out in two currencies
      // legitimately shows two lines (symbols would otherwise lie)
      const converted = convertAmount(bal.remaining, bal.unit, displayCurrency)
      if (converted == null) continue
      const key = `${sec.def.id}|${bal.unit}`
      const hit =
        per.get(key) ?? { def: sec.def, amount: 0, rawAmount: 0, unit: bal.unit }
      hit.amount += converted
      hit.rawAmount += bal.remaining
      per.set(key, hit)
    }
  }
  return [...per.values()].sort((a, b) => b.amount - a.amount)
}

export const DIST_COLORS = ['#6366F1', '#F59E0B', '#EF4444', '#8B5CF6', '#0EA5E9', '#14B8A6', '#64748B']

/** Provider-share slices of token quota totals; small shares fold into `otherLabel` */
export function buildDistribution(
  sections: Section[],
  results: Record<string, ProviderResult>,
  otherLabel: string,
): { slices: DistSliceVM[]; total: number } {
  const perProvider = new Map<string, { label: string; value: number }>()
  let total = 0
  for (const sec of sections) {
    for (const card of sec.cards) {
      const qt = tokenTotal(results[card.key])
      if (qt == null) continue
      const hit = perProvider.get(sec.def.id) ?? { label: sec.def.name, value: 0 }
      hit.value += qt
      perProvider.set(sec.def.id, hit)
      total += qt
    }
  }
  const sorted = [...perProvider.values()].sort((a, b) => b.value - a.value)
  const main: DistSliceVM[] = []
  let otherValue = 0
  for (const p of sorted) {
    if (total > 0 && p.value / total < DIST_OTHER_THRESHOLD) otherValue += p.value
    else main.push({ label: p.label, value: p.value, color: '' })
  }
  if (otherValue > 0) main.push({ label: otherLabel, value: otherValue, color: '#4B4B63' })
  // The muted "other" tone must survive the palette assignment
  main.forEach((s, i) => {
    if (s.color) return
    s.color = DIST_COLORS[i % DIST_COLORS.length]
  })
  return { slices: main, total }
}

/** 7-day (default) consumed-tokens series for the trend chart; [] until data exists */
export function buildTrendPoints(sections: Section[], days = 7): { label: string; value: number }[] {
  const keys = sections.flatMap((s) => s.cards.map((c) => c.key))
  const series: DayPointLike[] = getConsumedSeries(keys, days)
  const points = series
    .filter((p): p is DayPointLike & { used: number } => p.used != null)
    .map((p) => ({ label: p.label, value: p.used }))
  return points.length >= 2 ? points : []
}

interface DayPointLike {
  label: string
  used: number | null
}

export interface PlanWindowVM {
  id: string
  label: string
  pct: number
  resetsAt: number | null
  used: number | null
  total: number | null
  unlimited: boolean
}

export interface PlanCardVM {
  key: string
  providerId: string
  providerName: string
  accountName: string
  logoDef: ProviderDef
  /** Query state of the account: ok renders windows; others render an empty-state card */
  status: ProviderStatus
  windows: PlanWindowVM[]
  /** First balance metric incl. its detail rows (top-up / grant breakdown) */
  balance: { amount: number; currency: string; details: { label: string; value: number }[] } | null
  /** True when any window is at/over the attention threshold (drives the badge) */
  attention: boolean
}

const PLAN_ATTENTION_PCT = 90

export function buildPlanCards(
  sections: Section[],
  results: Record<string, ProviderResult>,
): PlanCardVM[] {
  const cards: PlanCardVM[] = []
  for (const sec of sections) {
    for (const card of sec.cards) {
      const result = results[card.key]
      // Show every account card even before its first successful query:
      // hiding newly-added accounts read as "lost data" on the plans page.
      const status: ProviderStatus = result?.status ?? 'unconfigured'
      const windows: PlanWindowVM[] =
        status === 'ok' && result.metrics
          ? result.metrics
              .filter((m) => m.kind === 'percent' && m.percent != null)
              .map((m) => ({
                id: m.id,
                label: m.label,
                pct: m.percent ?? 0,
                resetsAt: m.resetsAt ?? null,
                used: m.used ?? null,
                total: m.total ?? null,
                unlimited: m.unit === UNLIMITED_KEY,
              }))
          : []
      const bal =
        status === 'ok' && result.metrics
          ? result.metrics.find(
              (m) => m.kind === 'balance' && m.remaining != null && m.unit && m.unit !== UNLIMITED_KEY,
            )
          : undefined
      cards.push({
        key: card.key,
        providerId: sec.def.id,
        providerName: sec.def.name,
        accountName: card.cfg.label?.trim() || `${sec.def.name} ${card.index + 1}`,
        logoDef: sec.def,
        status,
        windows,
        balance:
          bal?.remaining != null && bal.unit
            ? { amount: bal.remaining, currency: bal.unit, details: bal.detail ?? [] }
            : null,
        attention: windows.some((w) => w.pct >= PLAN_ATTENTION_PCT),
      })
    }
  }
  return cards
}
