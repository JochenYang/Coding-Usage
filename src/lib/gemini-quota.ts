/**
 * Gemini Code Assist quota view-model. Raw payload comes from the
 * `gemini:usage` IPC (main process chains the local Gemini CLI login → OAuth
 * refresh → loadCodeAssist → retrieveUserQuota). Buckets arrive verbatim from
 * the official endpoint; this module normalizes them into the three model
 * classes the plan page shows. Labels resolve through i18n at render time.
 */

export type GeminiGroupId = 'pro' | 'flash' | 'flashLite'

export interface GeminiGroupVM {
  id: GeminiGroupId
  /** Used percentage 0-100 (inverted from the endpoint's remainingFraction) */
  percent: number
  resetsAt: number | null
}

export interface GeminiQuotaVM {
  available: boolean
  /** Reason the subscription is unavailable (no login / http error / refresh failure) */
  reason: string | null
  groups: GeminiGroupVM[]
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/**
 * Classify a quota bucket by its model id. Order matters: `flash-lite` also
 * contains `flash`, so it must win first; everything without pro/flash marker
 * is ignored rather than misattributed.
 */
function classifyModel(modelId: unknown): GeminiGroupId | null {
  if (typeof modelId !== 'string') return null
  if (modelId.includes('flash-lite')) return 'flashLite'
  if (modelId.includes('flash')) return 'flash'
  if (modelId.includes('pro')) return 'pro'
  return null
}

interface BucketDraft {
  fraction: number
  resetAtMs: number | null
}

function parseBucket(raw: unknown): { group: GeminiGroupId; draft: BucketDraft } | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as { modelId?: unknown; remainingFraction?: unknown; resetTime?: unknown }
  const group = classifyModel(b.modelId)
  if (!group || typeof b.remainingFraction !== 'number' || !Number.isFinite(b.remainingFraction)) {
    return null
  }
  const parsedReset = typeof b.resetTime === 'string' ? Date.parse(b.resetTime) : NaN
  return {
    group,
    draft: {
      fraction: Math.min(1, Math.max(0, b.remainingFraction)),
      resetAtMs: Number.isFinite(parsedReset) ? parsedReset : null,
    },
  }
}

/** Display order for the three model classes */
const GROUP_ORDER: ReadonlyArray<GeminiGroupId> = ['pro', 'flash', 'flashLite']

/** Never throws: malformed input yields an unavailable view */
export function summarizeGeminiQuota(raw: {
  available: boolean
  body?: string
  reason?: string
}): GeminiQuotaVM {
  if (raw.available && raw.body) {
    try {
      const parsed = JSON.parse(raw.body) as { buckets?: unknown }
      const buckets = Array.isArray(parsed.buckets) ? parsed.buckets : []
      // A class covers several buckets (e.g. per-feature); show its tightest one
      const worst = new Map<GeminiGroupId, BucketDraft>()
      for (const item of buckets) {
        const entry = parseBucket(item)
        if (!entry) continue
        const current = worst.get(entry.group)
        if (!current || entry.draft.fraction < current.fraction) worst.set(entry.group, entry.draft)
      }
      const groups: GeminiGroupVM[] = [...worst.entries()]
        .map(([id, d]) => ({ id, percent: (1 - d.fraction) * 100, resetsAt: d.resetAtMs }))
        .sort((a, b) => GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id))
      return {
        available: groups.length > 0,
        reason: groups.length > 0 ? null : 'malformed-body',
        groups,
        fetchedAt: Date.now(),
      }
    } catch {
      return { available: false, reason: 'bad-response', groups: [], fetchedAt: null }
    }
  }
  return { available: false, reason: raw.reason ?? null, groups: [], fetchedAt: null }
}
