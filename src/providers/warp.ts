import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * Warp AI usage via the user's own API key (docs.warp.dev → Settings →
 * Platform → API Keys, `wk-…`).
 *
 * WARNING surfaced in both the providers page and the card copy: this key is
 * NOT read-only — the same credential can start billed agent runs — so the
 * copy tells the user to paste a dedicated short-lived key, never their main
 * account key.
 *
 * Endpoint (undocumented GraphQL, request shape per CodexBar's WarpUsageFetcher):
 * POST https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo with the query in
 * a JSON body. The endpoint is POST-only — a GET is answered by the web SPA —
 * so the request is issued inside parseResponse through the bridge's optional
 * POST override (see ParseContext.fetch); `skipPreflight` skips the GET
 * preflight that every other adapter runs.
 *
 * Warp's edge rejects requests carrying a browser Origin (a renderer dev-page
 * origin would be one), so the adapter declares the app's own origin the same
 * way the Cursor adapter declares cursor.com. Under Electron the header rides
 * the main-process request verbatim; in browser dev the fetch spec forbids
 * overriding Origin, so that path can fail — the same desktop-only shape the
 * Cursor adapter accepts.
 */

const GRAPHQL_URL = 'https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo'
/** The edge limiter answers 429 unless the UA matches the official client pattern */
const WARP_UA = 'Warp/1.0'
/** A hostile payload must not turn the bonus sum into an unbounded scan */
const GRANTS_CAP = 64

/** Field names resolved by name only — the GraphQL schema is undocumented (E12) */
interface WarpLimitInfo {
  isUnlimited?: unknown
  nextRefreshTime?: unknown
  requestLimit?: unknown
  requestsUsedSinceLastRefresh?: unknown
}

interface WarpGrant {
  requestCreditsGranted?: unknown
  requestCreditsRemaining?: unknown
  expiration?: unknown
}

const GRAPHQL_QUERY = `query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) {
    __typename
    ... on UserOutput {
      user {
        requestLimitInfo {
          isUnlimited
          nextRefreshTime
          requestLimit
          requestsUsedSinceLastRefresh
        }
        bonusGrants {
          requestCreditsGranted
          requestCreditsRemaining
          expiration
        }
        workspaces {
          bonusGrantsInfo {
            grants {
              requestCreditsGranted
              requestCreditsRemaining
              expiration
            }
          }
        }
      }
    }
  }
}`

function objOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A whole-number count; proto-style payloads may send integers as strings */
function intOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** Epoch ms from an epoch number or an ISO stamp; null otherwise */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim() !== '' && !/^\s*\d+(\.\d+)?\s*$/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? (parsed < 1e12 ? parsed * 1000 : parsed) : null
  }
  return null
}

/** Sum the bonus grants (user-level + workspace-level) into one pool */
function bonusPool(
  grants: WarpGrant[],
): { granted: number; remaining: number; expiresAt: number | null } {
  let granted = 0
  let remaining = 0
  let expiresAt: number | null = null
  for (const grant of grants.slice(0, GRANTS_CAP)) {
    const size = intOf(grant.requestCreditsGranted)
    const left = intOf(grant.requestCreditsRemaining)
    if (size == null || size < 0 || left == null || left < 0 || left > size) continue
    granted += size
    remaining += left
    if (left > 0) {
      const expiry = toEpochMs(grant.expiration)
      if (expiry != null && (expiresAt == null || expiry < expiresAt)) expiresAt = expiry
    }
  }
  return { granted, remaining, expiresAt }
}

