import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { QuotaOutcome } from './subscription-quotas'

/**
 * Windsurf plan quota from the IDE's own local cache.
 *
 * `state.vscdb` is written when Windsurf launches, so the numbers can be stale.
 * This probe does not read browser cookies or call windsurf.com. Only the one
 * `cachedPlanInfo` row is selected; the rest of the database (which can hold
 * other session material) is never copied or returned.
 *
 * `quotaUsage.*RemainingPercent` is remaining, so used percent is `100 - remaining`.
 * Reset timestamps in that object are unix seconds. When the cache has no
 * quota windows, message and flow-action counters are the fallback.
 */

const CACHE_KEY = 'windsurf.settings.cachedPlanInfo'

export interface WindsurfWindow {
  id: 'windsurfDaily' | 'windsurfWeekly' | 'windsurfMessages' | 'windsurfFlow'
  percent: number
  resetsAt: number | null
}

export function windsurfDbCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = []
  if (env.APPDATA) paths.push(join(env.APPDATA, 'Windsurf', 'User', 'globalStorage', 'state.vscdb'))
  paths.push(join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb'))
  paths.push(join(home, '.config', 'Windsurf', 'User', 'globalStorage', 'state.vscdb'))
  return paths
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function counterWindow(
  id: WindsurfWindow['id'],
  used: number | null,
  remaining: number | null,
  total: number | null,
): WindsurfWindow | null {
  if (total == null || total <= 0) return null
  const inferred = used ?? (remaining == null ? null : Math.max(0, total - remaining))
  if (inferred == null) return null
  return { id, percent: clampPct((Math.max(0, Math.min(total, inferred)) / total) * 100), resetsAt: null }
}

/** Parse the cached plan JSON. Returns null when it has no defensible window. */
export function windowsFromCachedPlan(raw: unknown): { plan: string | null; windows: WindsurfWindow[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const planRaw = (raw as { planName?: unknown }).planName
  const plan = typeof planRaw === 'string' && planRaw.trim() !== '' ? planRaw.trim().slice(0, 80) : null
  const windows: WindsurfWindow[] = []
  const quota = (raw as { quotaUsage?: unknown }).quotaUsage
  if (quota && typeof quota === 'object' && !Array.isArray(quota)) {
    const daily = finite((quota as { dailyRemainingPercent?: unknown }).dailyRemainingPercent)
    const weekly = finite((quota as { weeklyRemainingPercent?: unknown }).weeklyRemainingPercent)
    const dailyReset = finite((quota as { dailyResetAtUnix?: unknown }).dailyResetAtUnix)
    const weeklyReset = finite((quota as { weeklyResetAtUnix?: unknown }).weeklyResetAtUnix)
    if (daily != null) {
      windows.push({ id: 'windsurfDaily', percent: clampPct(100 - daily), resetsAt: dailyReset == null ? null : dailyReset * 1000 })
    }
    if (weekly != null) {
      windows.push({
        id: 'windsurfWeekly',
        percent: clampPct(100 - weekly),
        resetsAt: weeklyReset == null ? null : weeklyReset * 1000,
      })
    }
  }
  const usage = (raw as { usage?: unknown }).usage
  // Counters are only a fallback when the cache has no official quota windows.
  // One daily percent must not be paired with a leftover flow-action bar.
  if (windows.length === 0 && usage && typeof usage === 'object' && !Array.isArray(usage)) {
    const u = usage as {
      messages?: unknown
      usedMessages?: unknown
      remainingMessages?: unknown
      flowActions?: unknown
      usedFlowActions?: unknown
      remainingFlowActions?: unknown
    }
    if (!windows.some((win) => win.id === 'windsurfDaily')) {
      const messages = counterWindow('windsurfMessages', finite(u.usedMessages), finite(u.remainingMessages), finite(u.messages))
      if (messages) windows.push(messages)
    }
    if (!windows.some((win) => win.id === 'windsurfWeekly')) {
      const flow = counterWindow('windsurfFlow', finite(u.usedFlowActions), finite(u.remainingFlowActions), finite(u.flowActions))
      if (flow) windows.push(flow)
    }
  }
  if (windows.length === 0) return null
  return { plan, windows }
}

function jsonFromCell(value: unknown): unknown | null {
  const textOf = (bytes: Uint8Array, encoding: 'utf8' | 'utf16le'): string | null => {
    const text = Buffer.from(bytes).toString(encoding).replace(/\0+$/, '').trim()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value instanceof Uint8Array) return textOf(value, 'utf8') ?? textOf(value, 'utf16le')
  return null
}

function readCachedPlan(path: string): { status: 'ok' | 'missing' | 'failed'; plan: unknown } {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CACHE_KEY) as { value?: unknown } | undefined
    if (!row) return { status: 'missing', plan: null }
    return { status: 'ok', plan: jsonFromCell(row.value) }
  } catch {
    return { status: 'failed', plan: null }
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
}

export async function fetchWindsurfQuota(home: string, env: NodeJS.ProcessEnv): Promise<QuotaOutcome> {
  const path = windsurfDbCandidates(home, env).find((candidate) => existsSync(candidate))
  if (!path) return { available: false, reason: 'no-auth' }
  const row = readCachedPlan(path)
  if (row.status === 'failed') return { available: false, reason: 'probe-failed' }
  if (row.status === 'missing') return { available: false, reason: 'no-data' }
  const parsed = windowsFromCachedPlan(row.plan)
  if (!parsed) return { available: false, reason: 'no-data' }
  return {
    available: true,
    body: JSON.stringify({ plan: parsed.plan, windows: parsed.windows, topUpCredits: null, stale: true }),
  }
}
