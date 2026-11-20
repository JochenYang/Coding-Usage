import type { LocalPlanQuotaVM, LocalPlanRaw, LocalPlanWindowId } from './local-plan-quota'

/**
 * View-model for the Cline Pass, JetBrains AI and Windsurf cards.
 *
 * The main process already reduced the vendor payload to numbers. This parser
 * only checks that shape; a missing or partial body stays unavailable instead
 * of becoming 0%.
 */

const WINDOW_IDS = new Set<LocalPlanWindowId>([
  'clineFiveHour',
  'clineWeekly',
  'clineMonthly',
  'jetbrainsMonthly',
  'windsurfDaily',
  'windsurfWeekly',
  'windsurfMessages',
  'windsurfFlow',
  'kiroMonthly',
  'kiloCredits',
  'kiloPass',
  'ali5h',
  'aliWeekly',
  'aliMonthly',
])

function unavailable(reason: string | null): LocalPlanQuotaVM {
  return { available: false, plan: null, reason, windows: [], fetchedAt: null }
}

export function summarizeSessionQuota(raw: LocalPlanRaw): LocalPlanQuotaVM {
  if (!raw.available || !raw.body) return { ...unavailable(raw.reason ?? null), detail: raw.detail ?? null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.body)
  } catch {
    return unavailable('parse-failed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unavailable('parse-failed')
  const body = parsed as { plan?: unknown; windows?: unknown; topUpCredits?: unknown; stale?: unknown }
  const plan = typeof body.plan === 'string' && body.plan.trim() !== '' ? body.plan.trim().slice(0, 80) : null
  const windows = Array.isArray(body.windows)
    ? body.windows.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const id = (item as { id?: unknown }).id
        const percent = (item as { percent?: unknown }).percent
        const resetsAt = (item as { resetsAt?: unknown }).resetsAt
        if (typeof id !== 'string' || !WINDOW_IDS.has(id as LocalPlanWindowId)) return []
        if (typeof percent !== 'number' || !Number.isFinite(percent)) return []
        return [
          {
            id: id as LocalPlanWindowId,
            percent: Math.max(0, Math.min(100, percent)),
            resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null,
          },
        ]
      })
    : []
  const topUp = body.topUpCredits
  const topUpCredits = typeof topUp === 'number' && Number.isFinite(topUp) && topUp >= 0 ? topUp : null
  if (windows.length === 0 && topUpCredits == null) return { ...unavailable('parse-failed'), detail: raw.detail ?? null }
  return {
    available: true,
    plan,
    reason: null,
    windows,
    fetchedAt: null,
    topUpCredits,
    stale: body.stale === true,
  }
}
