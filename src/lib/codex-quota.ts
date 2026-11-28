/**
 * Codex subscription quota view-model. Raw payload comes from the
 * `codex:quota` IPC (main process reads the local ChatGPT login and queries
 * the official wham endpoint). Purely numbers + reset times — no credentials
 * ever reach the renderer.
 *
 * The endpoint has grown beyond the two rate-limit windows: it also reports the
 * account plan, a pay-as-you-go credit balance, the reset credits the account
 * can still spend, and an optional individual spend cap. Those are parsed here
 * because they are the only place the UI can learn "this account is actually
 * out of credits" — a 0% window looks identical to a healthy one otherwise.
 */
import type { Dict } from '../i18n/types'

/**
 * Map the endpoint's window length to a localized label. The known 5h / 7d /
 * 30d lengths carry their own dict keys; any other length the endpoint may
 * grow falls back to an approximate count instead of showing raw seconds.
 * Shared by the card and the alert engine so both name a window the same way.
 */
export function codexWindowLabel(seconds: number, t: Dict): string {
  if (seconds === 18000) return t.windows.rolling
  if (seconds === 604800) return t.windows.weekly
  if (seconds === 2592000) return t.windows.monthly
  if (seconds <= 0) return t.windows.generic
  const h = Math.round(seconds / 3600)
  if (h < 48) return t.windows.hoursLabel(h)
  return t.windows.daysLabel(Math.round(seconds / 86400))
}

export interface CodexWindowVM {
  /** Window length in seconds; the card maps it to a localized label */
  windowSeconds: number
  /** Used percentage 0-100 */
  percent: number
  resetsAt: number | null
}

/** Pay-as-you-go credit state; `balance` is null when the plan does not meter dollars */
export interface CodexCreditsVM {
  unlimited: boolean
  balance: number | null
}

/** Optional per-account spend cap from `spend_control.individual_limit` */
export interface CodexSpendLimitVM {
  percent: number | null
  reached: boolean
}

export interface CodexQuotaVM {
  available: boolean
  /** Reason the subscription is unavailable (no login / http error) */
  reason: string | null
  primary: CodexWindowVM | null
  secondary: CodexWindowVM | null
  /** Endpoint plan id (free / plus / pro …), shown as-is */
  plan: string | null
  credits: CodexCreditsVM | null
  /** Reset credits still available to spend; null when the endpoint omits it */
  resetCredits: number | null
  /**
   * Epoch ms when the earliest banked reset credit lapses (the companion
   * rate-limit-reset-credits read); null when the endpoint omits it.
   */
  resetCreditsExpiry: number | null
  individualLimit: CodexSpendLimitVM | null
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Epoch seconds, epoch ms or an ISO stamp → epoch ms */
function toEpochMs(value: unknown): number | null {
  // An ISO string must not reach parseFloat, which would read "2026-11-02…" as 2026
  if (typeof value === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const n = numOrNull(value)
  if (n != null) return n < 1e12 ? n * 1000 : n
  return null
}

function parseWindow(raw: unknown): CodexWindowVM | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as {
    used_percent?: number
    usedPercent?: number
    limit_window_seconds?: number
    limitWindowSeconds?: number
    reset_at?: unknown
    resetAt?: unknown
    resets_at?: unknown
  }
  const percent = typeof w.used_percent === 'number' ? w.used_percent : typeof w.usedPercent === 'number' ? w.usedPercent : null
  if (percent == null) return null
  const seconds = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : typeof w.limitWindowSeconds === 'number' ? w.limitWindowSeconds : 0
  // The endpoint has been seen with both spellings; `resets_at` may be ISO.
  const resetsAt = toEpochMs(w.reset_at ?? w.resetAt ?? w.resets_at)
  // Localized labels are the card's job (dict lookup by windowSeconds); the VM
  // carries only the raw seconds so a locale switch never needs a re-probe.
  return { windowSeconds: seconds, percent, resetsAt }
}

function parseCredits(raw: unknown): CodexCreditsVM | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as { unlimited?: unknown; balance?: unknown }
  const unlimited = c.unlimited === true
  const balance = numOrNull(c.balance)
  // Without either fact the block carries nothing worth a row
  if (!unlimited && balance == null) return null
  return { unlimited, balance }
}

/**
 * The cap object carries the percentage; its parent (`spend_control`) carries
 * the `reached` flag, so both are read here rather than assuming one shape.
 */
function parseSpendLimit(raw: unknown, parentReached: unknown): CodexSpendLimitVM | null {
  if (!raw || typeof raw !== 'object') return null
  const limit = raw as { used_percent?: unknown; percent?: unknown; reached?: unknown }
  const percent = numOrNull(limit.used_percent) ?? numOrNull(limit.percent)
  const reached = limit.reached === true || parentReached === true
  if (percent == null && !reached) return null
  return { percent, reached }
}

/** Never throws: malformed input yields an unavailable view */
export function summarizeCodexQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): CodexQuotaVM {
  const empty = {
    plan: null,
    credits: null,
    resetCredits: null,
    resetCreditsExpiry: null,
    individualLimit: null,
  }
  if (raw.available && raw.body) {
    try {
      const parsed = JSON.parse(raw.body) as {
        plan_type?: unknown
        credits?: unknown
        spend_control?: { individual_limit?: unknown; reached?: unknown }
        rate_limit?: { primary_window?: unknown; secondary_window?: unknown }
        rate_limit_reset_credits?: { available_count?: unknown; expiresAtMs?: unknown }
      }
      const primary = parseWindow(parsed.rate_limit?.primary_window)
      const secondary = parseWindow(parsed.rate_limit?.secondary_window)
      const resetCredits = numOrNull(parsed.rate_limit_reset_credits?.available_count)
      return {
        ...empty,
        available: primary != null || secondary != null,
        reason: primary != null || secondary != null ? null : 'malformed-body',
        primary,
        secondary,
        plan: typeof parsed.plan_type === 'string' && parsed.plan_type ? parsed.plan_type : null,
        credits: parseCredits(parsed.credits),
        resetCredits: resetCredits != null && resetCredits > 0 ? resetCredits : null,
        resetCreditsExpiry: toEpochMs(parsed.rate_limit_reset_credits?.expiresAtMs),
        individualLimit: parseSpendLimit(parsed.spend_control?.individual_limit, parsed.spend_control?.reached),
        fetchedAt: Date.now(),
      }
    } catch {
      return {
        ...empty,
        available: false,
        reason: 'bad-response',
        primary: null,
        secondary: null,
        fetchedAt: null,
      }
    }
  }
  return { ...empty, available: false, reason: raw.reason ?? null, primary: null, secondary: null, fetchedAt: null }
}
