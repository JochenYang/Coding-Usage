import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isTimeoutError } from './fetch-errors'

/**
 * Grok Build (SuperGrok) subscription quota probe, mirroring the
 * codex/claude/gemini contract: read the LOCAL login state, query the
 * official endpoint, return usage numbers only — the bearer token never
 * crosses the IPC boundary.
 *
 * Endpoint: REST `cli-chat-proxy.grok.com/v1/billing?format=credits`
 * (the path CodexBar/QuotaKit use as their primary web channel). The CLI's
 * JSON-RPC `x.ai/billing` method is unavailable on current grok builds
 * (-32601). The grok.com billing `ConsumerUiSvc` route IS read as a
 * best-effort enhancement below: it is gRPC-Web (`application/grpc-web+proto`)
 * over the same login's bearer key, and the response is a fixed pair of
 * message shapes (ai-usagebar's live capture) walked with a bounded wire-type
 * reader — no protobuf dependency exists to lean on, so the reader skips
 * everything it does not recognise and fails closed on anything malformed.
 *
 * The access token is short-lived and refreshed by `grok login`'s own
 * runtime; this module never attempts a refresh. 401/403 map to the card's
 * "please run grok login" state.
 */

export interface GrokOutcome {
  available: boolean
  body?: string
  reason?: string
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings'
/** Banked resets, gRPC-Web on the web app's own billing service */
const RESETS_URL = 'https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets'

interface GrokCreds {
  token: string
}

function num(v: unknown): number | null {
  // Amounts arrive either as numbers or {val: <cents>} envelopes
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object') {
    const val = (v as { val?: unknown }).val
    if (typeof val === 'number' && Number.isFinite(val)) return val
  }
  return null
}

