import type { Dict } from '../i18n/types'

/**
 * Amp quota body decoder. Lives in lib (not the card) so the alert engine can
 * read the same persisted snapshot the card paints from; the card imports
 * everything it renders from here.
 */

/**
 * Meter ids `electron/amp-quota.ts` emits (bodyFromAmpMeters), plus `other`
 * for an id this build does not know yet: a drifted CLI output still carries
 * real usage, so an unknown meter renders under the generic label instead of
 * being silently dropped.
 */
export type AmpMeterId = 'ampFree' | 'ampSubscriptionOther' | 'ampSubscriptionOrb' | 'other'

/** Known ids exactly; anything else parses as `other`. */
const KNOWN_METER_IDS: readonly Exclude<AmpMeterId, 'other'>[] = [
  'ampFree',
  'ampSubscriptionOther',
  'ampSubscriptionOrb',
]

/**
 * Meter label resolved through an explicit id -> i18n accessor map, never by
 * string concatenation: a new meter id then fails the build here instead of
 * silently rendering a raw key (same contract as KimiQuotaCard).
 */
export const AMP_METER_LABELS: Record<AmpMeterId, (t: Dict) => string> = {
  ampFree: (t) => t.ampQuota.meterFree,
  ampSubscriptionOther: (t) => t.ampQuota.meterSubscriptionOther,
  ampSubscriptionOrb: (t) => t.ampQuota.meterSubscriptionOrb,
  other: (t) => t.ampQuota.meterOther,
}

export interface AmpMeterVM {
  id: AmpMeterId
  /** Consumed percentage 0-100 (the probe inverts the remaining share) */
  percent: number
  resetsAt: number | null
}

export interface AmpQuotaVM {
  available: boolean
  /** Reason the probe failed (no CLI / timeout / unparsable sheet) */
  reason: string | null
  /** Subscription plan label from the CLI sheet; null when absent */
  plan: string | null
  meters: AmpMeterVM[]
  /** Individual credits balance in USD; null when the sheet carries none */
  individualCredits: number | null
  /** Workspace credits balance in USD; null when the sheet carries none */
  workspaceCredits: number | null
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/**
 * Decode the probe's normalized body, every field read by name. Ill-typed
 * members degrade individually; a sheet with neither a usable meter nor a
 * credit balance is not a reading (a drifted output never paints zeros).
 */
export function parseAmpBody(
  body: string,
): {
  plan: string | null
  meters: AmpMeterVM[]
  individualCredits: number | null
  workspaceCredits: number | null
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const meters: AmpMeterVM[] = []
  for (const raw of Array.isArray(record.windows) ? record.windows : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const w = raw as { id?: unknown; percent?: unknown; resetsAt?: unknown }
    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue
    const known = KNOWN_METER_IDS.find((id) => id === w.id)
    const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null
    meters.push({ id: known ?? 'other', percent: Math.min(100, Math.max(0, w.percent)), resetsAt })
  }
  // A money figure must be a non-negative USD amount; anything else stays absent.
  const usd = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const individualCredits = usd(record.topUpCredits)
  const workspaceCredits = usd(record.workspaceCredits)
  if (meters.length === 0 && individualCredits == null && workspaceCredits == null) return null
  const plan = typeof record.plan === 'string' && record.plan !== '' ? record.plan : null
  return { plan, meters, individualCredits, workspaceCredits }
}

/** Never throws: a failure or malformed body yields an unavailable view. */
export function summarizeAmpQuota(raw: { available: boolean; body?: string; reason?: string }): AmpQuotaVM {
  if (raw.available && raw.body) {
    const parsed = parseAmpBody(raw.body)
    if (parsed) return { available: true, reason: null, ...parsed, fetchedAt: Date.now() }
    return {
      available: false,
      reason: 'malformed-body',
      plan: null,
      meters: [],
      individualCredits: null,
      workspaceCredits: null,
      fetchedAt: null,
    }
  }
  return {
    available: false,
    reason: raw.reason ?? null,
    plan: null,
    meters: [],
    individualCredits: null,
    workspaceCredits: null,
    fetchedAt: null,
  }
}
