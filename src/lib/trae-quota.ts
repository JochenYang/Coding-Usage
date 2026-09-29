/**
 * Trae CN credits usage view-model. The main process decrypts the IDE's local
 * login (an AES "tc" blob) and normalizes the official credits endpoint into
 * `{percent, consumed, total, resetsAt, plan, packs}` before it crosses IPC —
 * this module validates that shape for the card. No credentials ever reach
 * the renderer.
 */

export interface TraePackVM {
  /** Entitlement display name (e.g. the free tier or a monthly bonus pack) */
  name: string
  /** Credits granted by the pack; null when it is not credit-denominated */
  credits: number | null
  /** Epoch ms when the pack expires */
  resetsAt: number | null
}

export interface TraeQuotaVM {
  available: boolean
  /** Reason the usage is unavailable (no login / expired token / http error) */
  reason: string | null
  /** Used percentage 0-100 */
  percent: number
  /** Credits consumed in the current period */
  consumed: number
  /** Total credits of the period */
  total: number
  /** Epoch ms when the period rolls over */
  resetsAt: number | null
  plan: string | null
  packs: TraePackVM[]
  fetchedAt: number | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Never throws: malformed input yields an unavailable view */
export function summarizeTraeQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): TraeQuotaVM {
  const empty = (reason: string): TraeQuotaVM => ({
    available: false,
    reason,
    percent: 0,
    consumed: 0,
    total: 0,
    resetsAt: null,
    plan: null,
    packs: [],
    fetchedAt: null,
  })

  if (!raw.available || !raw.body) return empty(raw.reason ?? 'unavailable')
  try {
    const parsed = JSON.parse(raw.body) as {
      percent?: unknown
      consumed?: unknown
      total?: unknown
      resetsAt?: unknown
      plan?: unknown
      packs?: unknown
    }
    const percent = num(parsed.percent)
    const consumed = num(parsed.consumed)
    const total = num(parsed.total)
    if (percent == null || consumed == null || total == null) return empty('malformed-body')
    const packs: TraePackVM[] = Array.isArray(parsed.packs)
      ? parsed.packs
          .filter(
            (p): p is { name?: unknown; credits?: unknown; resetsAt?: unknown } =>
              !!p && typeof p === 'object',
          )
          .map((p) => ({
            name: typeof p.name === 'string' ? p.name : '',
            credits: num(p.credits),
            resetsAt: num(p.resetsAt),
          }))
          .filter((p) => p.name !== '')
      : []
    return {
      available: true,
      reason: null,
      percent: Math.min(100, Math.max(0, percent)),
      consumed,
      total,
      resetsAt: num(parsed.resetsAt),
      plan: typeof parsed.plan === 'string' && parsed.plan !== '' ? parsed.plan : null,
      packs,
      fetchedAt: Date.now(),
    }
  } catch {
    return empty('bad-response')
  }
}
