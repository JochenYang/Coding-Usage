import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Kimi / Moonshot subscription quota probe.
 *
 * Two SEPARATE billing surfaces exist and a credential for one is rejected by
 * the other — this module only handles the Kimi CODE subscription side:
 *
 *   - Kimi Code quota  → the officially documented loopback server
 *     `127.0.0.1:58627/api/v1/oauth/usage`, or the remote
 *     `api.kimi.com/coding/v1/usages` (staff-published but explicitly marked
 *     experimental). Both accept a Kimi Code API key or the CLI's OAuth token.
 *   - Moonshot platform balance → `api.moonshot.cn|.ai/v1/users/me/balance`,
 *     which needs a platform API key. A Kimi Code OAuth JWT is NOT accepted
 *     there (verified: 401). That surface stays in the renderer adapter.
 *
 * Ordering is loopback-first: it is documented, needs no credential file
 * parsing, and cannot race the CLI's own token refresh. The remote endpoint is
 * the fallback for a user who pasted a Kimi Code API key but has no local CLI.
 *
 * Credentials never cross the IPC boundary: the returned body carries usage
 * numbers only.
 */

export interface KimiOutcome {
  available: boolean
  body?: string
  reason?: string
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

const PROBE_TIMEOUT_MS = 10_000

/** Loopback server ports: the CLI retries upward when 58627 is taken */
const LOCAL_PORTS = [58627, 58628, 58629]
const REMOTE_USAGES_URL = 'https://api.kimi.com/coding/v1/usages'

/**
 * Canonical quota window identity, stable across all three payload shapes this
 * module understands. Carrying the identity explicitly (rather than inferring
 * it from array order) is what keeps the weekly and 5-hour figures from being
 * swapped by a serialization detail.
 */
export type KimiWindowId = 'fiveHour' | 'weekly' | 'monthTotal' | 'monthCode'

/** Display order: shortest window first */
const WINDOW_ORDER: Record<KimiWindowId, number> = {
  fiveHour: 0,
  weekly: 1,
  monthTotal: 2,
  monthCode: 3,
}

/** One parsed quota window, already normalized to a 0-100 percentage */
interface QuotaWindow {
  id: KimiWindowId
  percent: number
  resetsAt: number | null
}

/**
 * Optional pay-as-you-go ("booster") wallet. Only emitted when the payload
 * actually carries money fields — a missing wallet must stay absent rather
 * than render as a row of zeros.
 */
interface QuotaWallet {
  remaining: number | null
  total: number | null
  used: number | null
  currency: string | null
}

interface ParsedUsage {
  windows: QuotaWindow[]
  wallet: QuotaWallet | null
}

/**
 * Credential file locations, newest first. Current CLI versions write
 * `~/.kimi-code`; older ones used `~/.kimi`. Reading both mirrors what other
 * monitors had to do (a single-path read silently breaks on half the installs).
 */
function credentialPaths(homeDir: string): string[] {
  return [
    join(homeDir, '.kimi-code', 'credentials', 'kimi-code.json'),
    join(homeDir, '.kimi', 'credentials', 'kimi-code.json'),
  ]
}

function serverTokenPaths(homeDir: string): string[] {
  return [join(homeDir, '.kimi-code', 'server.token'), join(homeDir, '.kimi', 'server.token')]
}

async function readText(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const trimmed = raw.trim()
    return trimmed === '' ? null : trimmed
  } catch {
    return null
  }
}

/** First readable file wins; every miss is treated as simply "not present" */
async function firstReadable(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    const v = await readText(p)
    if (v != null) return v
  }
  return null
}

