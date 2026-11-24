import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/**
 * Persistent history for the local agent usage scan (main process).
 *
 * tokscale answers `graph --since 2020-01-01` by re-reading whatever session
 * files are on disk *now*. A deleted or rotated transcript therefore erases
 * that usage from every figure the dashboard shows, all-time included — the
 * scan result is a pure function of the files that happen to exist. This store
 * keeps each day's contribution in SQLite under userData and merges every scan
 * into it instead of replacing it, so history survives the source files going
 * away.
 *
 * Merge rule, and the whole reason this module exists: per client, the larger
 * of the two views of a day is kept. A client the fresh scan reports with more
 * usage than the store holds takes the fresh view (today's numbers normally
 * grow); a client it reports with less keeps the stored view; a client it no
 * longer mentions keeps its stored rows. Day totals and the token breakdown are
 * recomputed to include the kept rows, because the renderer derives the
 * unclassified "other" bucket from `totals` minus the client rows — leaving them
 * out of the totals would make a kept row silently vanish from the headline
 * figures while still counting toward its client.
 *
 * Why the larger view rather than the fresh one: an agent that deletes,
 * archives or rewrites a session shrinks what a later scan can see, and this
 * store exists precisely so that history outlives that. A per-day "fresh wins"
 * rule made the day's figure follow the shrink, silently dropping the archived
 * part (measured on this machine: one agent's day fell from 1.11B to 712M after
 * its sessions were pruned).
 *
 * Storage shape: one row per calendar day holding that day's contribution as
 * JSON. Keeping the payload opaque means a tokscale field this build does not
 * model survives a round-trip, and deleting a date range stays a single
 * predicate.
 *
 * Known and accepted limits:
 * - History is monotonic per client: a scan that reports less for a client on a
 *   day cannot lower it. A correction tokscale itself makes downward (better
 *   de-duplication, a re-read of a truncated file) therefore does not land; a
 *   day may stay higher than a later scanner would compute. Equal views take the
 *   fresh one, so cost, model labels and other non-count fields still refresh.
 * - `activeTimeMs` is a day-level observation with no per-client attribution, so
 *   a day that keeps stored rows takes the larger of the two — a day tokscale
 *   later trims keeps its old figure, which understates tok/s rather than
 *   overstating it.
 * - The store itself does not reprice. A stored row keeps the cost from the scan
 *   that wrote it; the main process reprices the merged history with the current
 *   price table before returning it to the renderer.
 */

const DB_FILE = 'usage-history.db'

/**
 * tokscale's date key is a local calendar day. Anything else is unusable: it
 * would become a primary key that no date arithmetic or range predicate can
 * reason about, and a stray value like "NaN-NaN-NaN" sorts above every real day
 * in a string comparison.
 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * True for a day that exists on the calendar, not merely one matching the
 * pattern: 2026-02-30 would otherwise become a stored key that no scan can
 * produce, skewing the oldest/newest range the settings page reports and the
 * purge boundary derived from it.
 */
function isCalendarDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return day <= daysInMonth
}

/** One per-client row inside a day's contribution (subset of tokscale's shape) */
interface ClientEntry {
  client?: string
  modelId?: string
  providerId?: string
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  cost?: number
  messages?: number
  /** Credits billed by a gateway that reports no tokens (Qoder global) */
  credits?: number
  /** Set when the main process repriced this entry from the shared price table */
  priced?: boolean
}

/**
 * One day of usage, mirroring `tokscale graph`'s contribution object.
 *
 * `totals` and `tokenBreakdown` stay loosely typed on purpose: they are stored
 * and returned verbatim apart from the three or four keys the merge has to
 * adjust, so a field this build does not know about is never dropped. The same
 * holds for `clients` entries, which are carried through as parsed.
 */
interface Contribution {
  date: string
  totals: Record<string, unknown>
  tokenBreakdown: Record<string, unknown>
  clients: ClientEntry[]
  intensity: number
  activeTimeMs: number
}

export interface UsageStoreStats {
  /** Number of days currently stored */
  days: number
  /** Oldest stored day (YYYY-MM-DD), null when the store is empty */
  oldest: string | null
  /** Newest stored day (YYYY-MM-DD), null when the store is empty */
  newest: string | null
}

let storeDir: string | null = null
let handle: DatabaseSync | null = null
let openFailed = false

/** Point the store at the app's userData directory */
export function initUsageStore(userDataDir: string): void {
  storeDir = userDataDir
  // A previous failure must not latch: the path is only now known, and the
  // directory it names may not have existed on the earlier attempt.
  openFailed = false
}

