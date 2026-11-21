import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { QuotaOutcome } from './subscription-quotas'
import { isTimeoutError } from './fetch-errors'

/**
 * Kiro plan credits from the CLI's own state database.
 *
 * The CLI owns the token and its refresh. This probe opens the database
 * read-only and calls GetUsageLimits. It never starts `kiro-cli chat`, which
 * can save an empty session. A missing profile row may use the US East
 * endpoint; a present but unsupported profile is not redirected there.
 *
 * Windows install locations were not present on the machine this was written
 * against, so `%APPDATA%` and `%LOCALAPPDATA%` are candidates beside the
 * documented macOS and XDG paths. A miss stays unavailable.
 */

const TARGET = 'AmazonCodeWhispererService.GetUsageLimits'
const ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://codewhisperer.us-east-1.amazonaws.com/',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com/',
}
const RESET_MIN = 1_000_000_000
const RESET_MAX = 4_102_444_800

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export function kiroDbCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const expand = (value: string): string => {
    if (value === '~') return home
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
    return value
  }
  const paths: string[] = []
  const override = env.KIRO_DATA_DIR?.trim()
  if (override) paths.push(join(expand(override), 'data.sqlite3'))
  if (env.APPDATA) paths.push(join(env.APPDATA, 'kiro-cli', 'data.sqlite3'))
  if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, 'kiro-cli', 'data.sqlite3'))
  paths.push(join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'))
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg) paths.push(join(expand(xdg), 'kiro-cli', 'data.sqlite3'))
  paths.push(join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3'))
  return paths
}

function cellText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8').replace(/\0+$/, '').trim()
    return text || null
  }
  return null
}

function readIdentity(path: string): { token: string | null; profileArn: string | null; profilePresent: boolean } {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const tokenRow = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:token') as
      | { value?: unknown }
      | undefined
    const profileRow = db.prepare('SELECT value FROM state WHERE key = ?').get('api.codewhisperer.profile') as
      | { value?: unknown }
      | undefined
    const tokenJson = cellText(tokenRow?.value)
    let token: string | null = null
    if (tokenJson) {
      const parsed = JSON.parse(tokenJson) as { access_token?: unknown }
      token = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : null
    }
    if (!profileRow) return { token, profileArn: null, profilePresent: false }
    const profileJson = cellText(profileRow.value)
    const arn = profileJson ? (JSON.parse(profileJson) as { arn?: unknown }).arn : null
    return {
      token,
      profileArn: typeof arn === 'string' && arn.trim() !== '' ? arn.trim() : null,
      profilePresent: true,
    }
  } catch {
    return { token: null, profileArn: null, profilePresent: false }
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
}

/** Region from a CodeWhisperer profile ARN. Unsupported ARNs fail closed. */
export function kiroEndpoint(profileArn: string | null): string | null {
  if (!profileArn) return ENDPOINTS['us-east-1']
  if (/[\s\u0000-\u001f]/.test(profileArn)) return null
  const parts = profileArn.split(':')
  if (parts.length !== 6 || parts[0] !== 'arn' || parts[1] !== 'aws' || parts[2] !== 'codewhisperer') return null
  if (!parts[5].startsWith('profile/') || parts[5].length <= 'profile/'.length) return null
  return ENDPOINTS[parts[3]] ?? null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** One monthly credit window. Missing or contradictory numbers stay unavailable. */
export function windowFromKiroLimits(payload: unknown): { percent: number; resetsAt: number } | null {
  if (!payload || typeof payload !== 'object') return null
  const list = (payload as { usageBreakdownList?: unknown }).usageBreakdownList
  if (!Array.isArray(list)) return null
  const credits = list.filter(
    (item) => item && typeof item === 'object' && (item as { resourceType?: unknown }).resourceType === 'CREDIT',
  )
  if (credits.length !== 1) return null
  const credit = credits[0] as {
    usageLimitWithPrecision?: unknown
    currentUsageWithPrecision?: unknown
    currentOveragesWithPrecision?: unknown
    nextDateReset?: unknown
    bonuses?: unknown
  }
  const limit = finite(credit.usageLimitWithPrecision)
  const totalUsed = finite(credit.currentUsageWithPrecision)
  const overage = finite(credit.currentOveragesWithPrecision) ?? 0
  if (limit == null || limit <= 0 || totalUsed == null || totalUsed < 0 || overage < 0 || totalUsed < overage) return null
  const planUsed = totalUsed - overage
  const bonuses = Array.isArray(credit.bonuses) ? credit.bonuses : []
  if (bonuses.length === 0 && planUsed > limit) return null
  const reset = finite(credit.nextDateReset) ?? finite((payload as { nextDateReset?: unknown }).nextDateReset)
  if (reset == null || reset < RESET_MIN || reset > RESET_MAX) return null
  return { percent: Math.max(0, Math.min(100, (planUsed / limit) * 100)), resetsAt: reset * 1000 }
}

export async function fetchKiroQuota(
  fetchImpl: FetchImpl,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<QuotaOutcome> {
  const path = kiroDbCandidates(home, env).find((candidate) => existsSync(candidate))
  if (!path) return { available: false, reason: 'no-auth' }
  const identity = readIdentity(path)
  if (!identity.token || /[\r\n]/.test(identity.token)) return { available: false, reason: 'no-auth' }
  if (identity.profilePresent && !identity.profileArn) return { available: false, reason: 'parse-failed' }
  const endpoint = kiroEndpoint(identity.profileArn)
  if (!endpoint) return { available: false, reason: 'parse-failed' }
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': TARGET,
        Accept: 'application/json',
      },
      body: JSON.stringify(identity.profileArn ? { profileArn: identity.profileArn } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) return { available: false, reason: 'reauth' }
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    const window = windowFromKiroLimits(JSON.parse(await res.text()))
    if (!window) return { available: false, reason: 'parse-failed' }
    return {
      available: true,
      body: JSON.stringify({
        plan: 'Kiro',
        windows: [{ id: 'kiroMonthly', percent: window.percent, resetsAt: window.resetsAt }],
        topUpCredits: null,
        stale: false,
      }),
    }
  } catch (error) {
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}
