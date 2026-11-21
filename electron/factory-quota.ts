import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QuotaOutcome } from './subscription-quotas'
import { isTimeoutError } from './fetch-errors'

/**
 * Factory (Droid) subscription quota.
 *
 * The probe reads a Factory API key the user already holds (`FACTORY_API_KEY`
 * or the droid CLI's own `~/.factory/.env`) and asks the official billing
 * endpoints directly. The droid CLI's OAuth login is not read: on Windows the
 * CLI seals its session into `~/.factory/auth.v2.keyring` with an AES key kept
 * in Windows Credential Manager, a store this process cannot read without a
 * native module, so the API-key path is the supported surface and a missing
 * key is the honest unavailable state.
 *
 * Response shapes are undocumented and taken from third-party captures of the
 * droid CLI and web app (CodexBar's live wire types), so every field is read
 * by name and anything missing or contradictory degrades the window — a bad
 * payload never becomes 0%.
 */

const BILLING_LIMITS_URL = 'https://api.factory.ai/api/billing/limits'
const LEGACY_USAGE_URL = 'https://api.factory.ai/api/organization/subscription/usage?useCache=true'
const AUTH_ME_URL = 'https://api.factory.ai/api/app/auth/me'
const PLAN_MAX_LENGTH = 80

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface FactoryWindow {
  id:
    | 'factoryFiveHour'
    | 'factoryWeekly'
    | 'factoryMonthly'
    | 'factoryCoreFiveHour'
    | 'factoryCoreWeekly'
    | 'factoryCoreMonthly'
    | 'factoryStandard'
    | 'factoryPremium'
  percent: number
  resetsAt: number | null
}

function objOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/**
 * Bearer credential: the environment variable first, then the CLI's own
 * `.env` file. Only `FACTORY_API_KEY=…` / `export FACTORY_API_KEY=…` lines are
 * read; anything else in the file is ignored, and the value never leaves this
 * module's return path.
 */
export function apiKeyFromDotEnv(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const match = /^export\s+FACTORY_API_KEY\s*=\s*(.+)$|^FACTORY_API_KEY\s*=\s*(.+)$/.exec(line.trim())
    const value = (match?.[1] ?? match?.[2])?.trim()
    if (!value) continue
    const unquoted = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim()
    if (unquoted === '' || /[\r\n\u0000-\u001f]/.test(unquoted)) continue
    return unquoted
  }
  return null
}

/**
 * `windowEnd` arrives as seconds, milliseconds (> 1e12) or an ISO/numeric
 * string depending on the client version; `secondsRemaining` is preferred for
 * the reset when the server supplies it.
 */
function windowEndMs(value: unknown): number | null {
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return windowEndMs(numeric)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * One billing window. A window that ended (a past `windowEnd` with no
 * `secondsRemaining`) is stale server-side and reads as 0%, mirroring the web
 * UI; a window that never started keeps its percentage with no reset.
 */
export function windowFromBilling(raw: unknown, now: number): { percent: number; resetsAt: number | null } | null {
  const window = objOf(raw)
  if (!window) return null
  const usedPercent = finite(window.usedPercent)
  if (usedPercent == null) return null
  const end = windowEndMs(window.windowEnd)
  const secondsRemaining = finite(window.secondsRemaining)
  let resetsAt: number | null = null
  if (secondsRemaining != null && secondsRemaining > 0) {
    resetsAt = now + secondsRemaining * 1000
  } else if (end != null && end > now) {
    resetsAt = end
  }
  const percent = resetsAt == null && end != null ? 0 : clampPercent(usedPercent)
  return { percent, resetsAt }
}

function poolWindows(pool: unknown, now: number, ids: [FactoryWindow['id'], FactoryWindow['id'], FactoryWindow['id']]): FactoryWindow[] {
  const obj = objOf(pool)
  if (!obj) return []
  const out: FactoryWindow[] = []
  const keys = ['fiveHour', 'weekly', 'monthly'] as const
  for (let index = 0; index < keys.length; index += 1) {
    const parsed = windowFromBilling(obj[keys[index]], now)
    if (!parsed) continue
    out.push({ id: ids[index], percent: parsed.percent, resetsAt: parsed.resetsAt })
  }
  return out
}

/** The Droid Core pool only reports when the account has usage in it. */
function coreHasUsage(core: Record<string, unknown>): boolean {
  for (const key of ['fiveHour', 'weekly', 'monthly'] as const) {
    const window = objOf(core[key])
    if (!window) continue
    if ((finite(window.usedPercent) ?? 0) > 0) return true
    if (window.windowEnd != null || finite(window.secondsRemaining) != null) return true
  }
  return false
}

const STANDARD_IDS: [FactoryWindow['id'], FactoryWindow['id'], FactoryWindow['id']] = [
  'factoryFiveHour',
  'factoryWeekly',
  'factoryMonthly',
]
const CORE_IDS: [FactoryWindow['id'], FactoryWindow['id'], FactoryWindow['id']] = [
  'factoryCoreFiveHour',
  'factoryCoreWeekly',
  'factoryCoreMonthly',
]

export function windowsFromBillingLimits(payload: unknown, now: number): { windows: FactoryWindow[]; topUpCredits: number | null } | null {
  const root = objOf(payload)
  if (!root || root.usesTokenRateLimitsBilling !== true) return null
  const limits = objOf(root.limits)
  const standard = objOf(limits?.standard)
  if (!limits || !standard) return null
  const windows = poolWindows(standard, now, STANDARD_IDS)
  const core = objOf(limits.core)
  if (core && coreHasUsage(core)) windows.push(...poolWindows(core, now, CORE_IDS))
  const balanceCents = finite(root.extraUsageBalanceCents)
  const topUpCredits = balanceCents != null && balanceCents >= 0 ? balanceCents / 100 : null
  return { windows, topUpCredits }
}

/**
 * Legacy Standard/Premium accounts answer `/api/organization/subscription/usage`
 * with token counts against an allowance. `usedRatio` (0..1) wins when present;
 * counts are only trusted when the allowance is positive.
 */
export function windowsFromLegacyUsage(payload: unknown, now: number): FactoryWindow[] | null {
  const root = objOf(payload)
  const usage = objOf(root?.usage)
  if (!usage) return null
  const windows: FactoryWindow[] = []
  const pools: Array<{ key: 'standard' | 'premium'; id: FactoryWindow['id'] }> = [
    { key: 'standard', id: 'factoryStandard' },
    { key: 'premium', id: 'factoryPremium' },
  ]
  for (const pool of pools) {
    const tokenUsage = objOf(usage[pool.key])
    if (!tokenUsage) continue
    const ratio = finite(tokenUsage.usedRatio)
    let percent: number | null = null
    if (ratio != null && ratio >= 0 && ratio <= 1) {
      percent = clampPercent(ratio * 100)
    } else {
      const used = finite(tokenUsage.userTokens)
      const allowance = finite(tokenUsage.totalAllowance)
      if (used != null && used >= 0 && allowance != null && allowance > 0) {
        percent = clampPercent((used / allowance) * 100)
      }
    }
    if (percent == null) continue
    // endDate follows the same dual-unit convention as the billing windows'
    // windowEnd: seconds, or milliseconds once the value is beyond 1e12.
    const end = windowEndMs(usage.endDate)
    const resetsAt = end != null && end > now ? end : null
    windows.push({ id: pool.id, percent, resetsAt })
  }
  return windows.length > 0 ? windows : null
}

/** Plan label from `/api/app/auth/me`; a missing plan never fails the quota read. */
export function planFromAuthPayload(payload: unknown): string | null {
  const root = objOf(payload)
  const organization = objOf(root?.organization)
  const subscription = objOf(organization?.subscription)
  const orb = objOf(subscription?.orbSubscription)
  const plan = objOf(orb?.plan)
  const name = typeof plan?.name === 'string' ? plan.name.trim() : ''
  if (name !== '') return name.slice(0, PLAN_MAX_LENGTH)
  const tier = typeof subscription?.factoryTier === 'string' ? subscription.factoryTier.trim() : ''
  if (tier !== '') return tier.slice(0, PLAN_MAX_LENGTH)
  return null
}

async function getJson(fetchImpl: FetchImpl, url: string, apiKey: string): Promise<{ ok: true; json: unknown } | { ok: false; status: number } | { ok: false; unparsable: true }> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'x-factory-client': 'web-app',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status }
  if (!res.ok) return { ok: false, status: res.status }
  try {
    return { ok: true, json: JSON.parse(await res.text()) }
  } catch {
    return { ok: false, unparsable: true }
  }
}

