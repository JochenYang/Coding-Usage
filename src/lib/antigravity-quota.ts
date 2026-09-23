/**
 * Antigravity subscription quota view-model. The raw payload comes from the
 * `antigravity:usage` IPC: the main process asks the IDE's own language server
 * over loopback (see electron/antigravity-quota.ts) — no credential crosses the
 * IPC boundary, only the quota numbers do.
 *
 * The service answers with a `{ response: { groups: [...] } }` envelope, though
 * the community has also seen `groups` at the top level and under `summary`, so
 * all three are accepted. Each group holds buckets with a `remainingFraction`
 * (0–1, where 1 means the whole allowance is still there) and an ISO `resetTime`.
 *
 * Note the direction: these are REMAINING fractions, matching the IDE's
 * "…Limit Remaining" panel. Every other quota card in this app reports *used*
 * percentages, so the renderer labels this card's rows explicitly rather than
 * reusing the same wording.
 */

export type AntigravityWindowId = 'weekly' | 'fiveHour' | 'other'

/** Which pool a group belongs to; the server's own group name is English-only */
export type AntigravityGroupId = 'gemini' | 'thirdParty' | 'other'

export interface AntigravityBucketVM {
  id: string
  window: AntigravityWindowId
  /** Remaining allowance 0-100 (the service reports remaining, not used) */
  remainingPct: number
  resetsAt: number | null
  /** Server-provided sentence ("… will fully refresh in 6 days, 23 hours.") */
  note: string | null
}

export interface AntigravityGroupVM {
  id: AntigravityGroupId
  /** Server display name, kept as a fallback when the id is unrecognized */
  serverName: string
  buckets: AntigravityBucketVM[]
}

export interface AntigravityQuotaVM {
  available: boolean
  /** Why the quota is unavailable (no IDE running / http error) */
  reason: string | null
  groups: AntigravityGroupVM[]
  /** Epoch ms of this fetch */
  fetchedAt: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Map the bucket's `window` string onto a stable id */
function windowId(raw: unknown): AntigravityWindowId {
  const value = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (value === 'weekly' || value.includes('week') || value.includes('7d')) return 'weekly'
  if (value === '5h' || value.includes('5h') || value.includes('five')) return 'fiveHour'
  return 'other'
}

/**
 * Which pool the group describes. The bucket ids carry the routing prefix
 * (`gemini-weekly`, `3p-weekly` — "3p" is Antigravity's third-party pool for
 * Claude/GPT), which is stabler than the display name.
 */
function groupId(serverName: string, buckets: unknown[]): AntigravityGroupId {
  const ids = buckets
    .map((b) => (isRecord(b) && typeof b.bucketId === 'string' ? b.bucketId.toLowerCase() : ''))
    .join(' ')
  if (ids.includes('gemini')) return 'gemini'
  if (ids.includes('3p') || ids.includes('third')) return 'thirdParty'
  const name = serverName.toLowerCase()
  if (name.includes('gemini')) return 'gemini'
  if (name.includes('claude') || name.includes('gpt')) return 'thirdParty'
  return 'other'
}

/** ISO timestamp → epoch ms, or null when absent/unparseable */
function parseResetTime(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function readBucket(raw: unknown): AntigravityBucketVM | null {
  if (!isRecord(raw)) return null
  const fraction = raw.remainingFraction
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null
  const id = typeof raw.bucketId === 'string' && raw.bucketId !== '' ? raw.bucketId : 'bucket'
  return {
    id,
    window: windowId(raw.window),
    // Clamp: the service has been seen at exactly 1, and a stray >1 would draw
    // a bar past its track
    remainingPct: Math.max(0, Math.min(100, fraction * 100)),
    resetsAt: parseResetTime(raw.resetTime),
    note:
      typeof raw.description === 'string' && raw.description !== '' ? raw.description : null,
  }
}

function readGroup(raw: unknown): AntigravityGroupVM | null {
  if (!isRecord(raw)) return null
  const serverName = typeof raw.displayName === 'string' ? raw.displayName : ''
  const rawBuckets = Array.isArray(raw.buckets) ? raw.buckets : []
  const buckets = rawBuckets
    .map(readBucket)
    .filter((b): b is AntigravityBucketVM => b !== null)
    // A disabled bucket is not something the plan currently grants
    .filter((_b, i) => !(isRecord(rawBuckets[i]) && rawBuckets[i].disabled === true))
  if (buckets.length === 0) return null
  return { id: groupId(serverName, rawBuckets), serverName, buckets }
}

/** Pull the groups array out of the envelope's known nesting locations */
function extractGroups(root: unknown): unknown[] | null {
  if (!isRecord(root)) return null
  if (Array.isArray(root.groups)) return root.groups
  for (const key of ['response', 'summary']) {
    const inner = root[key]
    if (isRecord(inner) && Array.isArray(inner.groups)) return inner.groups
  }
  return null
}

function emptyVM(reason: string | null): AntigravityQuotaVM {
  return { available: false, reason, groups: [], fetchedAt: Date.now() }
}

/**
 * Turn one probe result into the card's view-model. Never throws: an
 * unparseable payload degrades to an unavailable VM so the card can say so
 * instead of rendering a half-filled frame.
 */
export function summarizeAntigravityQuota(raw: unknown): AntigravityQuotaVM {
  if (!isRecord(raw)) return emptyVM('bad-payload')
  if (raw.available !== true) {
    return emptyVM(typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : 'unavailable')
  }
  if (typeof raw.body !== 'string' || raw.body === '') return emptyVM('empty-body')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.body)
  } catch {
    return emptyVM('bad-json')
  }
  const rawGroups = extractGroups(parsed)
  if (rawGroups == null) return emptyVM('no-groups')
  const groups = rawGroups.map(readGroup).filter((g): g is AntigravityGroupVM => g !== null)
  if (groups.length === 0) return emptyVM('no-buckets')
  return { available: true, reason: null, groups, fetchedAt: Date.now() }
}
