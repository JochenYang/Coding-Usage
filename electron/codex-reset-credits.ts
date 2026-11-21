import { objOf } from './json-shape'

/**
 * Codex banked rate-limit reset credits — the "攒的重置券" companion read.
 *
 * The wham/usage response already carries `rate_limit_reset_credits.available_count`
 * (see narrowCodexUsage in main.ts), and the renderer derives its resetCredits
 * figure from it. The companion GET adds what the usage response does not say:
 * when each banked credit lapses (`credits[].expires_at`). ai-usagebar, which
 * documents both endpoints from live captures, keeps the count from the usage
 * response — it is the one consistent with the quota figures beside it — and
 * treats a failure of this call as costing the expiry date and nothing else.
 *
 * This module therefore only ever ADDS to the narrowed usage body: it never
 * overwrites a count the usage response supplied, and every failure degrades
 * to "no extra field", never to a failed probe. The redemption identifiers
 * (`credits[].id`) are skipped during parsing rather than parsed and dropped,
 * so the handle that spends a reset reaches neither the snapshot nor the card.
 */

const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
/** Bounded scan: a hostile `credits` array cannot make this loop unbounded */
const CREDITS_CAP = 64

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export interface CodexResetCredits {
  availableCount: number
  /** Earliest expiry across the banked credits, epoch ms; null when none parses */
  earliestExpiryMs: number | null
}

/** A whole-number count: proto-style payloads send integers as strings too */
function intOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** Epoch seconds, epoch ms or an ISO stamp → epoch ms (mirrors codex-quota.ts) */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return parsed < 1e12 ? parsed * 1000 : parsed
}

export function resetCreditsFromPayload(raw: unknown): CodexResetCredits | null {
  const root = objOf(raw)
  if (!root) return null
  const count = intOf(root.available_count) ?? intOf(root.availableCount)
  if (count == null || count <= 0) return null
  const credits = Array.isArray(root.credits) ? root.credits.slice(0, CREDITS_CAP) : []
  let earliestExpiryMs: number | null = null
  for (const item of credits) {
    const credit = objOf(item)
    if (!credit) continue
    // A non-"available" row is spent or expired; taking its earlier expiry
    // would misstate when the usable resets lapse.
    if (typeof credit.status === 'string' && credit.status !== 'available') continue
    const expiry = toEpochMs(credit.expires_at) ?? toEpochMs(credit.expiresAt)
    if (expiry != null && (earliestExpiryMs == null || expiry < earliestExpiryMs)) {
      earliestExpiryMs = expiry
    }
  }
  return { availableCount: count, earliestExpiryMs }
}

/**
 * Fold the companion read into the narrowed usage body. The usage response's
 * count always wins; the expiry date is added beside it, and the count from
 * this endpoint fills in only when the usage response said nothing (shape
 * drift). Nothing to add returns the input object unchanged.
 */
export function mergeCodexResetCredits(
  narrowed: Record<string, unknown>,
  reset: CodexResetCredits | null,
): Record<string, unknown> {
  if (!reset) return narrowed
  const existing = objOf(narrowed.rate_limit_reset_credits)
  const usageCount = existing && typeof existing.available_count === 'number' ? existing.available_count : null
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  if (usageCount == null && reset.availableCount > 0) merged.available_count = reset.availableCount
  if (reset.earliestExpiryMs != null) merged.expiresAtMs = reset.earliestExpiryMs
  if (existing && Object.keys(merged).length === Object.keys(existing).length) return narrowed
  return { ...narrowed, rate_limit_reset_credits: merged }
}

/**
 * The companion GET, best-effort and fully self-contained: any non-ok status,
 * unparsable body or transport failure is null, and the caller passes the
 * headers it already built for the usage endpoint (this module never handles
 * the credential itself).
 */
export async function fetchCodexResetCredits(
  fetchImpl: FetchImpl,
  headers: Record<string, string>,
): Promise<CodexResetCredits | null> {
  try {
    const res = await fetchImpl(RESET_CREDITS_URL, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(await res.text())
    } catch {
      return null
    }
    return resetCreditsFromPayload(parsed)
  } catch {
    return null
  }
}
