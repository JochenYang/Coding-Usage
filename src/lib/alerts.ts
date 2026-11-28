import type { Section } from './sections'
import type { AlertThresholds, ProviderResult, UsageMetric } from '../types'

/**
 * Alert engine. Alerts are derived purely from current fetch results (no
 * daemon): every recompute produces the full live set, and the store merge
 * keeps firstSeenAt/read stable for surviving alerts while dropping resolved
 * ones. Items persist structurally (kind + params) — display strings are
 * formatted at render time through i18n so locale switches stay live.
 */

export type AlertLevel = 'danger' | 'warning' | 'info'

export type AlertKind = 'window-reset' | 'high-usage' | 'low-balance' | 'window-restored'

export interface AlertItem {
  /** Stable id: accountKey + kind + metric id */
  id: string
  level: AlertLevel
  /**
   * Source key: an account result key ("providerId-index") for provider
   * metrics, or the subscription card key ("claude", "codex") for a
   * subscription quota window.
   */
  accountKey: string
  agentName: string
  kind: AlertKind
  /**
   * The window (metric id) this alert is about. Multi-window sources (a
   * 5-hour and a weekly plan window) raise one alert per window under the
   * same agent name; the id carries it, and consumers that build a new id
   * from an existing alert (the restore timer) read it from here instead of
   * parsing the id.
   */
  metricId?: string
  /**
   * Window display name in the locale the last derive ran under (the
   * metric's label). Persisted so a stored row keeps rendering; the next
   * derive overwrites it, so a locale switch re-labels live rows.
   */
  windowLabel?: string
  /** kind=window-reset: minutes until reset */
  resetInMin?: number
  /**
   * Window reset time (epoch ms) for kind=high-usage and window-restored:
   * an exhausted window shows when it recovers, and a restored row records
   * which reset it announced.
   */
  resetsAt?: number
  /** kind=high-usage: used percent */
  pct?: number
  /** kind=high-usage: used/total in original units */
  used?: number
  total?: number
  /** kind=low-balance: remaining amount + currency code */
  balance?: number
  currency?: string
  /**
   * True for retained history: the condition cleared, but the row stays
   * visible for the retention window. Consumers that act on alerts (push,
   * attention list, island popups) must ignore resolved rows — only the
   * alerts center renders them, dimmed, as history.
   */
  resolved?: boolean
  firstSeenAt: number
  /**
   * Last derive round in which this alert was live. Retention for resolved
   * alerts counts from here (not firstSeenAt): a condition that cleared is
   * kept for {@link RESOLVED_RETENTION_MS} after it was LAST seen, so a
   * long-lived alert stays readable after resolving instead of vanishing at
   * once. Written on every derive that sees the alert live.
   */
  lastSeenAt: number
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

/** Persist the alerts; false when the list could not be written. */
export function saveAlerts(items: AlertItem[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
    return true
  } catch {
    // best-effort
    return false
  }
}

/**
 * Apply an account-key rename to the stored alerts. An alert's id starts with
 * its account key and it repeats that key in `accountKey`, so an account that
 * moved to another index would otherwise inherit the read state and
 * first-seen time of whatever account held that key before, and keep pointing
 * at the old key. A no-op when no stored alert belongs to a renamed account.
 * False when the renamed list could not be written, so the caller knows the
 * rename has not happened yet.
 */
export function renameAlertAccountKeys(renamed: Record<string, string>): boolean {
  const froms = Object.keys(renamed)
  if (froms.length === 0) return true
  const items = loadStored()
  // The `:` after the key keeps `kimi` from matching an alert of `kimi-intl`
  const ownerOf = (id: string): string | undefined => froms.find((from) => id.startsWith(`${from}:`))
  if (!items.some((item) => ownerOf(item.id) !== undefined)) return true
  const seen = new Set<string>()
  const unique: AlertItem[] = []
  for (const item of items) {
    const from = ownerOf(item.id)
    const next =
      from === undefined
        ? item
        : {
            ...item,
            id: `${renamed[from]}:${item.id.slice(from.length + 1)}`,
            ...(item.accountKey === from ? { accountKey: renamed[from] } : {}),
          }
    // An alert already filed under the new id makes a duplicate; keep the first
    if (seen.has(next.id)) continue
    seen.add(next.id)
    unique.push(next)
  }
  return saveAlerts(unique)
}

/**
 * Retention for resolved alerts: an alert whose condition cleared stays in
 * the list for 48h counting from when it was LAST seen live ({@link
 * AlertItem.lastSeenAt}), so history remains readable, then disappears on the
 * next derive. Active (still-true) alerts never age out regardless of age.
 */
const RESOLVED_RETENTION_MS = 48 * 60 * 60_000

/**
 * One alert source outside the provider pipeline. Subscription quota cards
 * (Claude, Codex, …) do not run through `results` — every card probes on its
 * own — so the caller normalizes their last reading into metrics and hands
 * the list in here. There is no status to wait out: a snapshot is the last
 * good reading, and the resolved-merge below treats an unknown status as
 * settled.
 */
export interface AlertSource {
  /** "providerId-index" for accounts, the card key for subscriptions */
  key: string
  agentName: string
  metrics: UsageMetric[]
}

/**
 * Derive the live alert set from current sections/results (plus any
 * {@link AlertSource} the caller adds), merged with the stored set
 * (surviving alerts keep firstSeenAt/read and get lastSeenAt stamped to this
 * round; resolved ids are kept for {@link RESOLVED_RETENTION_MS} from their
 * lastSeenAt, then dropped). Alerts whose account has no settled result
 * (status 'loading' or 'error') keep their previous state — an in-flight or
 * failed refresh is not evidence the condition cleared.
 * Pure — the caller persists the result.
 */
export function deriveAlerts(
  sections: Section[],
  results: Record<string, ProviderResult>,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  extraSources: AlertSource[] = [],
): AlertItem[] {
  const resetSoonMs = thresholds.resetSoonMin * 60_000
  const highUsagePct = thresholds.highUsagePct
  const lowBalance = thresholds.lowBalance
  const live = new Map<string, AlertItem>()
  // Copied, never the caller's array: the provider sources are appended below.
  const sources: AlertSource[] = [...extraSources]
  for (const sec of sections) {
    for (const card of sec.cards) {
      const result = results[card.key]
      if (result?.status !== 'ok' || !result.metrics) continue
      sources.push({
        key: card.key,
        agentName: card.cfg.label || `${sec.def.name} ${card.index + 1}`,
        metrics: result.metrics,
      })
    }
  }
  for (const { key, agentName, metrics } of sources) {
    for (const m of metrics) {
      if (m.kind === 'percent' && m.percent != null) {
        // Stale-value guard: a reset point in the past means the window
        // semantics are dead (e.g. a dead subscription still reporting an
        // old 100%) — the percentage is no longer actionable, so the
        // window-reset family of alerts must not survive on it.
        const staleWindow = m.resetsAt != null && m.resetsAt <= Date.now()
        if (m.resetsAt != null) {
          const mins = Math.round((m.resetsAt - Date.now()) / 60_000)
          // An exhausted window (100%) is announced by the high-usage row
          // below, which carries the recovery countdown; a second "resetting
          // soon" row for the same window would only duplicate it.
          if (mins > 0 && m.resetsAt - Date.now() <= resetSoonMs && m.percent < 100) {
            const id = `${key}:window-reset:${m.id}`
            live.set(id, {
              id,
              level: 'info',
              accountKey: key,
              agentName,
              kind: 'window-reset',
              metricId: m.id,
              windowLabel: m.label,
              resetsAt: m.resetsAt,
              resetInMin: mins,
              firstSeenAt: Date.now(),
              // Stamped per round; the merge below re-stamps it with `now`
              lastSeenAt: Date.now(),
              read: false,
            })
          }
        }
        if (m.percent >= highUsagePct && !staleWindow) {
          const id = `${key}:high-usage:${m.id}`
          live.set(id, {
            id,
            level: m.percent >= 100 ? 'danger' : 'warning',
            accountKey: key,
            agentName,
            kind: 'high-usage',
            metricId: m.id,
            windowLabel: m.label,
            resetsAt: m.resetsAt,
            pct: Math.round(m.percent),
            used: m.used,
            total: m.total,
            firstSeenAt: Date.now(),
            // Stamped per round; the merge below re-stamps it with `now`
            lastSeenAt: Date.now(),
            read: false,
          })
        }
      }
      if (m.kind === 'balance' && m.remaining != null && m.unit) {
        const floor = lowBalance[normalizeCurrency(m.unit)]
        if (floor != null && m.remaining <= floor) {
          const id = `${key}:low-balance:${m.id}`
          live.set(id, {
            id,
            level: 'info',
            accountKey: key,
            agentName,
            kind: 'low-balance',
            balance: m.remaining,
            currency: m.unit,
            firstSeenAt: Date.now(),
            // Stamped per round; the merge below re-stamps it with `now`
            lastSeenAt: Date.now(),
            read: false,
          })
        }
      }
    }
  }

  const stored = loadStored()
  const now = Date.now()
  const merged: AlertItem[] = []
  for (const item of live.values()) {
    const prev = stored.find((s) => s.id === item.id)
    // lastSeenAt is re-stamped every round the alert is live: the resolved
    // retention window below counts from the LAST time it was seen.
    merged.push(prev ? { ...item, firstSeenAt: prev.firstSeenAt, lastSeenAt: now, read: prev.read } : { ...item, lastSeenAt: now })
  }
  // Resolved history: keep recently-seen alerts that are no longer live
  // (condition cleared) for a bounded window, then let them disappear.
  // They are flagged resolved so acting consumers (push, attention, island)
  // skip them — only the alerts center renders them as dimmed history.
  for (const old of stored) {
    if (live.has(old.id)) continue
    // A card mid-fetch or failed carries no fresh metric: keep its previous
    // state until a settled 'ok' fetch says otherwise. Otherwise a manual
    // refresh (loading) or a transient error would resolve the whole set and
    // flip it straight back — re-popping island/overlay notifications.
    const accountStatus = results[old.accountKey]?.status
    if (accountStatus === 'loading' || accountStatus === 'error') {
      merged.push(old)
      continue
    }
    // Legacy persisted rows predate lastSeenAt: fall back to firstSeenAt so
    // they keep the pre-existing (firstSeen-based) window until they expire.
    const seenAt = typeof old.lastSeenAt === 'number' ? old.lastSeenAt : old.firstSeenAt
    if (now - seenAt > RESOLVED_RETENTION_MS) continue
    merged.push({ ...old, resolved: true })
  }
  // Newest first for panel rendering
  merged.sort((a, b) => b.firstSeenAt - a.firstSeenAt)
  return merged
}

/**
 * Alerts worth a popup: ids the previous render did not know, and ones that
 * flipped from resolved history back to live. Shared by the in-app island and
 * the background cycle window so both use the same rule.
 */
export function newAlertsFor(previous: Map<string, boolean>, current: AlertItem[]): AlertItem[] {
  return current.filter((alert) => {
    const was = previous.get(alert.id)
    if (was === undefined) return true
    return was === true && alert.resolved !== true
  })
}

/**
 * Id of the "window restored" announcement for one window and one reset
 * point. Carrying `resetsAt` makes every reset its own event: a 5-hour window
 * that fills up again after recovering raises a new announcement next time,
 * while the same reset point is announced once however often the timer is
 * rebuilt.
 */
export function restoredAlertId(accountKey: string, metricId: string, resetsAt: number): string {
  return `${accountKey}:window-restored:${metricId}:${resetsAt}`
}

export function unreadCount(items: AlertItem[]): number {
  // Resolved history is display-only (alerts center) and must not inflate
  // the bell badge.
  return items.filter((a) => !a.read && !a.resolved).length
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
