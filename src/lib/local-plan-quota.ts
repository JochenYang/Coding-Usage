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
  /** Plan name when the probe reports one (Cursor's comes from GetPlanInfo) */
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
  // Proto JSON sends 64-bit integers as strings; a percentage may follow the
  // same rule, and the probe's adoption gate accepts both — keep them in step.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/**
 * Epoch ms from an ISO string or a millisecond timestamp carried as a string.
 *
 * Cursor's Connect endpoints send `billingCycleEnd` as `"1794928800853"` while
 * the legacy summary sends ISO, and both feed the same reset countdown.
 */
function isoToMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  if (/^\d+$/.test(value)) {
    const ms = Number(value)
    return Number.isFinite(ms) ? ms : null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unavailable(reason: string | null): LocalPlanQuotaVM {
  return { available: false, plan: null, reason, windows: [], fetchedAt: null }
}

/**
 * Cursor reports `*PercentUsed` — already the used share the dashboard restates
 * in English, so it is never inverted here. Both spellings are read: the
 * endpoint answered snake_case (`individual_usage.plan.total_percent_used`) when
 * this parser was written and camelCase (`individualUsage.plan.totalPercentUsed`)
 * after the 2026 rename, and an account can hit either shape during a rollout.
 */
export function summarizeCursorQuota(raw: LocalPlanRaw): LocalPlanQuotaVM {
  if (!raw.available || !raw.body) return unavailable(raw.reason ?? null)
  try {
    const parsed = JSON.parse(raw.body) as {
      is_unlimited?: unknown
      isUnlimited?: unknown
      billing_cycle_end?: unknown
      billingCycleEnd?: unknown
      /** Current builds: the panel's own weekly/unified figure */
      planUsage?: { totalPercentUsed?: unknown; autoPercentUsed?: unknown }
      /** Plan name the probe attached from GetPlanInfo */
      cursorPlanName?: unknown
      individual_usage?: {
        plan?: {
          total_percent_used?: unknown
          auto_percent_used?: unknown
          api_percent_used?: unknown
        }
      }
      individualUsage?: {
        plan?: {
          totalPercentUsed?: unknown
          autoPercentUsed?: unknown
          apiPercentUsed?: unknown
        }
      }
    }
    const resetsAt = isoToMs(parsed.billingCycleEnd ?? parsed.billing_cycle_end)
    const snake = parsed.individual_usage?.plan
    const camel = parsed.individualUsage?.plan
    const period = parsed.planUsage

    // Current builds report one shared pool: total and Auto are the same number
    // on a unified account, so the Auto row is dropped rather than printed twice.
    // Either field alone is enough — the probe adopts on the same rule, so this
    // branch must not silently fall through to a shape the payload lacks.
    let rows: Array<[LocalPlanWindowId, unknown]>
    const periodTotal = period ? num(period.totalPercentUsed) : null
    const periodAuto = period ? num(period.autoPercentUsed) : null
    if (periodTotal != null || periodAuto != null) {
      rows = []
      if (periodTotal != null) rows.push(['cursorTotal', periodTotal])
      if (periodAuto != null && periodAuto !== periodTotal) rows.push(['cursorAuto', periodAuto])
    } else {
      // `??` keeps a genuine 0: only a missing field falls through to the other
      // spelling, so "0% used" is never replaced by an absent camelCase value.
      rows = [
        ['cursorTotal', camel?.totalPercentUsed ?? snake?.total_percent_used],
        ['cursorAuto', camel?.autoPercentUsed ?? snake?.auto_percent_used],
        ['cursorApi', camel?.apiPercentUsed ?? snake?.api_percent_used],
      ]
    }
    const unlimited = parsed.isUnlimited === true || parsed.is_unlimited === true
    const windows: LocalPlanWindowVM[] = []
    for (const [id, value] of rows) {
      const used = num(value)
      if (used == null) continue
      // An unlimited plan still reports the counters; showing 0% keeps the row
      // present without claiming an exhausted allowance.
      windows.push({ id, percent: unlimited ? 0 : clampPct(used), resetsAt })
    }
    if (windows.length === 0) return unavailable('no-windows')
    const plan = typeof parsed.cursorPlanName === 'string' && parsed.cursorPlanName ? parsed.cursorPlanName : null
    return { available: true, plan, reason: null, windows, fetchedAt: Date.now() }
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