function db(): DatabaseSync | null {
  if (handle) return handle
  if (openFailed || storeDir == null) return null
  try {
    // userData normally exists, but a portable build or a first run on a fresh
    // profile can reach this before anything else created it. Without it SQLite
    // reports CANTOPEN and the history would silently stay off for the whole run
    // while the settings page happily reports "no history yet".
    mkdirSync(storeDir, { recursive: true })
    const opened = new DatabaseSync(join(storeDir, DB_FILE))
    opened.exec(
      'CREATE TABLE IF NOT EXISTS usage_day (' +
        'day TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    )
    handle = opened
    return handle
  } catch (error) {
    // A store that cannot open must not take the scan down with it: every
    // caller degrades to "no history", which is exactly the pre-store behaviour.
    // The reason is logged because that degradation is otherwise invisible.
    console.warn('[usage-store] cannot open the history database:', error)
    openFailed = true
    return null
  }
}

/** Release the database handle (app quit) */
export function closeUsageStore(): void {
  try {
    handle?.close()
  } catch {
    // Closing is best-effort; the process is going away anyway
  }
  handle = null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number {
  // node:sqlite can hand back bigint for aggregate columns; treating it as 0
  // would silently report an empty store, so widen it here.
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Validate one parsed row into a {@link Contribution}, preserving every field
 * the store did not have to touch.
 */
function normalizeContribution(value: unknown): Contribution | null {
  const rec = asRecord(value)
  if (!rec || typeof rec.date !== 'string' || !isCalendarDay(rec.date)) return null
  const rawClients = Array.isArray(rec.clients) ? rec.clients : []
  const clients = rawClients.filter((e): e is ClientEntry => asRecord(e) !== null)
  return {
    ...rec,
    date: rec.date,
    totals: asRecord(rec.totals) ?? {},
    tokenBreakdown: asRecord(rec.tokenBreakdown) ?? {},
    clients,
    intensity: num(rec.intensity),
    activeTimeMs: num(rec.activeTimeMs),
  }
}

/** Group entries by their client id; '' collects the unclassified rows */
function groupByClient(entries: ClientEntry[]): Map<string, ClientEntry[]> {
  const map = new Map<string, ClientEntry[]>()
  for (const entry of entries) {
    const key = typeof entry.client === 'string' && entry.client ? entry.client : ''
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }
  return map
}

interface EntrySums {
  tokens: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  messages: number
  credits: number
}

function sumEntries(entries: ClientEntry[]): EntrySums {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let messages = 0
  let credits = 0
  for (const entry of entries) {
    input += num(entry.tokens?.input)
    output += num(entry.tokens?.output)
    cacheRead += num(entry.tokens?.cacheRead)
    cacheWrite += num(entry.tokens?.cacheWrite)
    cost += num(entry.cost)
    messages += num(entry.messages)
    credits += num(entry.credits)
  }
  return {
    tokens: input + output + cacheRead + cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    messages,
    credits,
  }
}

/** Entry sums added together (a kept row and another kept row) */
function addSums(a: EntrySums, b: EntrySums): EntrySums {
  return {
    tokens: a.tokens + b.tokens,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    messages: a.messages + b.messages,
    credits: a.credits + b.credits,
  }
}

/** How much more one view of a client carries than another (only called when larger) */
function subtractSums(a: EntrySums, b: EntrySums): EntrySums {
  return {
    tokens: a.tokens - b.tokens,
    input: a.input - b.input,
    output: a.output - b.output,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite,
    cost: a.cost - b.cost,
    messages: a.messages - b.messages,
    credits: a.credits - b.credits,
  }
}

/**
 * Whether the stored view of a client is the more complete one.
 *
 * Tokens decide first; calls break a token tie, then credits — a credits-billed
 * agent (Qoder global) reports no tokens at all, so without them its stored day
 * could never win. Equal views are not "larger": the fresh one then replaces the
 * stored one, which is what lets a corrected cost or model label land.
 */
function isLarger(stored: EntrySums, fresh: EntrySums): boolean {
  if (stored.tokens !== fresh.tokens) return stored.tokens > fresh.tokens
  if (stored.messages !== fresh.messages) return stored.messages > fresh.messages
  return stored.credits > fresh.credits
}

/**
 * Day totals with the kept rows added back in.
 *
 * Credits are a unit of their own on the day total: a kept credits-billed row
 * (Qoder global) must keep its credits here, or the renderer's "unclassified"
 * derivation (totals − Σclients) would have to absorb the difference and the
 * headline would under-report the spend.
 */
function withTotals(totals: Record<string, unknown>, extra: EntrySums): Record<string, unknown> {
  return {
    ...totals,
    tokens: num(totals.tokens) + extra.tokens,
    cost: num(totals.cost) + extra.cost,
    messages: num(totals.messages) + extra.messages,
    credits: num(totals.credits) + extra.credits,
  }
}

/** Token breakdown with the kept rows added back in */
function withBreakdown(breakdown: Record<string, unknown>, extra: EntrySums): Record<string, unknown> {
  return {
    ...breakdown,
    input: num(breakdown.input) + extra.input,
    output: num(breakdown.output) + extra.output,
    cacheRead: num(breakdown.cacheRead) + extra.cacheRead,
    cacheWrite: num(breakdown.cacheWrite) + extra.cacheWrite,
  }
}

/**
 * Fold a fresh scan's view of one day onto the stored view: per client, the
 * larger view is kept.
 *
 * A client the fresh scan reports with more usage takes the fresh view (the
 * normal case); one it reports with less keeps the stored view, because a
 * deleted, archived or rewritten session must not shrink what history already
 * recorded; one it no longer reports keeps its stored rows.
 */
function mergeDay(previous: Contribution, fresh: Contribution): Contribution {
  const freshGroups = groupByClient(fresh.clients)
  const previousGroups = groupByClient(previous.clients)
  // Rows taken from the store instead of the fresh scan, and how much more they
  // carry than the fresh view they replace.
  const kept: ClientEntry[] = []
  /** Clients whose fresh row is replaced by the stored one (never both) */
  const replaced = new Set<string>()
  let extra: EntrySums | null = null
  const addExtra = (sums: EntrySums): void => {
    extra = extra ? addSums(extra, sums) : sums
  }
  for (const [client, freshEntries] of freshGroups) {
    const previousEntries = previousGroups.get(client)
    if (!previousEntries) continue
    const stored = sumEntries(previousEntries)
    const current = sumEntries(freshEntries)
    if (!isLarger(stored, current)) continue
    replaced.add(client)
    kept.push(...previousEntries)
    addExtra(subtractSums(stored, current))
  }
  for (const [client, entries] of previousGroups) {
    if (freshGroups.has(client)) continue
    kept.push(...entries)
    addExtra(sumEntries(entries))
  }
  if (extra == null) return fresh

  return {
    ...fresh,
    totals: withTotals(fresh.totals, extra),
    tokenBreakdown: withBreakdown(fresh.tokenBreakdown, extra),
    clients: [...fresh.clients.filter((entry) => !replaced.has(entry.client ?? '')), ...kept],
    // Day-level observation the entries cannot be summed into. The stored value
    // covered the kept clients as well, so the larger one is the closer estimate
    // of the day's real activity. `intensity` is deliberately not merged: no
    // renderer reads it, so a rule for it would be unverifiable.
    activeTimeMs: Math.max(fresh.activeTimeMs, previous.activeTimeMs),
  }
}

/** Read every stored day into a map keyed by date, skipping unreadable rows */
function readAll(database: DatabaseSync): Map<string, Contribution> {
  const out = new Map<string, Contribution>()
  const rows = database.prepare('SELECT day, payload FROM usage_day ORDER BY day ASC').all()
  for (const row of rows) {
    const rec = asRecord(row)
    if (!rec || typeof rec.payload !== 'string') continue
    try {
      const contribution = normalizeContribution(JSON.parse(rec.payload))
      if (contribution) out.set(contribution.date, contribution)
    } catch (error) {
      // One corrupted day must not hide the rest of the history, but it must not
      // disappear without a trace either: silent loss is the exact failure this
      // store exists to prevent.
      console.warn('[usage-store] skipping an unreadable day row:', error)
    }
  }
  return out
}

function sortedDays(days: Map<string, Contribution>): Contribution[] {
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * Merge one scan's contributions into the store and return the full history
 * (stored days the scan did not mention included), oldest first.
 *
 * The returned array is what the renderer should aggregate: it is a superset of
 * the scan, so every figure — today, month, all-time — is derived from history
 * rather than from the files that happen to be on disk.
 */
export function mergeScanIntoStore(fresh: Contribution[]): Contribution[] {
  const database = db()
  if (database == null) return fresh
  const stored = readAll(database)
  if (fresh.length === 0) return sortedDays(stored)

  const now = Date.now()
  // Unchanged days are the common case — only today's numbers actually move —
  // and rewriting a multi-year store on every refresh is pure write
  // amplification on the thread that also serves window and network events.
  const changed: Array<{ day: string; payload: string }> = []
  for (const day of fresh) {
    const previous = stored.get(day.date)
    const merged = previous ? mergeDay(previous, day) : day
    stored.set(day.date, merged)
    const payload = JSON.stringify(merged)
    if (previous != null && JSON.stringify(previous) === payload) continue
    changed.push({ day: day.date, payload })
  }
  if (changed.length === 0) return sortedDays(stored)

  const upsert = database.prepare(
    'INSERT INTO usage_day (day, payload, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(day) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
  )
  database.exec('BEGIN')
  try {
    for (const row of changed) upsert.run(row.day, row.payload, now)
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Nothing left to roll back
    }
    throw error
  }
  return sortedDays(stored)
}

/**
 * Pull the contribution rows out of a raw `tokscale graph` payload.
 * Rows without a usable date are dropped rather than stored under a fake key.
 */
export function extractContributions(daily: unknown): Contribution[] {
  const root = asRecord(daily)
  if (!root) return []
  const rows = Array.isArray(root.contributions) ? root.contributions : []
  const out: Contribution[] = []
  for (const row of rows) {
    const contribution = normalizeContribution(row)
    if (contribution) out.push(contribution)
  }
  return out
}

/** Read the whole stored history without writing anything, oldest first */
export function readStoredContributions(): Contribution[] {
  const database = db()
  if (database == null) return []
  return sortedDays(readAll(database))
}

/**
 * Epoch ms when a day's numbers last actually changed, or null when empty.
 * Unchanged days are skipped on write (see mergeScanIntoStore), so this is the
 * age of the figures rather than of the last scan — which is what the as-of
 * label wants when a failed scan falls back to stored history.
 */
export function getUsageStoreUpdatedAt(): number | null {
  const database = db()
  if (database == null) return null
  const row = asRecord(database.prepare('SELECT MAX(updated_at) AS at FROM usage_day').get())
  // Widened through num() like every other aggregate read: a bigint here would
  // fall through to null and let the caller stamp stale history as "now".
  const at = num(row?.at)
  return at > 0 ? at : null
}

export function getUsageStoreStats(): UsageStoreStats {
  const database = db()
  if (database == null) return { days: 0, oldest: null, newest: null }
  const row = asRecord(
    database.prepare('SELECT COUNT(*) AS days, MIN(day) AS oldest, MAX(day) AS newest FROM usage_day').get(),
  )
  return {
    days: Math.trunc(num(row?.days)),
    oldest: typeof row?.oldest === 'string' ? row.oldest : null,
    newest: typeof row?.newest === 'string' ? row.newest : null,
  }
}

export interface UsagePurgeResult {
  /** Number of stored days deleted */
  removed: number
  /** Store contents after the purge */
  stats: UsageStoreStats
}

/**
 * Delete every day older than `cutoffDay` (exclusive), or the whole history when
 * it is null.
 *
 * Only days already saved can be removed: a session file that still exists is
 * re-scanned into the store on the next refresh, so this trims history whose
 * source is gone and bounds the database, not a way to hide live usage.
 */
export function purgeUsageBefore(cutoffDay: string | null): UsagePurgeResult {
  const database = db()
  if (database == null) return { removed: 0, stats: { days: 0, oldest: null, newest: null } }
  // The predicate compares plain strings, where a malformed cutoff such as
  // "NaN-NaN-NaN" sorts above every real day and would delete the whole store.
  // Refuse it instead of running the DELETE.
  if (cutoffDay !== null && !DAY_PATTERN.test(cutoffDay)) {
    console.warn('[usage-store] refusing a malformed purge cutoff:', cutoffDay)
    return { removed: 0, stats: getUsageStoreStats() }
  }
  const result =
    cutoffDay == null
      ? database.prepare('DELETE FROM usage_day').run()
      : database.prepare('DELETE FROM usage_day WHERE day < ?').run(cutoffDay)
  const removed = Math.trunc(Number(result.changes ?? 0))
  if (removed > 0) {
    // Hand the freed pages back to the filesystem. The store is small (one row
    // per day), and this only runs on an explicit user action.
    try {
      database.exec('VACUUM')
    } catch {
      // Reclaiming space is cosmetic — the rows are already deleted
    }
  }
  return { removed, stats: getUsageStoreStats() }
}
