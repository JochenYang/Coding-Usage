import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuotaOutcome } from './subscription-quotas'

/**
 * Last known-good subscription quota per provider (main process).
 *
 * The cards used to start empty on every visit and wait for a probe; several of
 * those probes cost a PowerShell child or a locked database, so the page sat
 * blank and then stalled. This store keeps the last *successful* outcome on
 * disk so a card can paint immediately and refresh behind the user's back.
 *
 * Only numbers are stored — every probe narrows the vendor response to the
 * fields the cards parse before returning it, so `QuotaOutcome.body` is the
 * normalized payload, never a credential or an account identifier. The store
 * trusts that boundary and does not re-inspect bodies itself. A failure is
 * never written: it must not replace the last good reading with an empty
 * state. Readers get `at` with every entry so the card can say how old the
 * figure is.
 *
 * Writes are coalesced: a refresh finishes a dozen probes at once, and one
 * small rewrite per probe would be pointless disk churn.
 */

const FILE = 'quota-cache.json'
const WRITE_DELAY_MS = 300
/** Entries older than this are dropped at load; a month-old percentage is noise. */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000
const MAX_ENTRIES = 32

export interface QuotaSnapshotEntry {
  /** Epoch ms of the fetch that produced this result */
  at: number
  result: QuotaOutcome
}

export type QuotaSnapshot = Record<string, QuotaSnapshotEntry>

let storeDir: string | null = null
let entries: QuotaSnapshot = {}
let loaded = false
let pending: NodeJS.Timeout | null = null
let writing: Promise<void> = Promise.resolve()

function sanitize(raw: unknown, now: number): QuotaSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: QuotaSnapshot = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Only a plain provider id is a legal key: a credential digest must never
    // be persisted, and an unexpected key means a file this build did not write.
    if (!/^[a-z0-9-]{1,40}$/.test(key)) continue
    if (!value || typeof value !== 'object') continue
    const entry = value as { at?: unknown; result?: unknown }
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : null
    const result = entry.result
    if (at == null || !result || typeof result !== 'object') continue
    // A future stamp (clock correction) or an ancient one cannot describe a
    // reading this build should paint.
    if (at > now + 24 * 60 * 60_000 || now - at > MAX_AGE_MS) continue
    const outcome = result as QuotaOutcome
    if (outcome.available !== true || typeof outcome.body !== 'string') continue
    out[key] = { at, result: { available: true, body: outcome.body } }
    if (Object.keys(out).length >= MAX_ENTRIES) break
  }
  return out
}

/** Point the store at userData and load what the previous run left behind. */
export async function initQuotaStore(userDataDir: string): Promise<void> {
  storeDir = userDataDir
  try {
    const parsed = JSON.parse(await readFile(join(userDataDir, FILE), 'utf8')) as { entries?: unknown }
    entries = sanitize(parsed?.entries, Date.now())
  } catch {
    entries = {}
  }
  loaded = true
}

/** What the last successful run produced. Empty until the store is initialized. */
export function readQuotaSnapshot(): QuotaSnapshot {
  return loaded ? entries : {}
}

/** Record a successful outcome; a failure is ignored on purpose. */
export function saveQuotaOutcome(key: string, result: QuotaOutcome): void {
  if (!result.available || typeof result.body !== 'string') return
  // Entries are keyed and overwritten by provider: callers that differ only in
  // a credential suffix (`kimi:<digest>`) share one slot, so accounts
  // replacing each other on one provider overwrite the previous reading on
  // disk. That is the intended semantics — one CLI login per provider today;
  // per-account separation would need a widened key contract here and in
  // sanitize, not a digest baked into this file. Only the provider part is
  // kept either way, so the cache file never holds a key fingerprint.
  const provider = key.split(':')[0] ?? key
  if (!/^[a-z0-9-]{1,40}$/.test(provider)) return
  entries[provider] = { at: Date.now(), result: { available: true, body: result.body } }
  if (!storeDir || pending) return
  pending = setTimeout(() => {
    pending = null
    writing = flush()
  }, WRITE_DELAY_MS)
}

/** Wait for a queued write. Used by tests and by the normal quit path. */
export async function flushQuotaStore(): Promise<void> {
  if (pending) {
    clearTimeout(pending)
    pending = null
    writing = flush()
  }
  await writing
}

/**
 * Last-chance write during quit, where Electron does not await a promise.
 * Synchronous on purpose: the file is a few kilobytes.
 */
export function flushQuotaStoreSync(): void {
  if (pending) {
    clearTimeout(pending)
    pending = null
  }
  if (!storeDir) return
  const target = join(storeDir, FILE)
  const temp = tempPath(target)
  try {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(temp, JSON.stringify({ version: 1, entries }), 'utf8')
    renameSync(temp, target)
  } catch {
    // Best effort: a cache is not worth blocking a quit.
  }
}

/** Unique per write: two overlapping flushes must not rename each other's temp. */
function tempPath(target: string): string {
  return `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
}

async function flush(): Promise<void> {
  if (!storeDir) return
  const target = join(storeDir, FILE)
  const temp = tempPath(target)
  try {
    await mkdir(storeDir, { recursive: true })
    await writeFile(temp, JSON.stringify({ version: 1, entries }), 'utf8')
    // Atomic on the same volume: a half-written cache must never load.
    await rename(temp, target)
  } catch {
    // A cache that cannot be written is not a failure the user must see; the
    // next refresh tries again.
  }
}

/** Test hook: forget everything, including the queued write. */
export function resetQuotaStore(): void {
  if (pending) clearTimeout(pending)
  pending = null
  entries = {}
  loaded = false
  storeDir = null
}
