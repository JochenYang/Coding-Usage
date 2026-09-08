import type { Section } from './data-context'
import type { AlertThresholds, ProviderResult } from '../types'

/**
 * Alert engine. Alerts are derived purely from current fetch results (no
 * daemon): every recompute produces the full live set, and the store merge
 * keeps firstSeenAt/read stable for surviving alerts while dropping resolved
 * ones. Items persist structurally (kind + params) — display strings are
 * formatted at render time through i18n so locale switches stay live.
 */

export type AlertLevel = 'danger' | 'warning' | 'info'

export type AlertKind = 'window-reset' | 'high-usage' | 'low-balance'

export interface AlertItem {
  /** Stable id: accountKey + kind + metric id */
  id: string
  level: AlertLevel
  /** Account result key ("providerId-index") */
  accountKey: string
  agentName: string
  kind: AlertKind
  /** kind=window-reset: minutes until reset */
  resetInMin?: number
  /** kind=high-usage: used percent */
  pct?: number
  /** kind=high-usage: used/total in original units */
  used?: number
  total?: number
  /** kind=low-balance: remaining amount + currency code */
  balance?: number
  currency?: string
  firstSeenAt: number
  read: boolean
}

const KEY = 'coding-usage.alerts.v1'

/** Factory defaults matching the original hardcoded behavior */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  resetSoonMin: 60,
  highUsagePct: 90,
  lowBalance: { CNY: 5, USD: 1, HKD: 5, TWD: 30 },
}

/** Bounds guarding the threshold editor (absurd values would spam or silence alerts) */
const RESET_SOON_MIN = { min: 5, max: 720 }
const HIGH_USAGE_PCT = { min: 50, max: 100 }
const LOW_BALANCE_MAX = 1_000_000

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

function clampAmount(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  return Math.min(LOW_BALANCE_MAX, n)
}

/**
 * Validate raw (stored) thresholds into a safe shape. Unknown input falls
 * back per-field so one corrupt value cannot wipe the other settings.
 */
export function resolveThresholds(raw: unknown): AlertThresholds {
  const o = (raw ?? {}) as Partial<AlertThresholds>
  const low = { ...DEFAULT_ALERT_THRESHOLDS.lowBalance }
  if (o.lowBalance != null && typeof o.lowBalance === 'object') {
    for (const [k, v] of Object.entries(o.lowBalance)) {
      low[k.toUpperCase()] = clampAmount(v, low[k.toUpperCase()] ?? 0)
    }
  }
  return {
    resetSoonMin: clampInt(o.resetSoonMin, DEFAULT_ALERT_THRESHOLDS.resetSoonMin, RESET_SOON_MIN.min, RESET_SOON_MIN.max),
    highUsagePct: clampInt(o.highUsagePct, DEFAULT_ALERT_THRESHOLDS.highUsagePct, HIGH_USAGE_PCT.min, HIGH_USAGE_PCT.max),
    lowBalance: low,
  }
}

/** Currency symbols occasionally appear where a code is expected; normalize */
function normalizeCurrency(unit: string): string {
  const u = unit.trim().toUpperCase()
  if (u === '¥' || u === 'RMB') return 'CNY'
  if (u === '$') return 'USD'
  if (u === 'HK$' || u === 'HKD$') return 'HKD'
  if (u === 'NT$') return 'TWD'
  return u
}

function loadStored(): AlertItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Runtime shape guard: drop entries missing the core invariants so a
    // corrupted store cannot poison sorting (NaN firstSeenAt) or unread count.
    return parsed.filter(
      (item): item is AlertItem =>
        item != null &&
        typeof item === 'object' &&
        typeof (item as AlertItem).id === 'string' &&
        typeof (item as AlertItem).firstSeenAt === 'number',
    )
  } catch {
    // corrupted → start clean
  }
  return []
}

export function loadAlerts(): AlertItem[] {
  return loadStored()
}

export function saveAlerts(items: AlertItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    // best-effort
  }
}

/**
 * Derive the live alert set from current sections/results, merged with the
 * stored set (surviving alerts keep firstSeenAt/read; resolved ids are
 * dropped). Pure — the caller persists the result.
 */
export function deriveAlerts(
  sections: Section[],
  results: Record<string, ProviderResult>,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): AlertItem[] {
  const resetSoonMs = thresholds.resetSoonMin * 60_000
  const highUsagePct = thresholds.highUsagePct
  const lowBalance = thresholds.lowBalance
  const live = new Map<string, AlertItem>()
  for (const sec of sections) {
    for (const card of sec.cards) {
      const result = results[card.key]
      if (result?.status !== 'ok' || !result.metrics) continue
      const agentName = card.cfg.label || `${sec.def.name} ${card.index + 1}`
      for (const m of result.metrics) {
        if (m.kind === 'percent' && m.percent != null) {
          // Stale-value guard: a reset point in the past means the window
          // semantics are dead (e.g. a dead subscription still reporting an
          // old 100%) — the percentage is no longer actionable, so the
          // window-reset family of alerts must not survive on it.
          const staleWindow = m.resetsAt != null && m.resetsAt <= Date.now()
          if (m.resetsAt != null) {
            const mins = Math.round((m.resetsAt - Date.now()) / 60_000)
            if (mins > 0 && m.resetsAt - Date.now() <= resetSoonMs && m.percent < 100) {
              const id = `${card.key}:window-reset:${m.id}`
              live.set(id, {
                id,
                level: 'info',
                accountKey: card.key,
                agentName,
                kind: 'window-reset',
                resetInMin: mins,
                firstSeenAt: Date.now(),
                read: false,
              })
            }
          }
          if (m.percent >= highUsagePct && !staleWindow) {
            const id = `${card.key}:high-usage:${m.id}`
            live.set(id, {
              id,
              level: m.percent >= 100 ? 'danger' : 'warning',
              accountKey: card.key,
              agentName,
              kind: 'high-usage',
              pct: Math.round(m.percent),
              used: m.used,
              total: m.total,
              firstSeenAt: Date.now(),
              read: false,
            })
          }
        }
        if (m.kind === 'balance' && m.remaining != null && m.unit) {
          const floor = lowBalance[normalizeCurrency(m.unit)]
          if (floor != null && m.remaining <= floor) {
            const id = `${card.key}:low-balance:${m.id}`
            live.set(id, {
              id,
              level: 'info',
              accountKey: card.key,
              agentName,
              kind: 'low-balance',
              balance: m.remaining,
              currency: m.unit,
              firstSeenAt: Date.now(),
              read: false,
            })
          }
        }
      }
    }
  }

  const stored = loadStored()
  const merged: AlertItem[] = []
  for (const item of live.values()) {
    const prev = stored.find((s) => s.id === item.id)
    merged.push(prev ? { ...item, firstSeenAt: prev.firstSeenAt, read: prev.read } : item)
  }
  // Newest first for panel rendering
  merged.sort((a, b) => b.firstSeenAt - a.firstSeenAt)
  return merged
}

export function unreadCount(items: AlertItem[]): number {
  return items.filter((a) => !a.read).length
}

export function markAllRead(items: AlertItem[]): AlertItem[] {
  return items.map((a) => ({ ...a, read: true }))
}

export function markRead(items: AlertItem[], id: string): AlertItem[] {
  return items.map((a) => (a.id === id ? { ...a, read: true } : a))
}

/** Mark a batch of ids read in one pass (callers must persist the result) */
export function markReadMany(items: AlertItem[], ids: string[]): AlertItem[] {
  const idSet = new Set(ids)
  return items.map((a) => (idSet.has(a.id) ? { ...a, read: true } : a))
}