function firstString(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== 'object') return null
  for (const key of keys) {
    const v = (source as Record<string, unknown>)[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/**
 * ~/.grok/auth.json (or $GROK_HOME): top-level keys are OIDC scope URLs and
 * values carry the bearer under `key`. Preference follows token-monitor's
 * ordering: SuperGrok OIDC scope → legacy sign-in scope → any keyed entry.
 */
export async function readGrokCredentials(homeDir: string): Promise<GrokCreds | null> {
  try {
    const base = process.env.GROK_HOME || join(homeDir, '.grok')
    const raw = await readFile(join(base, 'auth.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, { key?: unknown }>
    let fallback: GrokCreds | null = null
    let oidc: GrokCreds | null = null
    let legacy: GrokCreds | null = null
    for (const [scope, entry] of Object.entries(parsed ?? {})) {
      if (!entry || typeof entry.key !== 'string' || entry.key === '') continue
      const creds: GrokCreds = {
        token: entry.key,
      }
      if (scope.startsWith('https://auth.x.ai::')) oidc ??= creds
      else if (scope === 'https://accounts.x.ai/sign-in') legacy ??= creds
      else fallback ??= creds
    }
    return oidc ?? legacy ?? fallback
  } catch {
    return null
  }
}

async function grokGet(
  fetchImpl: FetchImpl,
  token: string,
  url: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-xai-token-auth': 'xai-grok-cli',
      Accept: 'application/json',
      'User-Agent': 'Grok Build',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

/** Percent used (0-100) with several known response shapes tolerated */
function extractPercent(billing: unknown): number | null {
  if (!billing || typeof billing !== 'object') return null
  const config = (billing as { config?: unknown }).config ?? billing
  const c = config as Record<string, unknown>
  const pct = num(c.creditUsagePercent) ?? num(c.credit_usage_percent)
  if (pct != null) return pct
  const usage = (c.usage ?? {}) as Record<string, unknown>
  const used = num(usage.onDemandUsed) ?? num(usage.includedUsed) ?? num(usage.totalUsed)
  const cap = num(c.onDemandCap) ?? num(c.monthlyLimit)
  if (used != null && cap != null && cap > 0) return (used / cap) * 100
  return null
}

function extractResetsAt(billing: unknown): number | null {
  if (!billing || typeof billing !== 'object') return null
  const config = (billing as { config?: unknown }).config ?? billing
  const c = config as Record<string, unknown>
  const period = (c.currentPeriod ?? {}) as Record<string, unknown>
  const raw = firstString(period, ['end']) ?? firstString(c, ['billingPeriodEnd', 'billingPeriodEndAt'])
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

// ===== Banked resets (enhancement, gRPC-Web) =====

export interface GrokBankedResets {
  /** Number of banked reset tokens the response carries */
  count: number
  /** Earliest validity_end across the tokens, epoch ms; null when none reports one */
  expiresAt: number | null
}

/**
 * `ConsumerGetRemainingResetsResp { repeated ConsumerResetToken tokens = 10 }`
 * where a token carries `token_id = 10`, `validity_start = 20` and
 * `validity_end = 30` (a well-known `Timestamp` whose seconds are field 1).
 * Field numbers follow ai-usagebar's live capture of the endpoint; everything
 * else is skipped by wire type so an added field cannot break the read.
 */
const FIELD_TOKENS = 10
const FIELD_VALIDITY_END = 30
/** A plausible epoch-second expiry (mirrors the family's reset bounds) */
const RESET_SECONDS_MAX = 4_200_000_000
/** Same body bound the family applies to vendor responses */
const GRPC_WEB_MAX_BYTES = 2 * 1024 * 1024

/** A bounded protobuf varint; `value` may exceed 32 bits, so no shifts */
function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  for (let index = 0; index < 10; index += 1) {
    if (offset + index >= bytes.length) return null
    const byte = bytes[offset + index]
    if (shift === 63 && byte > 1) return null
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 }
    shift += 7
  }
  return null
}

/** Skip one field by wire type; returns the offset past it, null when malformed */
function skipField(bytes: Uint8Array, offset: number, wireType: number): number | null {
  switch (wireType) {
    case 0: {
      const value = readVarint(bytes, offset)
      return value?.next ?? null
    }
    case 1:
      return offset + 8 <= bytes.length ? offset + 8 : null
    case 2: {
      const length = readVarint(bytes, offset)
      if (!length) return null
      const end = length.next + length.value
      return end <= bytes.length ? end : null
    }
    case 5:
      return offset + 4 <= bytes.length ? offset + 4 : null
    default:
      return null
  }
}

/** Read a length-delimited payload as a subarray; null when malformed */
function delimited(bytes: Uint8Array, offset: number): { payload: Uint8Array; next: number } | null {
  const length = readVarint(bytes, offset)
  if (!length) return null
  const end = length.next + length.value
  if (end > bytes.length) return null
  return { payload: bytes.subarray(length.next, end), next: end }
}

/**
 * One ConsumerResetToken. `token_id` (field 10) is the handle that SPENDS a
 * reset — it is skipped during parsing rather than parsed and dropped, so it
 * can never reach the quota snapshot, a card or an error message. `malformed`
 * fails the whole read; a token without a usable `validity_end` is still
 * counted, just without contributing an expiry.
 */
function resetTokenExpiryMs(bytes: Uint8Array): { malformed: boolean; expiresAtMs: number | null } {
  let offset = 0
  let expiresAtMs: number | null = null
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset)
    if (!key) return { malformed: true, expiresAtMs: null }
    if (key.value === ((FIELD_VALIDITY_END << 3) | 2)) {
      const timestamp = delimited(bytes, key.next)
      if (!timestamp) return { malformed: true, expiresAtMs: null }
      // Walk the Timestamp submessage: seconds = field 1 (varint).
      let inner = 0
      let seconds: number | null = null
      while (inner < timestamp.payload.length) {
        const innerKey = readVarint(timestamp.payload, inner)
        if (!innerKey) return { malformed: true, expiresAtMs: null }
        if (innerKey.value === 1 << 3) {
          const value = readVarint(timestamp.payload, innerKey.next)
          if (!value) return { malformed: true, expiresAtMs: null }
          seconds = value.value
          inner = value.next
        } else {
          const next = skipField(timestamp.payload, innerKey.next, innerKey.value & 7)
          if (next == null) return { malformed: true, expiresAtMs: null }
          inner = next
        }
      }
      // An implausible stamp does not fail the read: the token still counts,
      // it just does not contribute an expiry.
      if (seconds != null && seconds > 0 && seconds <= RESET_SECONDS_MAX) expiresAtMs = seconds * 1000
      offset = timestamp.next
    } else {
      const next = skipField(bytes, key.next, key.value & 7)
      if (next == null) return { malformed: true, expiresAtMs: null }
      offset = next
    }
  }
  return { malformed: false, expiresAtMs }
}

/** One response message: count the tokens, keep the earliest expiry */
function parseResetResponse(bytes: Uint8Array): { count: number; expiresAt: number | null } | null {
  let offset = 0
  let count = 0
  let expiresAt: number | null = null
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset)
    if (!key) return null
    if (key.value === ((FIELD_TOKENS << 3) | 2)) {
      const token = delimited(bytes, key.next)
      if (!token) return null
      const expiry = resetTokenExpiryMs(token.payload)
      if (expiry.malformed) return null
      count += 1
      if (expiry.expiresAtMs != null && (expiresAt == null || expiry.expiresAtMs < expiresAt)) {
        expiresAt = expiry.expiresAtMs
      }
      offset = token.next
    } else {
      const next = skipField(bytes, key.next, key.value & 7)
      if (next == null) return null
      offset = next
    }
  }
  return { count, expiresAt }
}