function asNumber(v: unknown): number | null {
  // The endpoints mix string and numeric encodings across versions
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Reset instant as epoch ms. The endpoints mix encodings: ISO-8601 strings
 * (quota model) and epoch numbers (legacy model), with epochs arriving in
 * either seconds or milliseconds. A numeric value below 1e12 is seconds — the
 * same rule `src/providers/kimi.ts` applies to this endpoint's `resetTime`, so
 * both surfaces of the same subscription read a countdown identically.
 */
function asEpochMs(v: unknown): number | null {
  if (typeof v === 'string' && !/^\d+$/.test(v)) {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms : null
  }
  const n = asNumber(v)
  if (n == null) return null
  return n < 1e12 ? n * 1000 : n
}

function clampPercent(n: number): number {
  return Math.min(100, Math.max(0, n))
}

/**
 * `used`/`limit` pair → percentage.
 *
 * The loopback server reports both as 0-100 percentages of the plan allowance
 * (a fresh window reads `used: 9, limit: 100`), so `used` IS the percentage and
 * the ratio form only applies when `limit` is some other scale — older
 * request-count plans reported absolute counts here.
 */
function percentFromUsedLimit(used: number | null, limit: number | null): number | null {
  if (used == null) return null
  if (limit != null && limit > 0 && limit !== 100) return (used / limit) * 100
  return used
}

/** The remote quota model expresses usage as a 0-1 ratio (occasionally already a percentage) */
function percentFromRatio(ratio: number | null): number | null {
  if (ratio == null) return null
  return ratio <= 1 ? ratio * 100 : ratio
}

/**
 * Map the loopback `window` descriptor to a canonical id.
 * `{duration: 5, unit: "hour"}` / `{duration: 1, unit: "week"}` etc.
 * An unrecognized descriptor yields null so the caller can skip it rather than
 * guess — a mislabelled window is worse than a missing one.
 */
function windowIdFromDescriptor(desc: unknown): KimiWindowId | null {
  if (!desc || typeof desc !== 'object') return null
  const d = desc as { duration?: unknown; unit?: unknown }
  const duration = asNumber(d.duration)
  const unit = typeof d.unit === 'string' ? d.unit.toLowerCase() : ''
  if (duration == null) return null
  if (unit.startsWith('hour') && duration === 5) return 'fiveHour'
  if (unit.startsWith('week')) return 'weekly'
  if (unit.startsWith('month')) {
    // Every month-unit descriptor maps to the total pool. The provider's two
    // month windows are told apart by the remote quota model's key names
    // (`limit_month_total` / `limit_month_code`), not by anything this
    // descriptor carries, so `monthCode` is unreachable from this path: a
    // descriptor-based payload with both would collapse to the later entry in
    // `finalize`'s last-write-wins.
    return 'monthTotal'
  }
  if (unit.startsWith('day') && duration === 7) return 'weekly'
  return null
}

/**
 * Parse the loopback server payload:
 * ```
 * { kind: "ok",
 *   summary: { window: {duration:1, unit:"week"}, used, limit, reset_at },
 *   limits:  [ { window: {duration:5, unit:"hour"}, used, limit, reset_at } ],
 *   extra_usage: null | { balanceCents, totalCents, monthlyUsedCents, currency } }
 * ```
 * `used`/`limit` are 0-100 percentages here. A freshly-reset window legally
 * carries only its `window` descriptor; such an entry is skipped instead of
 * being reported as a bogus 0%.
 */
function parseLoopback(data: unknown): ParsedUsage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.kind !== 'ok') return null

  const windows: QuotaWindow[] = []
  const push = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return
    const e = entry as Record<string, unknown>
    // The descriptor sits on the entry itself; `detail` is tolerated because
    // some payload revisions nest the numbers one level down.
    const detail = e.detail && typeof e.detail === 'object' ? (e.detail as Record<string, unknown>) : null
    const id = windowIdFromDescriptor(e.window ?? detail?.window)
    if (!id) return
    const used = asNumber(e.used ?? detail?.used)
    const limit = asNumber(e.limit ?? detail?.limit)
    const pct = percentFromUsedLimit(used, limit)
    if (pct == null) return
    const reset = asEpochMs(e.reset_at ?? e.resetTime ?? detail?.reset_at ?? detail?.resetTime)
    windows.push({ id, percent: clampPercent(pct), resetsAt: reset })
  }

  if (Array.isArray(d.limits)) for (const entry of d.limits) push(entry)
  // `summary` is the long (weekly) window; tolerating a missing descriptor by
  // falling back to the known weekly meaning keeps the common case working.
  if (d.summary && typeof d.summary === 'object') {
    const s = d.summary as Record<string, unknown>
    const id = windowIdFromDescriptor(s.window) ?? 'weekly'
    const pct = percentFromUsedLimit(asNumber(s.used), asNumber(s.limit))
    if (pct != null) {
      windows.push({ id, percent: clampPercent(pct), resetsAt: asEpochMs(s.reset_at ?? s.resetTime) })
    }
  }
  if (windows.length === 0) return null
  return { windows, wallet: walletFromCents(d.extra_usage) }
}

