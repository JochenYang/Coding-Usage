import type { Dict } from '../i18n/types'

/**
 * Devin quota body decoder. Lives in lib (not the card) so the alert engine
 * can read the same persisted snapshot the card paints from; the card
 * imports everything it renders from here.
 */

/**
 * Window ids `electron/devin-quota.ts` emits (its DevinWindow union), plus
 * `other` for an id this build does not know yet: a drifted endpoint still
 * carries real usage, so an unknown pool renders under the generic label
 * instead of being silently dropped.
 */
export type DevinWindowId = 'devinDaily' | 'devinWeekly' | 'other'

/** Known ids exactly; anything else parses as `other`. */
const KNOWN_WINDOW_IDS: readonly Exclude<DevinWindowId, 'other'>[] = ['devinDaily', 'devinWeekly']

/**
 * Window label resolved through an explicit id -> i18n accessor map, never by
 * string concatenation: a new window id then fails the build here instead of
 * silently rendering a raw key (same contract as KimiQuotaCard).
 */
export const DEVIN_WINDOW_LABELS: Record<DevinWindowId, (t: Dict) => string> = {
  devinDaily: (t) => t.devinQuota.windowDaily,
  devinWeekly: (t) => t.devinQuota.windowWeekly,
  other: (t) => t.devinQuota.windowOther,
}

export interface DevinWindowVM {
  id: DevinWindowId
  /** Consumed percentage 0-100 (the probe inverts the remaining share) */
  percent: number
  resetsAt: number | null
}

export interface DevinQuotaVM {
  available: boolean
  /** Reason the probe failed (no login / rejected / http / parse) */
  reason: string | null
  /** Plan label from planStatus.planInfo; null when absent */
  plan: string | null
  windows: DevinWindowVM[]
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/**
 * Decode the probe's normalized body, every field read by name. Ill-typed
 * members degrade individually; a body without a single usable window is not
 * a reading (a drifted payload never becomes a painted 0%).
 */
export function parseDevinBody(body: string): { plan: string | null; windows: DevinWindowVM[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const windows: DevinWindowVM[] = []
  for (const raw of Array.isArray(record.windows) ? record.windows : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const w = raw as { id?: unknown; percent?: unknown; resetsAt?: unknown }
    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue
    const known = KNOWN_WINDOW_IDS.find((id) => id === w.id)
    const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null
    windows.push({ id: known ?? 'other', percent: Math.min(100, Math.max(0, w.percent)), resetsAt })
  }
  if (windows.length === 0) return null
  const plan = typeof record.plan === 'string' && record.plan !== '' ? record.plan : null
  return { plan, windows }
}

/** Never throws: a failure or malformed body yields an unavailable view. */
export function summarizeDevinQuota(raw: { available: boolean; body?: string; reason?: string }): DevinQuotaVM {
  if (raw.available && raw.body) {
    const parsed = parseDevinBody(raw.body)
    if (parsed) return { available: true, reason: null, ...parsed, fetchedAt: Date.now() }
    return { available: false, reason: 'malformed-body', plan: null, windows: [], fetchedAt: null }
  }
  return { available: false, reason: raw.reason ?? null, plan: null, windows: [], fetchedAt: null }
}
