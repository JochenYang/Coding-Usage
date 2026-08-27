/**
 * Claude subscription quota view-model. Raw payload comes from the
 * `claude:usage` IPC (main process reads the local Claude Code OAuth login and
 * queries the official usage endpoint). Purely numbers + reset times — no
 * credentials ever reach the renderer. Window labels resolve through i18n at
 * render time, keyed by the stable window ids below.
 */

export type ClaudeWindowId = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet'

export interface ClaudeWindowVM {
  id: ClaudeWindowId
  /** Used percentage 0-100 (the endpoint's `utilization` field, passed through) */
  percent: number
  resetsAt: number | null
}

export interface ClaudeQuotaVM {
  available: boolean
  /** Reason the subscription is unavailable (no login / http error / stale token) */
  reason: string | null
  windows: ClaudeWindowVM[]
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/** Canonical display order for the endpoint's usage windows */
const KNOWN_WINDOWS: ReadonlyArray<{ key: string; id: ClaudeWindowId }> = [
  { key: 'five_hour', id: 'fiveHour' },
  { key: 'seven_day', id: 'sevenDay' },
  { key: 'seven_day_opus', id: 'sevenDayOpus' },
  { key: 'seven_day_sonnet', id: 'sevenDaySonnet' },
]

function parseWindow(raw: unknown): Omit<ClaudeWindowVM, 'id'> | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as { utilization?: unknown; resets_at?: unknown }
  if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null
  // `resets_at` is an ISO timestamp string; unparsable values degrade to no countdown
  const parsedReset = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
  return {
    percent: w.utilization,
    resetsAt: Number.isFinite(parsedReset) ? parsedReset : null,
  }
}

/** Never throws: malformed input yields an unavailable view */
export function summarizeClaudeQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): ClaudeQuotaVM {
  if (raw.available && raw.body) {
    try {
      const parsed = JSON.parse(raw.body) as Record<string, unknown>
      const windows: ClaudeWindowVM[] = []
      for (const { key, id } of KNOWN_WINDOWS) {
        const vm = parseWindow(parsed[key])
        if (vm) windows.push({ id, ...vm })
      }
      return {
        available: windows.length > 0,
        reason: windows.length > 0 ? null : 'malformed-body',
        windows,
        fetchedAt: Date.now(),
      }
    } catch {
      return { available: false, reason: 'bad-response', windows: [], fetchedAt: null }
    }
  }
  return { available: false, reason: raw.reason ?? null, windows: [], fetchedAt: null }
}