export const warp: ProviderDef = {
  id: 'warp',
  name: 'Warp',
  // No brand mark ships in @lobehub/icons; the letter fallback renders instead
  accent: 'from-neutral-500 to-neutral-700',
  tagline: (t) => t.providers.warp.tagline,
  docsUrl: 'https://docs.warp.dev/reference/cli/api-keys',
  keyUrl: 'https://docs.warp.dev/reference/cli/api-keys',
  // The POST request runs inside parseResponse via the bridge's POST override;
  // the GET preflight cannot carry the GraphQL body.
  skipPreflight: true,
  buildRequest() {
    return { url: GRAPHQL_URL, headers: {} }
  },
  async parseResponse(_json, ctx) {
    const fetchFn = ctx?.fetch
    const key = (ctx?.key ?? '').trim()
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const errs = t.providerErrors
    if (!fetchFn) return []
    if (!key) throw new Error(errs.keyInvalid)

    const variables = {
      requestContext: {
        clientContext: {},
        osContext: { category: 'windows', name: 'windows', version: '10.0' },
      },
    }

    let res: Response
    try {
      res = await fetchFn(
        GRAPHQL_URL,
        {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-warp-client-id': 'warp-app',
          'x-warp-os-category': 'windows',
          'x-warp-os-name': 'windows',
          'x-warp-os-version': '10.0',
          'User-Agent': WARP_UA,
          // Declared on purpose: a browser Origin is what the edge rejects
          // (see the module comment); the app's own origin is the identity a
          // legitimate client carries.
          Origin: 'https://app.warp.dev',
        },
        { method: 'POST', body: JSON.stringify({ query: GRAPHQL_QUERY, variables, operationName: 'GetRequestLimitInfo' }) },
      )
    } catch {
      throw new Error(errs.networkFailed)
    }
    if (res.status === 401 || res.status === 403) throw new Error(errs.keyInvalid)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const json = objOf(await res.json().catch(() => null))
    if (!json) throw new Error(errs.badResponse)
    // GraphQL-level failures ride HTTP 200: fail on the server's own message
    // rather than inventing a quota reading from an error payload.
    const errors = Array.isArray(json.errors) ? json.errors : []
    if (errors.length > 0) {
      const message = objOf(errors[0])?.['message']
      throw new Error(typeof message === 'string' && message !== '' ? message : errs.queryFailed)
    }
    const data = objOf(json.data)
    const user = objOf(data?.['user'])
    // The user field is a union: an error branch reports its own __typename
    // and carries no numbers.
    if (user?.['__typename'] !== 'UserOutput') throw new Error(errs.queryFailed)
    const inner = objOf(user['user'])
    const limitInfo = objOf(inner?.['requestLimitInfo']) as WarpLimitInfo | null
    if (!limitInfo) throw new Error(errs.badResponse)

    const metrics: UsageMetric[] = []
    const unlimited = limitInfo.isUnlimited === true
    const limit = intOf(limitInfo.requestLimit)
    const used = intOf(limitInfo.requestsUsedSinceLastRefresh)
    const resetsAt = toEpochMs(limitInfo.nextRefreshTime) ?? undefined
    if (unlimited) {
      // An unlimited plan still gets its row: 0% keeps the bar present
      // without claiming a consumed allowance (same rule as the Cursor card).
      metrics.push({ id: 'warp-requests', label: t.windows.warpMonthlyRequests, kind: 'percent', percent: 0 })
    } else if (limit != null && limit > 0 && used != null && used >= 0) {
      metrics.push({
        id: 'warp-requests',
        label: t.windows.warpMonthlyRequests,
        kind: 'percent',
        percent: Math.min(100, Math.max(0, (used / limit) * 100)),
        used,
        total: limit,
        resetsAt,
      })
    }

    // Add-on credits: the user-level and workspace-level grant pools combined
    // (Warp consumes monthly requests first, then add-on credits — the pools
    // are shown side by side, never merged into one percentage).
    const grantsRaw = inner?.['bonusGrants']
    const userGrants = Array.isArray(grantsRaw) ? (grantsRaw as WarpGrant[]) : []
    const workspaces = objOf(inner?.['workspaces'])
    const bonusGrantsInfo = objOf(workspaces?.['bonusGrantsInfo'])
    const workspaceGrants = Array.isArray(bonusGrantsInfo?.['grants'])
      ? (bonusGrantsInfo['grants'] as WarpGrant[])
      : []
    const pool = bonusPool([...userGrants, ...workspaceGrants])
    if (pool.granted > 0 || pool.remaining > 0) {
      // granted === 0 with remaining > 0 cannot happen: bonusPool filters
      // grants whose remaining exceeds their size, so the only reachable
      // non-positive-granted case is granted === remaining === 0 — filtered by
      // the guard above. No `: 100` fallback branch for it.
      const percent = Math.min(
        100,
        Math.max(0, ((pool.granted - pool.remaining) / Math.max(1, pool.granted)) * 100),
      )
      metrics.push({
        id: 'warp-bonus',
        label: t.windows.warpBonusCredits,
        kind: 'percent',
        percent,
        used: pool.granted - pool.remaining,
        total: pool.granted,
        resetsAt: pool.expiresAt ?? undefined,
      })
    }

    if (metrics.length === 0) throw new Error(errs.noWindows)
    return metrics
  },
}