export async function fetchFactoryQuota(
  fetchImpl: FetchImpl,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<QuotaOutcome> {
  let apiKey = typeof env.FACTORY_API_KEY === 'string' ? env.FACTORY_API_KEY.trim() : ''
  if (apiKey === '' || /[\r\n\u0000-\u001f]/.test(apiKey)) {
    apiKey = ''
    const envFile = join(home, '.factory', '.env')
    try {
      apiKey = apiKeyFromDotEnv(await readFile(envFile, 'utf8')) ?? ''
    } catch {
      // No `.env` file: only the environment variable could have carried a key.
    }
  }
  if (apiKey === '') return { available: false, reason: 'no-auth' }

  const now = Date.now()
  try {
    let windows: FactoryWindow[] = []
    let topUpCredits: number | null = null
    const limits = await getJson(fetchImpl, BILLING_LIMITS_URL, apiKey)
    let tryLegacy = false
    if (limits.ok) {
      const fromLimits = windowsFromBillingLimits(limits.json, now)
      if (fromLimits) {
        windows = fromLimits.windows
        topUpCredits = fromLimits.topUpCredits
      } else {
        tryLegacy = true
      }
    } else if ('status' in limits && (limits.status === 401 || limits.status === 403)) {
      return { available: false, reason: 'reauth' }
    } else {
      // Legacy Standard/Premium accounts may not serve /billing/limits at all
      // (any 4xx/5xx with no token-rate-limits shape), and a 200 that answers
      // with an HTML challenge page parses as no-status — both get the legacy
      // token pools before giving up. 401/403 already returned above — a bad
      // key must not masquerade as a legacy account.
      tryLegacy = true
    }
    if (tryLegacy) {
      // The legacy read failing is its own honest state.
      const legacy = await getJson(fetchImpl, LEGACY_USAGE_URL, apiKey)
      if (!legacy.ok) {
        if ('status' in legacy) return { available: false, reason: `http-${legacy.status}` }
        return { available: false, reason: 'bad-response' }
      }
      const legacyWindows = windowsFromLegacyUsage(legacy.json, now)
      if (!legacyWindows) return { available: false, reason: 'parse-failed' }
      windows = legacyWindows
    }
    if (windows.length === 0) return { available: false, reason: 'parse-failed' }

    let plan: string | null = null
    try {
      const auth = await getJson(fetchImpl, AUTH_ME_URL, apiKey)
      if (auth.ok) plan = planFromAuthPayload(auth.json)
    } catch {
      // The plan label is garnish; the windows stand on their own.
    }
    return { available: true, body: JSON.stringify({ plan, windows, topUpCredits, stale: false }) }
  } catch (error) {
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}
