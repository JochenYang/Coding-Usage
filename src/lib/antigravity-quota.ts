/**
 * Antigravity subscription quota view-model. The raw payload comes from the
 * `antigravity:usage` IPC: the main process asks the Cloud Code API with the
 * credentials Antigravity stores, falling back to the IDE's loopback service on
 * older builds (see electron/antigravity-quota.ts) — no credential crosses the
 * IPC boundary, only the quota numbers do.
 *
 * Three clients share this card because they share the service: the IDE, the
 * app (Antigravity 2.0) and the CLI. The account's allowance is one pool, so a
 * machine signed into one account shows the same figures on all three; what
 * differs is where each client keeps its login and whether it is installed.
 *
 * The service answers with a `{ response: { groups: [...] } }` envelope, though
 * `groups` at the top level and under `summary` have also been seen, so all
 * three are accepted. Each group holds buckets with a `remainingFraction`
 * (0–1, where 1 means the whole allowance is still there) and an ISO `resetTime`.
 * The fraction is **omitted once the allowance is exhausted**, so a missing
 * value is read as 0 — dropping it would hide an empty pool from the card.
 *
 * Note the direction: these are REMAINING fractions, matching the IDE's
 * "…Limit Remaining" panel. Every other quota card in this app reports *used*
 * percentages, so the renderer labels this card's rows explicitly rather than
 * reusing the same wording.
 */

/** The three Antigravity clients that each get a quota card */
export type AntigravityFlavour = 'ide' | 'app' | 'cli'

export interface AntigravityFlavourDef {
  /** Card key: the registry key in subscription-cards.ts and the quota-snapshot slot */
  key: string
  /** Brand name shown on the card and in the manage drawer; not translated */
  name: string
  /** Data directory under `~/.gemini`, which is how Antigravity itself names the three clients */
  dir: 'antigravity-ide' | 'antigravity' | 'antigravity-cli'
}

/**
 * Keyed by flavour; `antigravity` alone is the app, matching the client's own
 * directory name. The IDE card was `antigravity` before the split — documents
 * written before it are renamed on load (see `subscriptionKeysVersion`).
 */
export const ANTIGRAVITY_FLAVOURS: Record<AntigravityFlavour, AntigravityFlavourDef> = {
  ide: { key: 'antigravity-ide', name: 'Antigravity IDE', dir: 'antigravity-ide' },
  app: { key: 'antigravity', name: 'Antigravity App', dir: 'antigravity' },
  cli: { key: 'antigravity-cli', name: 'Antigravity CLI', dir: 'antigravity-cli' },
}

/** Narrow an IPC argument to a flavour; anything else is not one */
export function isAntigravityFlavour(value: unknown): value is AntigravityFlavour {
  return value === 'ide' || value === 'app' || value === 'cli'
}

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
  /** Why the quota is unavailable (no login found / http error) */
  reason: string | null
  groups: AntigravityGroupVM[]
  /** Epoch ms of this fetch */
  fetchedAt: number
  /**
   * Whether this flavour is still installed. `false` is reported only when the
   * main process could establish that it is gone (Windows only for now); `null`
   * means present or unknown and the card says nothing about it.
   */
  installed: boolean | null
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
  // A disabled bucket is not something the plan currently grants
  if (raw.disabled === true) return null
  // The service omits remainingFraction once the allowance is exhausted, so a
  // missing fraction means 0% left — not "no data". Dropping the bucket here
  // used to make an exhausted pool disappear from the card entirely.
  const fraction = raw.remainingFraction
  const remaining = typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : 0
  const id = typeof raw.bucketId === 'string' && raw.bucketId !== '' ? raw.bucketId : 'bucket'
  return {
    id,
    window: windowId(raw.window),
    // Clamp: the service has been seen at exactly 1, and a stray >1 would draw
    // a bar past its track
    remainingPct: Math.max(0, Math.min(100, remaining * 100)),
    resetsAt: parseResetTime(raw.resetTime),
    note:
      typeof raw.description === 'string' && raw.description !== '' ? raw.description : null,
  }
}

