/**
 * Codex subscription quota view-model. Raw payload comes from the
 * `codex:quota` IPC (main process reads the local ChatGPT login and queries
 * the official wham endpoint). Purely numbers + reset times — no credentials
 * ever reach the renderer.
 */

export interface CodexWindowVM {
  /** Window label: 5 小时 / 7 天 / 30 天 by the endpoint's limit_window_seconds */
  label: string
  /** Used percentage 0-100 */
  percent: number
  resetsAt: number | null
}

export interface CodexQuotaVM {
  available: boolean
  /** Reason the subscription is unavailable (no login / http error) */
  reason: string | null
  primary: CodexWindowVM | null
  secondary: CodexWindowVM | null
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

function windowLabel(seconds: number): string {
  if (seconds === 18000) return '5 小时窗口'
  if (seconds === 604800) return '7 天窗口'
  if (seconds === 2592000) return '30 天窗口'
  const h = Math.round(seconds / 3600)
  if (h < 48) return `${h} 小时窗口`
  const d = Math.round(seconds / 86400)
  return `${d} 天窗口`
}

function parseWindow(raw: unknown): CodexWindowVM | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as {
    used_percent?: number
    usedPercent?: number
    limit_window_seconds?: number
    limitWindowSeconds?: number
    reset_at?: number
    resetAt?: number
  }
  const percent = typeof w.used_percent === 'number' ? w.used_percent : typeof w.usedPercent === 'number' ? w.usedPercent : null
  if (percent == null) return null
  const seconds = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : typeof w.limitWindowSeconds === 'number' ? w.limitWindowSeconds : 0
  const resetRaw = typeof w.reset_at === 'number' ? w.reset_at : typeof w.resetAt === 'number' ? w.resetAt : null
  const resetsAt = resetRaw != null ? (resetRaw < 1e12 ? resetRaw * 1000 : resetRaw) : null
  return { label: seconds > 0 ? windowLabel(seconds) : '窗口', percent, resetsAt }
}

/** Never throws: malformed input yields an unavailable view */
export function summarizeCodexQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): CodexQuotaVM {
  if (raw.available && raw.body) {
    try {
      const parsed = JSON.parse(raw.body) as { rate_limit?: { primary_window?: unknown; secondary_window?: unknown } }
      const primary = parseWindow(parsed.rate_limit?.primary_window)
      const secondary = parseWindow(parsed.rate_limit?.secondary_window)
      return {
        available: primary != null,
        reason: primary == null ? 'malformed-body' : null,
        primary,
        secondary,
        fetchedAt: Date.now(),
      }
    } catch {
      return { available: false, reason: 'bad-response', primary: null, secondary: null, fetchedAt: null }
    }
  }
  return { available: false, reason: raw.reason ?? null, primary: null, secondary: null, fetchedAt: null }
}