/** Money fields are in cents and only meaningful when at least one is present */
function walletFromCents(raw: unknown): QuotaWallet | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const cents = (k: string): number | null => {
    const n = asNumber(w[k])
    return n == null ? null : n / 100
  }
  const remaining = cents('balanceCents')
  const total = cents('totalCents')
  const used = cents('monthlyUsedCents')
  if (remaining == null && total == null && used == null) return null
  const currency = typeof w.currency === 'string' && w.currency.trim() !== '' ? w.currency.trim() : null
  return { remaining, total, used, currency }
}

/**
 * Parse the remote `/coding/v1/usages` payload. The server switched to a
 * "quota model" (kimi-code #3787 / 0.43.1) which is preferred when present:
 * ```
 * { usages: { limit_5h|limit_7d|limit_month_total|limit_month_code:
 *             { used_ratio: 0-1, reset_time: ISO-8601 } },
 *   boosterWallet: { balanceCents, totalCents, monthlyUsedCents, currency } }
 * ```
 * The legacy shape stays supported as a fallback:
 * `{ limits: [{detail:{limit,remaining,resetTime}}], usage: {limit,remaining,resetTime} }`
 * where the percentage is derived from limit-minus-remaining.
 */
function parseRemote(json: unknown): ParsedUsage | null {
  if (!json || typeof json !== 'object') return null
  const root = json as Record<string, unknown>

  // --- New quota model ---
  const usages = root.usages
  const windows: QuotaWindow[] = []
  if (usages && typeof usages === 'object') {
    const map: Array<[string, KimiWindowId]> = [
      ['limit_5h', 'fiveHour'],
      ['limit_7d', 'weekly'],
      ['limit_month_total', 'monthTotal'],
      ['limit_month_code', 'monthCode'],
    ]
    const u = usages as Record<string, unknown>
    for (const [key, id] of map) {
      const entry = u[key]
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const pct = percentFromRatio(asNumber(e.used_ratio))
      if (pct == null) continue
      windows.push({ id, percent: clampPercent(pct), resetsAt: asEpochMs(e.reset_time ?? e.resetTime) })
    }
    if (windows.length > 0) {
      return { windows, wallet: walletFromCents(root.boosterWallet) }
    }
  }

  // --- Legacy shape ---
  const legacy: QuotaWindow[] = []
  const fromLimitPair = (raw: unknown, id: KimiWindowId): void => {
    if (!raw || typeof raw !== 'object') return
    const e = raw as Record<string, unknown>
    const limit = asNumber(e.limit)
    const remaining = asNumber(e.remaining)
    if (limit == null || limit <= 0) return
    const used = Math.max(0, limit - (remaining ?? limit))
    legacy.push({ id, percent: clampPercent((used / limit) * 100), resetsAt: asEpochMs(e.resetTime ?? e.reset_time) })
  }
  if (Array.isArray(root.limits)) {
    for (const entry of root.limits) {
      const e = entry as Record<string, unknown> | null
      const detail = e?.detail && typeof e.detail === 'object' ? (e.detail as Record<string, unknown>) : e
      // Prefer the entry's own window descriptor: a legacy payload carrying
      // several windows would otherwise label every one of them `fiveHour`,
      // and `finalize` keeps only the last write per id — the rest would
      // silently vanish into that single row.
      fromLimitPair(detail, windowIdFromDescriptor(e?.window ?? detail?.window) ?? 'fiveHour')
    }
  }
  fromLimitPair(root.usage, 'weekly')
  if (legacy.length === 0) return null
  return { windows: legacy, wallet: walletFromCents(root.boosterWallet) }
}

