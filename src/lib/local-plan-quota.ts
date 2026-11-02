/**
 * Cursor and GitHub Copilot plan quota view-models.
 *
 * The raw payload comes from the `cursor:usage` / `copilot:usage` IPC: the main
 * process reads the client's own on-disk login and calls the endpoint, so only
 * usage numbers cross the boundary. Both endpoints are undocumented and their
 * field names have already changed once, so every field is optional here and a
 * payload that yields no window degrades to an honest unavailable state.
 */

export type LocalPlanWindowId = 'cursorTotal' | 'cursorAuto' | 'cursorApi' | 'copilotPremium' | 'copilotChat'

export interface LocalPlanWindowVM {
  /** Also the i18n key under `windows` */
  id: LocalPlanWindowId
  /** Used percentage 0-100 */
  percent: number
  resetsAt: number | null
}

export interface LocalPlanQuotaVM {
  available: boolean
  /** Endpoint plan id when it reports one (Cursor leaves it out) */
  plan: string | null
  reason: string | null
  windows: LocalPlanWindowVM[]
  fetchedAt: number | null
}

export interface LocalPlanRaw {
  available: boolean
  body?: string
  reason?: string
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function isoToMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unavailable(reason: string | null): LocalPlanQuotaVM {
  return { available: false, plan: null, reason, windows: [], fetchedAt: null }
}

/**
 * Cursor reports `*_percent_used` — already the used share the dashboard
 * restates in English, so it is never inverted here.
 */
export function summarizeCursorQuota(raw: LocalPlanRaw): LocalPlanQuotaVM {
  if (!raw.available || !raw.body) return unavailable(raw.reason ?? null)
  try {
    const parsed = JSON.parse(raw.body) as {
      is_unlimited?: unknown
      billing_cycle_end?: unknown
      individual_usage?: {
        plan?: {
          total_percent_used?: unknown
          auto_percent_used?: unknown
          api_percent_used?: unknown
        }
      }
    }
    const resetsAt = isoToMs(parsed.billing_cycle_end)
    const plan = parsed.individual_usage?.plan
    const rows: Array<[LocalPlanWindowId, unknown]> = [
      ['cursorTotal', plan?.total_percent_used],
      ['cursorAuto', plan?.auto_percent_used],
      ['cursorApi', plan?.api_percent_used],
    ]
    const windows: LocalPlanWindowVM[] = []
    for (const [id, value] of rows) {
      const used = num(value)
      if (used == null) continue
      // An unlimited plan still reports the counters; showing 0% keeps the row
      // present without claiming an exhausted allowance.
      windows.push({ id, percent: parsed.is_unlimited === true ? 0 : clampPct(used), resetsAt })
    }
    if (windows.length === 0) return unavailable('no-windows')
    return { available: true, plan: null, reason: null, windows, fetchedAt: Date.now() }
  } catch {
    return unavailable('bad-response')
  }
}

/**
 * Copilot reports `percent_remaining`; this app renders used percentages, so
 * the inversion happens exactly once, here.
 */
export function summarizeCopilotQuota(raw: LocalPlanRaw): LocalPlanQuotaVM {
  if (!raw.available || !raw.body) return unavailable(raw.reason ?? null)
  try {
    const parsed = JSON.parse(raw.body) as {
      copilot_plan?: unknown
      quota_reset_date?: unknown
      quota_snapshots?: {
        premium_interactions?: { percent_remaining?: unknown }
        chat?: { percent_remaining?: unknown }
      }
    }
    const resetsAt = isoToMs(parsed.quota_reset_date)
    const rows: Array<[LocalPlanWindowId, unknown]> = [
      ['copilotPremium', parsed.quota_snapshots?.premium_interactions?.percent_remaining],
      ['copilotChat', parsed.quota_snapshots?.chat?.percent_remaining],
    ]
    const windows: LocalPlanWindowVM[] = []
    for (const [id, value] of rows) {
      const left = num(value)
      if (left == null) continue
      windows.push({ id, percent: clampPct(100 - left), resetsAt })
    }
    if (windows.length === 0) return unavailable('no-windows')
    return {
      available: true,
      plan: typeof parsed.copilot_plan === 'string' && parsed.copilot_plan ? parsed.copilot_plan : null,
      reason: null,
      windows,
      fetchedAt: Date.now(),
    }
  } catch {
    return unavailable('bad-response')
  }
}
