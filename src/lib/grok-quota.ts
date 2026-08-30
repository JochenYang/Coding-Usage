/**
 * Grok subscription quota view-model. The main process normalizes the
 * official billing endpoint into {percent, resetsAt, plan, email} before it
 * crosses IPC — this module validates that shape for the card. No
 * credentials ever reach the renderer.
 */

export interface GrokQuotaVM {
  available: boolean
  /** Reason the subscription is unavailable (no login / http error) */
  reason: string | null
  /** Used percentage 0-100 */
  percent: number
  /** Epoch ms when the billing period resets */
  resetsAt: number | null
  /** Plan display name from /v1/settings (SuperGrok / SuperGrok Heavy / …) */
  plan: string | null
  email: string | null
  fetchedAt: number | null
}

/** Never throws: malformed input yields an unavailable view */
export function summarizeGrokQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): GrokQuotaVM {
  if (raw.available && raw.body) {
    try {
      const parsed = JSON.parse(raw.body) as {
        percent?: unknown
        resetsAt?: unknown
        plan?: unknown
        email?: unknown
      }
      if (typeof parsed.percent !== 'number' || !Number.isFinite(parsed.percent)) {
        return { available: false, reason: 'malformed-body', percent: 0, resetsAt: null, plan: null, email: null, fetchedAt: null }
      }
      return {
        available: true,
        reason: null,
        percent: Math.min(100, Math.max(0, parsed.percent)),
        resetsAt: typeof parsed.resetsAt === 'number' ? parsed.resetsAt : null,
        plan: typeof parsed.plan === 'string' && parsed.plan !== '' ? parsed.plan : null,
        email: typeof parsed.email === 'string' && parsed.email !== '' ? parsed.email : null,
        fetchedAt: Date.now(),
      }
    } catch {
      return { available: false, reason: 'bad-response', percent: 0, resetsAt: null, plan: null, email: null, fetchedAt: null }
    }
  }
  return {
    available: false,
    reason: raw.reason ?? null,
    percent: 0,
    resetsAt: null,
    plan: null,
    email: null,
    fetchedAt: null,
  }
}