/** Canonical ordering + de-duplication (a payload may repeat a window id) */
function finalize(parsed: ParsedUsage): ParsedUsage | null {
  const byId = new Map<KimiWindowId, QuotaWindow>()
  for (const w of parsed.windows) {
    // Last write wins: a later entry is the more specific one in both shapes
    byId.set(w.id, w)
  }
  if (byId.size === 0) return null
  const windows = [...byId.values()].sort((a, b) => WINDOW_ORDER[a.id] - WINDOW_ORDER[b.id])
  return { windows, wallet: parsed.wallet }
}

async function offer(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    return { status: res.status, json }
  } catch {
    return null
  }
}

/**
 * Read the Kimi Code subscription quota.
 *
 * Tries the local Kimi Code server first, then the remote endpoint using
 * either a locally-stored OAuth token or the caller-supplied API key. Returns
 * `reason: 'no-auth-file'` when neither a running server nor any credential is
 * present, which the card renders as its honest empty state.
 */
export async function fetchKimiUsage(
  fetchImpl: FetchImpl,
  homeDir: string,
  apiKey?: string,
): Promise<KimiOutcome> {
  // --- 1. Loopback server (officially documented, no credential parsing) ---
  const serverToken = await firstReadable(serverTokenPaths(homeDir))
  if (serverToken) {
    for (const port of LOCAL_PORTS) {
      const r = await offer(fetchImpl, `http://127.0.0.1:${port}/api/v1/oauth/usage`, {
        Authorization: `Bearer ${serverToken}`,
        Accept: 'application/json',
      })
      if (!r) continue
      if (r.status === 401 || r.status === 403) break
      if (r.status !== 200) continue
      const parsed = parseLoopback((r.json as { data?: unknown })?.data)
      const finalized = parsed ? finalize(parsed) : null
      if (!finalized) continue
      return { available: true, body: JSON.stringify({ source: 'local-server', ...finalized }) }
    }
  }

  // --- 2. Remote endpoint with a token/key ---
  // Prefer the caller's key (the account editor field); fall back to the OAuth
  // access token the CLI keeps fresh. A locally-stale token is still attempted
  // once — the server is the source of truth, matching the Claude probe.
  const storedToken = await firstReadable(credentialPaths(homeDir))
  let oauthToken: string | null = null
  if (storedToken) {
    try {
      const parsed = JSON.parse(storedToken) as { access_token?: unknown }
      if (typeof parsed.access_token === 'string' && parsed.access_token !== '') {
        oauthToken = parsed.access_token
      }
    } catch {
      oauthToken = null
    }
  }
  const token = apiKey && apiKey !== '' ? apiKey : oauthToken
  if (!token) return { available: false, reason: 'no-auth-file' }

  const r = await offer(fetchImpl, REMOTE_USAGES_URL, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  })
  if (!r) return { available: false, reason: 'probe-failed' }
  if (r.status === 401 || r.status === 403) return { available: false, reason: `http-${r.status}` }
  if (r.status !== 200) return { available: false, reason: `http-${r.status}` }
  const parsed = parseRemote(r.json)
  const finalized = parsed ? finalize(parsed) : null
  if (!finalized) return { available: false, reason: 'malformed-body' }
  return { available: true, body: JSON.stringify({ source: 'remote', ...finalized }) }
}
