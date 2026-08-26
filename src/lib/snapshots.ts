import type { UsageMetric } from '../types'

/**
 * Local time-series store. Every successful account refresh records one
 * snapshot (throttled); trend / today-consumption views are derived from it.
 * Data starts accumulating from first launch — views must render honest empty
 * states until enough history exists. No fake or seeded data.
 */

const KEY = 'coding-usage.snapshots.v1'
/** Minimum gap between stored snapshots per account */
const MIN_INTERVAL_MS = 5 * 60_000
/** Keep 90 days of history, bounded per account */
const RETENTION_MS = 90 * 24 * 60 * 60_000
const MAX_PER_ACCOUNT = 2_000

/** One observation of an account's primary quota/balance state */
export interface AccountSnapshot {
  /** epoch ms */
  t: number
  /** Primary percent-metric progress (0-100) when the account has one */
  pct?: number
  /** Primary percent-metric used/total (token or call units) when exposed */
  used?: number
  total?: number
  /** Balance metrics keyed by currency code */
  balances?: Record<string, number>
}

type Store = Record<string, AccountSnapshot[]>

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      // Shape check: must be a plain object of arrays, otherwise treat as no
      // history (a bare `null` / array here would crash every consumer).
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const store = parsed as Store
        for (const v of Object.values(store)) {
          if (!Array.isArray(v)) return {}
        }
        return store
      }
    }
  } catch {
    // corrupted store → start fresh, same as no history
  }
  return {}
}

function saveStore(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // quota exceeded → drop oldest halves per account and retry once
    const trimmed: Store = {}
    for (const [k, list] of Object.entries(store)) trimmed[k] = list.slice(-Math.floor(MAX_PER_ACCOUNT / 2))
    try {
      localStorage.setItem(KEY, JSON.stringify(trimmed))
    } catch {
      // give up silently; snapshots are best-effort
    }
  }
}

/** Extract the snapshot-worthy numbers from an account's metric list */
function fromMetrics(metrics: UsageMetric[]): AccountSnapshot {
  const snap: AccountSnapshot = { t: Date.now() }
  const pctMetric = metrics.find((m) => m.kind === 'percent')
  if (pctMetric) {
    snap.pct = pctMetric.percent
    snap.used = pctMetric.used
    snap.total = pctMetric.total
  }
  const balances: Record<string, number> = {}
  for (const m of metrics) {
    if (m.kind === 'balance' && m.remaining != null && m.unit) {
      balances[m.unit] = m.remaining
    }
  }
  if (Object.keys(balances).length > 0) snap.balances = balances
  return snap
}

/** Record one snapshot for `accountKey` (throttled to MIN_INTERVAL_MS) */
export function recordSnapshot(accountKey: string, metrics: UsageMetric[]): void {
  const store = loadStore()
  const list = store[accountKey] ?? []
  const last = list[list.length - 1]
  if (last && Date.now() - last.t < MIN_INTERVAL_MS) return
  list.push(fromMetrics(metrics))
  const cutoff = Date.now() - RETENTION_MS
  store[accountKey] = list.filter((s) => s.t >= cutoff).slice(-MAX_PER_ACCOUNT)
  saveStore(store)
}

export function getSnapshots(accountKey: string): AccountSnapshot[] {
  return loadStore()[accountKey] ?? []
}

export interface DayPoint {
  /** Local calendar day key, YYYY-MM-DD */
  day: string
  label: string
  /** Last observed cumulative `used` on that day (null = no data) */
  used: number | null
  /** Last observed primary pct on that day */
  pct: number | null
}

function dayKey(t: number): string {
  const d = new Date(t)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Per-day "last observed used/pct" over the trailing `days` local days
 * (oldest first). Cumulative-used per day is the robust trend primitive:
 * daily consumption is the difference between consecutive days, computed by
 * the caller so quota resets (used dropping) can be handled explicitly.
 */
export function getDailySeries(accountKey: string, days: number): DayPoint[] {
  const snaps = getSnapshots(accountKey)
  const byDay = new Map<string, AccountSnapshot>()
  for (const s of snaps) byDay.set(dayKey(s.t), s) // later entries win
  const out: DayPoint[] = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = dayKey(d.getTime())
    const hit = byDay.get(key)
    out.push({
      day: key,
      label: `${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`,
      used: hit?.used ?? null,
      pct: hit?.pct ?? null,
    })
  }
  return out
}

/**
 * Sum of per-account daily-consumption deltas across `accountKeys` for the
 * trailing `days` local days. A delta is last-minus-first observed `used`
 * within the window; negative deltas (quota reset / data gap) contribute 0.
 * Returns null when no account has any usable data.
 */
export function getConsumedSeries(accountKeys: string[], days: number): DayPoint[] {
  if (accountKeys.length === 0) return []
  const perAccount = accountKeys.map((k) => getDailySeries(k, days))
  const out: DayPoint[] = []
  for (let i = 0; i < days; i++) {
    let used = 0
    let any = false
    let pctSum = 0
    let pctCount = 0
    for (const series of perAccount) {
      const cur = series[i]
      const prev = series[i - 1]
      if (cur?.used != null && prev?.used != null && cur.used >= prev.used) {
        used += cur.used - prev.used
        any = true
      }
      if (cur?.pct != null) {
        pctSum += cur.pct
        pctCount++
      }
    }
    const head = perAccount[0]![i]!
    out.push({
      day: head.day,
      label: head.label,
      used: any ? used : null,
      pct: pctCount > 0 ? Math.round(pctSum / pctCount) : null,
    })
  }
  return out
}

/** Today-vs-yesterday consumption comparison, or nulls when data is missing */
export function getTodayConsume(accountKeys: string[]): {
  today: number | null
  yesterday: number | null
} {
  const series = getConsumedSeries(accountKeys, 2)
  return {
    today: series[series.length - 1]?.used ?? null,
    yesterday: series[0]?.used ?? null,
  }
}

/** Test/dev helper: drop the whole store */
export function clearSnapshots(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
