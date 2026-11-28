import type { Dict } from '../i18n/types'

/**
 * Factory (Droid) quota body decoder. Lives in lib (not the card) so the
 * alert engine can read the same persisted snapshot the card paints from;
 * the card imports everything it renders from here.
 */

/**
 * Window ids `electron/factory-quota.ts` emits (its FactoryWindow union), plus
 * `other` for an id this build does not know yet: a drifted endpoint still
 * carries real usage, so an unknown pool renders under the generic label
 * instead of being silently dropped.
 */
export type FactoryWindowId =
  | 'factoryFiveHour'
  | 'factoryWeekly'
  | 'factoryMonthly'
  | 'factoryCoreFiveHour'
  | 'factoryCoreWeekly'
  | 'factoryCoreMonthly'
  | 'factoryStandard'
  | 'factoryPremium'
  | 'other'

/** Known ids exactly; anything else parses as `other`. */
const KNOWN_WINDOW_IDS: readonly Exclude<FactoryWindowId, 'other'>[] = [
  'factoryFiveHour',
  'factoryWeekly',
  'factoryMonthly',
  'factoryCoreFiveHour',
  'factoryCoreWeekly',
  'factoryCoreMonthly',
  'factoryStandard',
  'factoryPremium',
]

/**
 * Window label resolved through an explicit id -> i18n accessor map, never by
 * string concatenation: a new window id then fails the build here instead of
 * silently rendering a raw key (same contract as KimiQuotaCard).
 */
export const FACTORY_WINDOW_LABELS: Record<FactoryWindowId, (t: Dict) => string> = {
  factoryFiveHour: (t) => t.factoryQuota.windowFiveHour,
  factoryWeekly: (t) => t.factoryQuota.windowWeekly,
  factoryMonthly: (t) => t.factoryQuota.windowMonthly,
  factoryCoreFiveHour: (t) => t.factoryQuota.windowCoreFiveHour,
  factoryCoreWeekly: (t) => t.factoryQuota.windowCoreWeekly,
  factoryCoreMonthly: (t) => t.factoryQuota.windowCoreMonthly,
  factoryStandard: (t) => t.factoryQuota.windowStandard,
  factoryPremium: (t) => t.factoryQuota.windowPremium,
  other: (t) => t.factoryQuota.windowOther,
}

export interface FactoryWindowVM {
  id: FactoryWindowId
  /** Used percentage 0-100 */
  percent: number
  resetsAt: number | null
}

export interface FactoryQuotaVM {
  available: boolean
  /** Reason the probe failed (no key / rejected / http / parse) */
  reason: string | null
  /** Plan label from /api/app/auth/me; garnish, null when absent */
  plan: string | null
  windows: FactoryWindowVM[]
  /** Extra-usage balance in USD; null when the payload carries none */
  topUpCredits: number | null
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/**
 * Decode the probe's normalized body, every field read by name. Ill-typed
 * members degrade individually; a body without a single usable window is not
 * a reading (a drifted payload never becomes a painted 0%).
 */
export function parseFactoryBody(
  body: string,
): { plan: string | null; windows: FactoryWindowVM[]; topUpCredits: number | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const windows: FactoryWindowVM[] = []
  for (const raw of Array.isArray(record.windows) ? record.windows : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const w = raw as { id?: unknown; percent?: unknown; resetsAt?: unknown }
    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue
    const known = KNOWN_WINDOW_IDS.find((id) => id === w.id)
    const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null
    windows.push({ id: known ?? 'other', percent: Math.min(100, Math.max(0, w.percent)), resetsAt })
  }
  if (windows.length === 0) return null
  const topUpCredits =
    typeof record.topUpCredits === 'number' && Number.isFinite(record.topUpCredits) && record.topUpCredits >= 0
      ? record.topUpCredits
      : null
  const plan = typeof record.plan === 'string' && record.plan !== '' ? record.plan : null
  return { plan, windows, topUpCredits }
}

/** Never throws: a failure or malformed body yields an unavailable view. */
export function summarizeFactoryQuota(raw: { available: boolean; body?: string; reason?: string }): FactoryQuotaVM {
  if (raw.available && raw.body) {
    const parsed = parseFactoryBody(raw.body)
    if (parsed) return { available: true, reason: null, ...parsed, fetchedAt: Date.now() }
    return { available: false, reason: 'malformed-body', plan: null, windows: [], topUpCredits: null, fetchedAt: null }
  }
  return { available: false, reason: raw.reason ?? null, plan: null, windows: [], topUpCredits: null, fetchedAt: null }
}
