/**
 * Qoder (global build) account quota view-model.
 *
 * The main process normalizes `openapi.qoder.sh/sash/api/v2/me/usage` into
 * numbers before it crosses IPC — this module validates that shape for the
 * card. No credentials ever reach the renderer.
 *
 * The unit is Qoder's own: credits. It is not a token count and has no public
 * USD rate, so the card shows credits and a percentage, never a converted price.
 */

export interface QoderQuotaVM {
  available: boolean
  /** Reason the quota is unavailable (no login / unsupported platform / http) */
  reason: string | null
  /** Credits spent in the current pool */
  used: number | null
  /** Pool size in credits */
  total: number | null
  remaining: number | null
  /** Used percentage 0-100 */
  percent: number
  /** True when the vendor says the pool is exhausted */
  exhausted: boolean
  /** Account tier as the vendor names it */
  userType: string | null
  /** Unit label from the vendor ("credits") */
  unit: string
  fetchedAt: number | null
}

const DEFAULT_UNIT = 'credits'

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Never throws: malformed input yields an unavailable view */
export function summarizeQoderQuota(raw: {
  available: boolean
  reason?: string
  used?: number
  total?: number
  remaining?: number
  percent?: number
  isQuotaExceeded?: boolean
  userType?: string
  unit?: string
  fetchedAt?: number
} | null | undefined): QoderQuotaVM {
  const base = {
    percent: 0,
    used: null,
    total: null,
    remaining: null,
    exhausted: false,
    userType: null,
    unit: DEFAULT_UNIT,
    fetchedAt: null,
  } satisfies Omit<QoderQuotaVM, 'available' | 'reason'>
  if (!raw || raw.available !== true) {
    return { available: false, reason: typeof raw?.reason === 'string' ? raw.reason : null, ...base }
  }
  const percent = num(raw.percent)
  return {
    available: true,
    reason: null,
    percent: percent == null ? 0 : Math.min(100, Math.max(0, percent)),
    used: num(raw.used),
    total: num(raw.total),
    remaining: num(raw.remaining),
    exhausted: raw.isQuotaExceeded === true,
    userType: typeof raw.userType === 'string' && raw.userType !== '' ? raw.userType : null,
    unit: typeof raw.unit === 'string' && raw.unit !== '' ? raw.unit : DEFAULT_UNIT,
    fetchedAt: num(raw.fetchedAt),
  }
}
