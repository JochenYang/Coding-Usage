/**
 * Claude subscription quota view-model. Raw payload comes from the
 * `claude:usage` IPC (main process reads the local Claude Code OAuth login and
 * queries the official usage endpoint). Purely numbers + reset times — no
 * credentials ever reach the renderer. Window labels resolve through i18n at
 * render time, keyed by the stable window ids below.
 *
 * The endpoint also reports a `limits` array: one entry per scoped allowance
 * (for example a weekly cap that only applies to one model). Those are shown as
 * their own rows because a model-scoped cap can be exhausted while the global
 * windows still read healthy.
 */

export type ClaudeWindowId = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet'

export interface ClaudeWindowVM {
  id: ClaudeWindowId
  /** Used percentage 0-100 (the endpoint's `utilization` field, passed through) */
  percent: number
  resetsAt: number | null
}

/** A model-scoped allowance from `limits[]`; the label comes from the server */
export interface ClaudeScopedWindowVM {
  label: string
  percent: number
  resetsAt: number | null
}

export interface ClaudeQuotaVM {
  available: boolean
  /** Reason the subscription is unavailable (no login / http error / stale token) */
  reason: string | null
  windows: ClaudeWindowVM[]
  /** Model-scoped allowances; empty on payloads that predate `limits[]` */
  scoped: ClaudeScopedWindowVM[]
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

function parseScopedLimit(raw: unknown): ClaudeScopedWindowVM | null {
  if (!raw || typeof raw !== 'object') return null
  const limit = raw as {
    kind?: unknown
    percent?: unknown
    utilization?: unknown
    resets_at?: unknown
    scope?: { model?: { display_name?: unknown; displayName?: unknown } }
  }
  const percent =
    typeof limit.percent === 'number' && Number.isFinite(limit.percent)
      ? limit.percent
      : typeof limit.utilization === 'number' && Number.isFinite(limit.utilization)
        ? limit.utilization
        : null
  if (percent == null) return null
  const model = limit.scope?.model
  const label =
    (typeof model?.display_name === 'string' && model.display_name) ||
    (typeof model?.displayName === 'string' && model.displayName) ||
    (typeof limit.kind === 'string' && limit.kind) ||
    ''
  if (!label) return null
  const parsedReset = typeof limit.resets_at === 'string' ? Date.parse(limit.resets_at) : NaN
  return { label, percent, resetsAt: Number.isFinite(parsedReset) ? parsedReset : null }
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
      // One row per model, keeping the tightest reading when the payload repeats it
      const scopedByLabel = new Map<string, ClaudeScopedWindowVM>()
      const limits = Array.isArray(parsed.limits) ? parsed.limits : []
      for (const rawLimit of limits) {
        const scoped = parseScopedLimit(rawLimit)
        if (!scoped) continue
        const previous = scopedByLabel.get(scoped.label)
        if (!previous || scoped.percent > previous.percent) scopedByLabel.set(scoped.label, scoped)
      }
      const scoped = [...scopedByLabel.values()]
      const available = windows.length > 0 || scoped.length > 0
      return {
        available,
        reason: available ? null : 'malformed-body',
        windows,
        scoped,
        fetchedAt: Date.now(),
      }
    } catch {
      return { available: false, reason: 'bad-response', windows: [], scoped: [], fetchedAt: null }
    }
  }
  return { available: false, reason: raw.reason ?? null, windows: [], scoped: [], fetchedAt: null }
}