/**
 * Walk the gRPC-Web frames. Failure is reported at the gRPC level in a
 * trailer BEHIND an HTTP 200, so the trailer's `grpc-status` is checked
 * before any count is believed — reading only the data frames would turn a
 * rejected call into an authoritative "0 resets".
 */
export function parseGrokResetCredits(bytes: Uint8Array): GrokBankedResets | null {
  if (bytes.length === 0 || bytes.length > GRPC_WEB_MAX_BYTES) return null
  let offset = 0
  let count = 0
  let expiresAt: number | null = null
  let sawDataFrame = false
  while (offset < bytes.length) {
    if (bytes.length - offset < 5) return null
    const flags = bytes[offset]
    const length = (bytes[offset + 1] << 24 | bytes[offset + 2] << 16 | bytes[offset + 3] << 8 | bytes[offset + 4]) >>> 0
    offset += 5
    const end = offset + length
    if (end > bytes.length) return null
    if (flags & 0x80) {
      // The trailer is HTTP-header text, not protobuf. A missing grpc-status
      // is success by the spec's own default; anything else is a failed call.
      const trailer = Buffer.from(bytes.subarray(offset, end)).toString('utf8')
      for (const line of trailer.split(/[\r\n]+/)) {
        const separator = line.indexOf(':')
        if (separator < 0) continue
        if (line.slice(0, separator).trim().toLowerCase() === 'grpc-status' && line.slice(separator + 1).trim() !== '0') {
          return null
        }
      }
    } else if (flags === 0) {
      const parsed = parseResetResponse(bytes.subarray(offset, end))
      if (!parsed) return null
      sawDataFrame = true
      count += parsed.count
      if (parsed.expiresAt != null && (expiresAt == null || parsed.expiresAt < expiresAt)) {
        expiresAt = parsed.expiresAt
      }
    } else {
      return null
    }
    offset = end
  }
  return sawDataFrame ? { count, expiresAt } : null
}

/**
 * The banked-reset read: an empty gRPC-Web request frame with the login's own
 * bearer key, decoded as a bounded enhancement. Any non-ok status, malformed
 * frame or transport failure is null — the billing numbers stand alone.
 */
async function fetchGrokBankedResets(fetchImpl: FetchImpl, token: string): Promise<GrokBankedResets | null> {
  try {
    const res = await fetchImpl(RESETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/grpc-web+proto',
        'x-grpc-web': '1',
        Origin: 'https://grok.com',
      },
      body: new Uint8Array([0, 0, 0, 0, 0]),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return parseGrokResetCredits(new Uint8Array(await res.arrayBuffer()))
  } catch {
    return null
  }
}

/**
 * Grok subscription usage via the local Grok Build login. The returned body
 * is a normalized JSON payload ({percent, resetsAt, plan}, plus the
 * {remainingResets, resetsExpireAt} enhancement when the banked-reset read
 * succeeds) — parsing and credential handling stay on this side of the IPC,
 * and no account identifier (such as the login email) is persisted.
 */
export async function fetchGrokUsage(fetchImpl: FetchImpl, homeDir: string): Promise<GrokOutcome> {
  try {
    const creds = await readGrokCredentials(homeDir)
    if (!creds) return { available: false, reason: 'no-auth-file' }

    // Enhancement reads (plan garnish, banked resets) start concurrently with
    // the billing read: none of them can change the outcome, so none of them
    // may extend the card's watchdog-critical latency — three serial 10s reads
    // would blow past it, while Codex/Cursor already run theirs concurrently.
    const billingPromise = grokGet(fetchImpl, creds.token, BILLING_URL)
    const planPromise = grokGet(fetchImpl, creds.token, SETTINGS_URL).then(
      (settings) =>
        settings.status >= 200 && settings.status < 300
          ? firstString(settings.json, ['subscription_tier_display', 'subscriptionTierDisplay'])
          : null,
      () => null,
    )
    const bankedPromise = fetchGrokBankedResets(fetchImpl, creds.token)

    const billing = await billingPromise
    if (billing.status === 401 || billing.status === 403) {
      return { available: false, reason: `http-${billing.status}` }
    }
    if (billing.status >= 400 || !billing.json) {
      return { available: false, reason: `http-${billing.status}` }
    }
    const percent = extractPercent(billing.json)
    if (percent == null) return { available: false, reason: 'malformed-body' }
    const resetsAt = extractResetsAt(billing.json)

    const [plan, banked] = await Promise.all([planPromise, bankedPromise])
    const body: Record<string, unknown> = {
      percent: Math.min(100, Math.max(0, percent)),
      resetsAt,
      plan,
    }
    if (banked) {
      body.remainingResets = banked.count
      if (banked.expiresAt != null) body.resetsExpireAt = banked.expiresAt
    }
    return { available: true, body: JSON.stringify(body) }
  } catch (error) {
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}
