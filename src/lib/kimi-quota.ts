/**
 * Kimi Code subscription quota view-model. Raw payload comes from the
 * `kimi:usage` IPC (main process reads the local Kimi Code CLI state / loopback
 * server and queries the official usage endpoint). Only usage numbers cross the
 * IPC boundary — the bearer token never reaches the renderer. Window labels
 * resolve through i18n at render time, keyed by the stable window ids below.
 *
 * Numbers here are PERCENTAGES of the plan allowance (verified live: 5h=7%,
 * weekly=9%), not token counts or request counts — so they are rendered as-is
 * and never re-derived from a used/limit ratio. Do not confuse this with the
 * Moonshot platform balance, a money amount on a separate surface with a
 * separate credential.
 */

export type KimiWindowId = 'fiveHour' | 'weekly' | 'monthTotal' | 'monthCode' | 'other'

export interface KimiWindowVM {
  id: KimiWindowId
  /** Used percentage 0-100 (the endpoint already reports a percentage) */
  percent: number
  resetsAt: number | null
}

/** Pay-as-you-go ("booster") wallet; only present when the payload carried money fields */
export interface KimiWalletVM {
  remaining: number | null
  total: number | null
  used: number | null
  currency: string | null
}

export interface KimiQuotaVM {
  available: boolean
  /** Reason the subscription is unavailable (no login / http error / stale token) */
  reason: string | null
  windows: KimiWindowVM[]
  wallet: KimiWalletVM | null
  /** Which surface answered: 'local-server' or 'remote' */
  source: string | null
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/** Canonical display order, matching the main-process emission order */
const WINDOW_ORDER: Record<KimiWindowId, number> = {
  fiveHour: 0,
  weekly: 1,
  monthTotal: 2,
  monthCode: 3,
  other: 4,
}

/** Window ids the main process is allowed to send; anything else is ignored */
const KNOWN_IDS: readonly KimiWindowId[] = ['fiveHour', 'weekly', 'monthTotal', 'monthCode', 'other']

/** Unavailable view: every failure path yields the same honest empty shape */
function unavailable(reason: string | null): KimiQuotaVM {
  return { available: false, reason, windows: [], wallet: null, source: null, fetchedAt: null }
}

/**
 * Validate one payload entry. The window `id` is carried explicitly by the main
 * process — it is derived from the provider's own descriptor (a `limit_7d`
 * key, a `{duration:1, unit:"week"}` window), so the identity is never inferred
 * from array position here. An unknown id is downgraded to 'other' so an
 * unexpected window still surfaces its percentage instead of vanishing.
 * `percent` is mandatory: a window without a usable percentage would only add a
 * fabricated zero to the card.
 */
function parseWindow(raw: unknown): KimiWindowVM | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as { id?: unknown; percent?: unknown; resetsAt?: unknown }
  if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)) return null
  const id =
    typeof w.id === 'string' && (KNOWN_IDS as readonly string[]).includes(w.id)
      ? (w.id as KimiWindowId)
      : 'other'
  return {
    id,
    // Clamp instead of rejecting: the upstream scale is trusted, but a value
    // outside 0-100 would overflow the progress bar
    percent: Math.min(100, Math.max(0, w.percent)),
    resetsAt: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
  }
}

/** Wallet amounts are display garnish: every field degrades to null independently */
function parseWallet(raw: unknown): KimiWalletVM | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const num = (k: string): number | null =>
    typeof w[k] === 'number' && Number.isFinite(w[k]) ? (w[k] as number) : null
  const wallet: KimiWalletVM = {
    remaining: num('remaining'),
    total: num('total'),
    used: num('used'),
    currency: typeof w.currency === 'string' && w.currency.trim() !== '' ? w.currency.trim() : null,
  }
  if (wallet.remaining == null && wallet.total == null && wallet.used == null) return null
  return wallet
}

/** Never throws: malformed input yields an unavailable view */
export function summarizeKimiQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): KimiQuotaVM {
  // The declared type is non-null, but this value arrives over IPC and is
  // untrusted at runtime — a rogue reply must not crash the render
  if (!raw || typeof raw !== 'object') return unavailable(null)
  if (raw.available && raw.body) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.body)
    } catch {
      return unavailable('bad-response')
    }
    // `JSON.parse` may legally return null / a primitive / an array; only a
    // plain object can carry the payload, so narrow before touching fields
    if (!parsed || typeof parsed !== 'object') return unavailable('malformed-body')
    const payload = parsed as Record<string, unknown>
    if (!Array.isArray(payload.windows)) return unavailable('malformed-body')
    const windows: KimiWindowVM[] = []
    for (const entry of payload.windows) {
      const w = parseWindow(entry)
      if (w) windows.push(w)
    }
    if (windows.length === 0) return unavailable('malformed-body')
    // Sort locally as well: the order is part of the display contract, and a
    // reordered payload must not silently reshuffle the card
    windows.sort((a, b) => WINDOW_ORDER[a.id] - WINDOW_ORDER[b.id])
    return {
      available: true,
      reason: null,
      windows,
      wallet: parseWallet(payload.wallet),
      // A non-string source is dropped rather than stringified into a label
      source: typeof payload.source === 'string' ? payload.source : null,
      fetchedAt: Date.now(),
    }
  }
  return unavailable(raw.reason ?? null)
}