function readGroup(raw: unknown): AntigravityGroupVM | null {
  if (!isRecord(raw)) return null
  const serverName = typeof raw.displayName === 'string' ? raw.displayName : ''
  const rawBuckets = Array.isArray(raw.buckets) ? raw.buckets : []
  const buckets = rawBuckets.map(readBucket).filter((b): b is AntigravityBucketVM => b !== null)
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

/** Only an explicit `false` claims the client is gone; absent, `true` and junk stay unknown */
function readInstalled(raw: unknown): boolean | null {
  return raw === false ? false : raw === true ? true : null
}

function emptyVM(reason: string | null, installed: boolean | null = null): AntigravityQuotaVM {
  return { available: false, reason, groups: [], fetchedAt: Date.now(), installed }
}

/**
 * Turn one probe result into the card's view-model. Never throws: an
 * unparseable payload degrades to an unavailable VM so the card can say so
 * instead of rendering a half-filled frame.
 */
export function summarizeAntigravityQuota(raw: unknown): AntigravityQuotaVM {
  if (!isRecord(raw)) return emptyVM('bad-payload')
  const installed = readInstalled(raw.installed)
  if (raw.available !== true) {
    return emptyVM(
      typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : 'unavailable',
      installed,
    )
  }
  if (typeof raw.body !== 'string' || raw.body === '') return emptyVM('empty-body', installed)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.body)
  } catch {
    return emptyVM('bad-json', installed)
  }
  const rawGroups = extractGroups(parsed)
  if (rawGroups == null) return emptyVM('no-groups', installed)
  const groups = rawGroups.map(readGroup).filter((g): g is AntigravityGroupVM => g !== null)
  if (groups.length === 0) return emptyVM('no-buckets', installed)
  return { available: true, reason: null, groups, fetchedAt: Date.now(), installed }
}

/**
 * The service's response cut down to the fields the card reads, in the plain
 * `{ groups: […] }` shape — whichever envelope it arrived in.
 *
 * The main process returns and persists this instead of the raw response, so
 * whatever else the service wraps around the pools (an envelope of its own, or
 * a field a later version starts sending, such as an account identifier)
 * never reaches the renderer or `quota-cache.json` by accident. Null when
 * there is no group to keep; the caller then leaves the body as it was.
 *
 * A value is copied only with the type the summarizer reads it as, so
 * narrowing never changes what the card shows: a bucket that reads as 0%
 * before narrowing reads as 0% after.
 */
export function narrowAntigravityQuota(raw: unknown): { groups: unknown[] } | null {
  const groups = extractGroups(raw)
  if (groups == null) return null
  return {
    groups: groups.flatMap((group) => {
      if (!isRecord(group)) return []
      const buckets = Array.isArray(group.buckets) ? group.buckets : []
      return [
        {
          displayName: typeof group.displayName === 'string' ? group.displayName : '',
          buckets: buckets.flatMap((bucket) => {
            if (!isRecord(bucket)) return []
            const kept: Record<string, unknown> = {}
            for (const key of ['bucketId', 'window', 'resetTime', 'description']) {
              if (typeof bucket[key] === 'string') kept[key] = bucket[key]
            }
            if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
              kept.remainingFraction = bucket.remainingFraction
            }
            if (bucket.disabled === true) kept.disabled = true
            return [kept]
          }),
        },
      ]
    }),
  }
}

/**
 * How many grid tracks an Antigravity card takes. With two model groups it
 * lays them out side by side, which takes two tracks — but only while it is
 * the one Antigravity card on the page.
 *
 * The three clients share one allowance, so with two or three of them enabled
 * every card shows the same figures. As two-track cards in a three-column
 * grid, each one that does not fit the remaining columns drops to a row of its
 * own and leaves a column empty: the page is cut into identical bands with a
 * hole beside each. As single-track cards they sit side by side in one row
 * and leave no gap.
 */
export function antigravityCardSpan(shown: number, twoGroups: boolean): 1 | 2 {
  return shown === 1 && twoGroups ? 2 : 1
}
