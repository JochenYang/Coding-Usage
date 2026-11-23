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

/** Persist the store; false when it could not be written at all. */
function saveStore(store: Store): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
    return true
  } catch {
    // quota exceeded → drop oldest halves per account and retry once
    const trimmed: Store = {}
    for (const [k, list] of Object.entries(store)) trimmed[k] = list.slice(-Math.floor(MAX_PER_ACCOUNT / 2))
    try {
      localStorage.setItem(KEY, JSON.stringify(trimmed))
      return true
    } catch {
      // give up silently; snapshots are best-effort
      return false
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

/**
 * Move each renamed account's history to its new key, in place. The rename
 * runs in two phases — collect and delete, then write back — because the keys
 * shuffle among themselves (`a-1` becomes `a-0` while `a-0` becomes `b-0`);
 * renaming one at a time would hand one account's history to another.
 */
export function remapSnapshotStore(store: Store, renamed: Record<string, string>): Store {
  const moved = new Map<string, AccountSnapshot[]>()
  for (const [from, to] of Object.entries(renamed)) {
    const list = store[from]
    if (!list) continue
    moved.set(to, list)
    delete store[from]
  }
  for (const [to, list] of moved) store[to] = list
  return store
}

/**
 * Apply an account-key rename to the persisted history; a no-op when nothing
 * is renamed. False when the renamed store could not be written, so the
 * caller knows the rename has not happened yet.
 */
export function renameSnapshotKeys(renamed: Record<string, string>): boolean {
  if (Object.keys(renamed).length === 0) return true
  return saveStore(remapSnapshotStore(loadStore(), renamed))
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
 * Sum of per-account consumption across `accountKeys` for the trailing `days`
 * local days, one point per day.
 *
 * A day's consumption is the rise in an account's `used` since its previous
 * reading — the day before, or the last earlier day that had one. A reading
 * taken after a gap carries the consumption of the whole gap; comparing with
 * the previous calendar day alone dropped it, and the longer the window the
 * more gaps it has. A drop in `used` (quota reset / data gap) contributes 0,
 * and so does the first reading of an account, which has nothing to compare.
 */
export function getConsumedSeries(accountKeys: string[], days: number): DayPoint[] {
  if (accountKeys.length === 0) return []
  const perAccount = accountKeys.map((k) => getDailySeries(k, days))
  // `used` at each account's most recent earlier reading, in series order
  const lastObserved: (number | null)[] = perAccount.map(() => null)
  const out: DayPoint[] = []
  for (let i = 0; i < days; i++) {
    let used = 0
    let hasConsumed = false
    let pctSum = 0
    let pctCount = 0
    for (let a = 0; a < perAccount.length; a++) {
      const cur = perAccount[a]![i]
      if (cur?.used != null) {
        const prev = lastObserved[a]
        if (prev != null && cur.used >= prev) {
          used += cur.used - prev
          hasConsumed = true
        }
        lastObserved[a] = cur.used
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
      used: hasConsumed ? used : null,
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
