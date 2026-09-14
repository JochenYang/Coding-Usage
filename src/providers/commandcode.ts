import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * Command Code GOAT adapter.
 *
 * Auth is the account's API key (`user_…`, the same one the CLI stores in
 * `~/.commandcode/auth.json`) — NOT a session cookie. The `/alpha/` family
 * accepts it as a Bearer token and returns everything the plan card needs:
 *
 *   GET /alpha/billing/credits       → credit balances + 5h/weekly windows
 *   GET /alpha/billing/subscriptions → plan id/status + billing period
 *   GET /alpha/usage/summary         → lifetime totals (cost / tokens / calls)
 *
 * The per-request detail endpoint (`/internal/usage`) is cookie-only and is
 * deliberately not queried: the plan page shows balances and quota windows,
 * and asking for a cookie would make the account much harder to add.
 *
 * All three requests are issued from parseResponse (async fan-out through the
 * injected ctx.fetch), so buildRequest emits a placeholder and skipPreflight
 * keeps the dispatcher from running its own preflight against it.
 */

const BASE = 'https://api.commandcode.ai'

/** Numeric-ish values arrive as strings from this API */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

interface CreditsBody {
  credits?: Record<string, unknown>
  windowLimits?: {
    fiveHour?: { used?: unknown; cap?: unknown; resetAt?: unknown }
    weekly?: { used?: unknown; cap?: unknown; resetAt?: unknown }
  }
}

interface SubscriptionsBody {
  data?: {
    status?: unknown
    currentPeriodEnd?: unknown
  }
}

/** One windowLimit entry → a percent metric, or null when the window is absent/empty */
function windowMetric(
  id: string,
  label: string,
  win: { used?: unknown; cap?: unknown; resetAt?: unknown } | undefined,
): UsageMetric | null {
  const cap = num(win?.cap)
  if (!win || cap == null || cap <= 0) return null
  const used = num(win.used) ?? 0
  const reset = num(win.resetAt)
  return {
    id,
    label,
    kind: 'percent',
    percent: Math.min(100, (used / cap) * 100),
    used,
    total: cap,
    // resetAt is epoch ms when large, epoch seconds otherwise
    resetsAt: reset != null ? (reset < 1e12 ? reset * 1000 : reset) : undefined,
  }
}

export const commandcode: ProviderDef = {
  id: 'commandcode',
  name: 'Command Code GOAT',
  accent: 'from-slate-700 to-slate-900',
  logo: 'commandcode-avatar',
  tagline: (t) => t.providers.commandcode.tagline,
  docsUrl: 'https://commandcode.ai/docs',
  keyUrl: 'https://commandcode.ai/settings/keys',
  buildRequest() {
    // Real requests are issued inside parseResponse (three-endpoint fan-out);
    // this placeholder only satisfies the transport contract.
    return { url: `${BASE}/alpha/billing/credits`, headers: {} }
  },
  skipPreflight: true,
  async parseResponse(_json, ctx) {
    const fetchFn = ctx?.fetch
    const key = (ctx?.key ?? '').trim()
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const errs = t.providerErrors
    if (!fetchFn) return []
    if (!key) throw new Error(errs.keyInvalid)

    const auth = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    const get = (path: string) => fetchFn(`${BASE}${path}`, auth)

    let creditsRes: Response
    try {
      creditsRes = await get('/alpha/billing/credits')
    } catch {
      throw new Error(errs.networkFailed)
    }
    if (creditsRes.status === 401 || creditsRes.status === 403) {
      throw new Error(errs.keyInvalid)
    }
    if (!creditsRes.ok) throw new Error(`HTTP ${creditsRes.status}`)

    const creditsBody = (await creditsRes.json().catch(() => null)) as CreditsBody | null
    if (!creditsBody || typeof creditsBody !== 'object') {
      throw new Error(errs.badResponse)
    }

    // The lifetime summary is nice-to-have: a failure there must never hide
    // the balance + windows the card is built around.
    const summaryBody = await get('/alpha/usage/summary')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

    // Same deal for the subscription: the plan card is complete without an
    // expiry line, so a key without billing-scope access (or any other
    // failure) degrades to "no expiry shown", never to an error card.
    const subsBody = await get('/alpha/billing/subscriptions')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

    const credits = (creditsBody.credits ?? creditsBody) as Record<string, unknown>
    const metrics: UsageMetric[] = []

    // Headline credit balance (monthly + purchased + free all roll into one figure)
    const balance =
      num(credits.monthlyCredits) ??
      num(credits.credits) ??
      num(credits.balance) ??
      num(credits.remainingCredits) ??
      num(credits.availableCredits)
    if (balance != null) {
      const details: { label: string; value: number }[] = []
      const purchased = num(credits.purchasedCredits)
      if (purchased != null) details.push({ label: t.provider.topUpBalance, value: purchased })
      const free = num(credits.freeCredits)
      if (free != null) details.push({ label: t.provider.grantBalance, value: free })
      metrics.push({
        id: 'commandcode-credits',
        label: t.provider.balanceLabel('USD'),
        kind: 'balance',
        remaining: balance,
        unit: 'USD',
        detail: details,
      })
    }

    // Quota windows mirror the CLI's own display (5h rolling + weekly)
    const five = windowMetric('commandcode-5h', t.windows.fiveHour, creditsBody.windowLimits?.fiveHour)
    if (five) metrics.push(five)
    const weekly = windowMetric('commandcode-week', t.windows.weeklyPlan, creditsBody.windowLimits?.weekly)
    if (weekly) metrics.push(weekly)

    // Subscription period end (ISO string, e.g. "2026-10-14T01:12:06.000Z").
    // Only active subscriptions carry a meaningful renewal date; anything else
    // (canceled, past-due, trialing) would show a misleading "expiry".
    const subs = subsBody as SubscriptionsBody | null
    const periodEnd = subs?.data?.currentPeriodEnd
    const expiresAt =
      typeof periodEnd === 'string' && subs?.data?.status === 'active'
        ? (() => {
            const parsed = Date.parse(periodEnd)
            return Number.isNaN(parsed) ? undefined : parsed
          })()
        : undefined
    if (expiresAt != null) {
      metrics.push({ id: 'commandcode-expiry', label: t.provider.planExpiry, kind: 'expiry', expiresAt })
    }

    // Lifetime totals become detail rows on the balance metric (informational)
    const summary = summaryBody as Record<string, unknown> | null
    const totalCost = num(summary?.totalCost)
    const totalCalls = num(summary?.totalCount)
    if (balance != null && (totalCost != null || totalCalls != null)) {
      const bal = metrics[0]
      if (bal?.kind === 'balance') {
        bal.detail = bal.detail ?? []
        if (totalCost != null) bal.detail.push({ label: t.provider.lifetimeCost, value: totalCost })
        if (totalCalls != null) bal.detail.push({ label: t.provider.lifetimeCalls, value: totalCalls })
      }
    }

    if (metrics.length === 0) throw new Error(errs.noWindows)
    return metrics
  },
}
