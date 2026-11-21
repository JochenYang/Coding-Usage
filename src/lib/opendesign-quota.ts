/**
 * OpenDesign subscription quota view-model. The main process normalizes the
 * Cloud account API into {plan, windows:[{id,percent,resetsAt}], walletUsd?}
 * before it crosses IPC — this module validates that shape for the card.
 * `id` is the window's own duration identity (fiveHour / weekly / other), so
 * the card maps labels through the dict instead of trusting response order.
 */

export type OpendesignWindowId = 'fiveHour' | 'weekly' | 'other'

export interface OpendesignWindowVM {
  id: OpendesignWindowId
  /** Consumed percentage 0-100 */
  percent: number
  resetsAt: number | null
}

export interface OpendesignQuotaVM {
  available: boolean
  /** Reason the quota is unavailable (no credential / expired / http error) */
  reason: string | null
  windows: OpendesignWindowVM[]
  /** Wallet balance in USD when the control-key route answered; optional */
  walletUsd: number | null
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

function parseOpendesignBody(body: string): { windows: OpendesignWindowVM[]; walletUsd: number | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as { windows?: unknown; walletUsd?: unknown }
  if (!Array.isArray(record.windows) || record.windows.length === 0) return null
  const windows: OpendesignWindowVM[] = []
  for (const raw of record.windows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const w = raw as { id?: unknown; percent?: unknown; resetsAt?: unknown }
    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue
    if (w.id !== 'fiveHour' && w.id !== 'weekly' && w.id !== 'other') continue
    windows.push({
      id: w.id,
      // The probe already clamps; the renderer re-clamps so a hand-edited
      // snapshot cannot paint 250%.
      percent: Math.min(100, Math.max(0, w.percent)),
      resetsAt: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
    })
  }
  if (windows.length === 0) return null
  // The wallet is an enhancement field: a missing or non-finite value reads as
  // absent, never as a fabricated 0.
  const walletUsd = typeof record.walletUsd === 'number' && Number.isFinite(record.walletUsd) ? record.walletUsd : null
  return { windows, walletUsd }
}

/** Never throws: a failure or malformed body yields an unavailable view. */
export function summarizeOpendesignQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): OpendesignQuotaVM {
  if (raw.available && raw.body) {
    const parsed = parseOpendesignBody(raw.body)
    if (parsed) return { available: true, reason: null, ...parsed, fetchedAt: Date.now() }
    return { available: false, reason: 'malformed-body', windows: [], walletUsd: null, fetchedAt: null }
  }
  return { available: false, reason: raw.reason ?? null, windows: [], walletUsd: null, fetchedAt: null }
}
