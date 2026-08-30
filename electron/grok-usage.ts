import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Grok Build (SuperGrok) subscription quota probe, mirroring the
 * codex/claude/gemini contract: read the LOCAL login state, query the
 * official endpoint, return usage numbers only — the bearer token never
 * crosses the IPC boundary.
 *
 * Endpoint: REST `cli-chat-proxy.grok.com/v1/billing?format=credits`
 * (the path CodexBar/QuotaKit use as their primary web channel). The CLI's
 * JSON-RPC `x.ai/billing` method is unavailable on current grok builds
 * (-32601) and the grok.com gRPC-web route needs heuristically parsed
 * protobuf plus browser-held WKE keys — both intentionally skipped.
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

interface GrokCreds {
  token: string
  email: string | null
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
    const parsed = JSON.parse(raw) as Record<string, { key?: unknown; email?: unknown }>
    let fallback: GrokCreds | null = null
    let oidc: GrokCreds | null = null
    let legacy: GrokCreds | null = null
    for (const [scope, entry] of Object.entries(parsed ?? {})) {
      if (!entry || typeof entry.key !== 'string' || entry.key === '') continue
      const creds: GrokCreds = {
        token: entry.key,
        email: typeof entry.email === 'string' ? entry.email : null,
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

/**
 * Grok subscription usage via the local Grok Build login. The returned body
 * is a normalized JSON payload ({percent, resetsAt, plan, email}) — parsing
 * and credential handling stay on this side of the IPC.
 */
export async function fetchGrokUsage(fetchImpl: FetchImpl, homeDir: string): Promise<GrokOutcome> {
  try {
    const creds = await readGrokCredentials(homeDir)
    if (!creds) return { available: false, reason: 'no-auth-file' }

    const billing = await grokGet(fetchImpl, creds.token, BILLING_URL)
    if (billing.status === 401 || billing.status === 403) {
      return { available: false, reason: `http-${billing.status}` }
    }
    if (billing.status >= 400 || !billing.json) {
      return { available: false, reason: `http-${billing.status}` }
    }
    const percent = extractPercent(billing.json)
    if (percent == null) return { available: false, reason: 'malformed-body' }
    const resetsAt = extractResetsAt(billing.json)

    // Plan name is display garnish — a failure here must not kill the card
    let plan: string | null = null
    try {
      const settings = await grokGet(fetchImpl, creds.token, SETTINGS_URL)
      if (settings.status >= 200 && settings.status < 300) {
        plan = firstString(settings.json, ['subscription_tier_display', 'subscriptionTierDisplay'])
      }
    } catch {
      plan = null
    }

    return {
      available: true,
      body: JSON.stringify({
        percent: Math.min(100, Math.max(0, percent)),
        resetsAt,
        plan,
        email: creds.email,
      }),
    }
  } catch {
    return { available: false, reason: 'probe-failed' }
  }
}
