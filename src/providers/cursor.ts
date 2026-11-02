import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/** The usage-summary endpoint the Cursor dashboard itself calls. */
const USAGE_URL = 'https://cursor.com/api/usage-summary'
/** Fallback UA: the endpoint gates on a client identity, not on the token alone. */
const CURSOR_UA = 'cursor-agent/2026.07.07'

interface CursorUsageBody {
  is_unlimited?: unknown
  billing_cycle_end?: unknown
  individual_usage?: {
    plan?: {
      total_percent_used?: unknown
      auto_percent_used?: unknown
      api_percent_used?: unknown
    }
    on_demand?: { enabled?: unknown; used?: unknown }
  }
  team_usage?: { on_demand?: { used?: unknown } }
}

function pct(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

/** JWT payload → JSON; base64url without padding, as issued by WorkOS. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const parsed: unknown = JSON.parse(atob(padded))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The web dashboard authenticates with a `WorkosCursorSessionToken` cookie built
 * from the editor's OAuth token (`<accountId>::<token>`, percent-encoded), not
 * with an Authorization header. The account id is the tail of the JWT `sub`
 * claim after the last `|`.
 *
 * Only Electron can send a Cookie header (the main process uses net.fetch); the
 * browser build is subject to the fetch spec, which forbids it, so this adapter
 * is desktop-only by construction.
 */
function sessionCookie(token: string): string | null {
  const claims = decodeJwtPayload(token)
  const sub = typeof claims?.sub === 'string' ? claims.sub : ''
  const accountId = sub.split('|').pop() ?? ''
  if (!accountId) return null
  return `WorkosCursorSessionToken=${accountId}%3A%3A${token}`
}

function isoToMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const cursor: ProviderDef = {
  id: 'cursor',
  name: 'Cursor',
  accent: 'from-neutral-700 to-neutral-900',
  logo: 'cursor-color',
  tagline: (t) => t.providers.cursor.tagline,
  docsUrl: 'https://cursor.com/dashboard?tab=usage',
  keyUrl: 'https://cursor.com/dashboard?tab=usage',
  // The request needs a derived header and a localized error path, so it runs
  // inside parseResponse rather than as a transport preflight.
  skipPreflight: true,
  buildRequest() {
    return { url: USAGE_URL, headers: {} }
  },
  async parseResponse(_json, ctx) {
    const fetchFn = ctx?.fetch
    const key = (ctx?.key ?? '').trim()
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const errs = t.providerErrors
    if (!fetchFn) return []
    if (!key) throw new Error(errs.keyInvalid)
    const cookie = sessionCookie(key)
    if (!cookie) throw new Error(errs.cursorTokenShape)

    let res: Response
    try {
      res = await fetchFn(USAGE_URL, {
        Cookie: cookie,
        'User-Agent': CURSOR_UA,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
      })
    } catch {
      throw new Error(errs.networkFailed)
    }
    if (res.status === 401 || res.status === 403) throw new Error(errs.keyInvalid)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = (await res.json().catch(() => null)) as CursorUsageBody | null
    if (!body || typeof body !== 'object') throw new Error(errs.badResponse)

    const metrics: UsageMetric[] = []
    const resetsAt = isoToMs(body.billing_cycle_end)
    // Same numbers the dashboard restates in English ("you've used N% of your
    // included ..."), so they are percentages consumed — never invert them.
    const windows: Array<[string, string, unknown]> = [
      ['cursor-total', t.windows.cursorTotal, body.individual_usage?.plan?.total_percent_used],
      ['cursor-auto', t.windows.cursorAuto, body.individual_usage?.plan?.auto_percent_used],
      ['cursor-api', t.windows.cursorApi, body.individual_usage?.plan?.api_percent_used],
    ]
    for (const [id, label, raw] of windows) {
      const used = pct(raw)
      if (used == null) continue
      metrics.push({
        id,
        label,
        kind: 'percent',
        percent: body.is_unlimited === true ? 0 : used,
        resetsAt,
      })
    }
    if (metrics.length === 0) throw new Error(errs.noWindows)
    return metrics
  },
}
