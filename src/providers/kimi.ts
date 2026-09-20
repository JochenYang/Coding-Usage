import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale, Dict } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/** Kimi Code subscription quota surface: the 5-hour / weekly windows, reported
 *  as PERCENTAGES of the plan allowance (verified live: 5h=7%, weekly=9%) —
 *  never token counts or request counts. */
const KIMI_CODE_USAGES_URL = 'https://api.kimi.com/coding/v1/usages'

/** Moonshot platform balance payload (`GET /v1/users/me/balance`) */
interface BalanceBody {
  code?: number
  data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number }
}

/**
 * Kimi / Moonshot adapter: account balance (Moonshot platform API) plus the
 * Kimi Code plan windows (api.kimi.com/coding/v1/usages).
 *
 * These are two SEPARATE billing surfaces with two SEPARATE credentials: a
 * Moonshot platform API key only ever yields a money balance, while the
 * 5-hour / weekly quota windows belong to a Kimi Code subscription — a Kimi
 * Code token is rejected by the balance endpoint with HTTP 401 (verified).
 * The balance therefore stays the primary metric whenever it answers; when it
 * is refused, the adapter says so in actionable terms and, as a best effort,
 * shows the Kimi Code quota instead of blaming an "invalid key".
 *
 * Unlike most adapters this one runs with `skipPreflight` and issues the
 * balance request itself: the shared transport answers HTTP 401/403 with a
 * generic error *before* parseResponse runs, which is precisely the case that
 * has to be told apart from a genuinely unusable credential.
 */
export const kimi: ProviderDef = {
  id: 'kimi',
  name: 'Kimi / Moonshot',
  accent: 'from-cyan-500 to-blue-600',
  logo: 'kimi-color',
  // lobehub's kimi-color.svg is a white "K" on a white background and would be invisible in the light theme
  logoDarkInvert: true,
  tagline: (t) => t.providers.kimi.tagline,
  regions: (t) => [
    { id: 'cn', label: t.regions.kimiCN, baseUrl: 'https://api.moonshot.cn' },
    { id: 'intl', label: t.regions.kimiIntl, baseUrl: 'https://api.moonshot.ai' },
  ],
  docsUrl: 'https://platform.kimi.com/docs/api/balance',
  keyUrl: 'https://platform.kimi.com/console/api-keys',
  buildRequest(key, regionId) {
    const baseUrl = regionId === 'intl' ? 'https://api.moonshot.ai' : 'https://api.moonshot.cn'
    return {
      url: `${baseUrl}/v1/users/me/balance`,
      headers: { Authorization: `Bearer ${key}` },
    }
  },
  // parseResponse issues the balance request through this same builder; see
  // the module docstring for why the transport preflight must be skipped.
  skipPreflight: true,
  async parseResponse(json, ctx) {
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const errs = t.providerErrors
    const regionId = ctx?.regionId
    const key = ctx?.key
    const fetchFn = ctx?.fetch

    let balance: BalanceBody | null = null
    let httpStatus = 0
    // A non-empty payload handed in by the caller is parsed in place, which
    // keeps the adapter usable standalone and leaves the balance success path
    // untouched; under the transport the payload is empty (skipPreflight), so
    // the balance request is issued right here.
    const handed = json as BalanceBody | null
    if (handed && typeof handed === 'object' && Object.keys(handed).length > 0) {
      balance = handed
      httpStatus = 200
    } else if (fetchFn) {
      try {
        const req = kimi.buildRequest(key ?? '', regionId)
        const res = await fetchFn(req.url, req.headers)
        httpStatus = res.status
        if (res.ok) balance = (await res.json().catch(() => null)) as BalanceBody | null
      } catch {
        // Transport-level failure (offline / CORS): status stays 0, no body
      }
    } else {
      // No request helper and no handed payload — nothing can be queried
      return []
    }

    const d = balance?.data
    if (balance && balance.code === 0 && d) {
      if (typeof d.available_balance !== 'number') {
        throw new Error(errs.badResponse)
      }
      const metric: UsageMetric = {
        id: 'kimi-available',
        label: t.provider.availableBalance,
        kind: 'balance',
        remaining: d.available_balance,
        unit: regionId === 'intl' ? 'USD' : 'CNY',
        detail: [
          { label: t.provider.cashBalance, value: d.cash_balance ?? 0 },
          { label: t.provider.voucherBalance, value: d.voucher_balance ?? 0 },
        ],
      }
      const metrics: UsageMetric[] = [metric]

      // Kimi Code plan windows (optional: endpoint mirrors the same API key)
      if (fetchFn) {
        try {
          const planMetrics = await fetchKimiPlan(fetchFn, key, kimiPlanLabels(t))
          metrics.push(...planMetrics)
        } catch {
          // plan endpoint unavailable/expired — balance above stays visible
        }
      }
      return metrics
    }

    // No usable Moonshot platform balance. The same key may still be a Kimi
    // Code subscription credential, whose quota is the useful thing to show —
    // strictly best effort, and never at the cost of the error thrown below.
    if (fetchFn) {
      try {
        const planMetrics = await fetchKimiPlan(fetchFn, key, kimiPlanLabels(t))
        if (planMetrics.length > 0) return planMetrics
      } catch {
        // fall through to the actionable diagnostic
      }
    }

    // HTTP 401/403, or a platform body whose non-zero `code` refuses the
    // request: the credential does not belong to this billing surface.
    if (
      httpStatus === 401 ||
      httpStatus === 403 ||
      (balance != null && typeof balance.code === 'number' && balance.code !== 0)
    ) {
      throw new Error(errs.kimiWrongSurface)
    }
    if (httpStatus === 0) throw new Error(errs.networkFailed)
    if (httpStatus !== 200) throw new Error(`HTTP ${httpStatus}`)
    throw new Error(errs.badResponse)
  },
}

/**
 * Window labels for the plan parser. Both the legacy count windows and the
 * newer month windows are mapped here so `fetchKimiPlan` stays free of locale
 * plumbing: `monthTotal` reuses the generic monthly label and `monthCode` the
 * plan-quota one, since the provider splits a calendar month into a total pool
 * and a coding-only pool.
 */
function kimiPlanLabels(t: Dict): {
  fiveHour: string
  weekly: string
  monthTotal: string
  monthCode: string
} {
  return {
    fiveHour: t.windows.fiveHour,
    weekly: t.windows.weeklyPlan,
    monthTotal: t.windows.monthly,
    monthCode: t.windows.planQuota,
  }
}

/**
 * Kimi Code plan windows. Shared by both branches of parseResponse (the
 * success path appends them to the balance; the rejected-credential path uses
 * them as the fallback view), so this stays the single parser for that
 * endpoint — it reports percentages of the plan allowance, hence `kind:
 * 'percent'` with no absolute token totals.
 */
async function fetchKimiPlan(
  fetchFn: (url: string, headers: Record<string, string>) => Promise<Response>,
  key: string | undefined,
  labels: { fiveHour: string; weekly: string; monthTotal: string; monthCode: string },
): Promise<UsageMetric[]> {
  const res = await fetchFn(KIMI_CODE_USAGES_URL, {
    Authorization: `Bearer ${key ?? ''}`,
    Accept: 'application/json',
  })
  if (!res.ok) return []
  const body = (await res.json()) as {
    usages?: unknown
    limits?: unknown
    usage?: { limit?: number | string; remaining?: number | string; resetTime?: number | string }
  }
  const asNum = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined
  }
  const resetAt = (v: unknown): number | undefined => {
    // ISO-8601 strings (quota model) or epoch numbers (legacy model)
    if (typeof v === 'string' && !/^\d+$/.test(v)) {
      const ms = Date.parse(v)
      return Number.isFinite(ms) ? ms : undefined
    }
    const n = asNum(v)
    if (n == null) return undefined
    // seconds or milliseconds — anything < 1e12 is seconds
    return n < 1e12 ? n * 1000 : n
  }
  const metrics: UsageMetric[] = []

  // New "quota model" (kimi-code #3787 / 0.43.1): the server now sends
  // `usages.{limit_5h,limit_7d,limit_month_total,limit_month_code}` each with a
  // 0-1 `used_ratio`. Preferred when present — the legacy fields below are kept
  // only as a fallback for older responses.
  const usages = body.usages
  if (usages && typeof usages === 'object') {
    const map: Array<[string, string, string]> = [
      ['limit_5h', 'kimi-plan-5h', labels.fiveHour],
      ['limit_7d', 'kimi-plan-weekly', labels.weekly],
      ['limit_month_total', 'kimi-plan-month-total', labels.monthTotal],
      ['limit_month_code', 'kimi-plan-month-code', labels.monthCode],
    ]
    const u = usages as Record<string, unknown>
    for (const [key_, id, label] of map) {
      const entry = u[key_]
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const ratio = asNum(e.used_ratio)
      if (ratio == null) continue
      // A ratio above 1 is already expressed as a percentage
      const percent = ratio <= 1 ? ratio * 100 : ratio
      metrics.push({
        id,
        label,
        kind: 'percent',
        percent: Math.min(100, Math.max(0, percent)),
        resetsAt: resetAt(e.reset_time ?? e.resetTime),
      })
    }
    if (metrics.length > 0) return metrics
  }

  // Shapes observed live through cc-switch: `limits: [{ detail: {...} }]`
  // (array of entries) — defensive support for both the array and the plain
  // object form.
  const limitDetails: (number | string | undefined)[] = []
  const limitRemainings: (number | string | undefined)[] = []
  const limitResets: (number | string | undefined)[] = []
  const rawLimits = body.limits
  if (Array.isArray(rawLimits)) {
    for (const item of rawLimits) {
      const d = (item as { detail?: { limit?: number | string; remaining?: number | string; resetTime?: number | string } })?.detail
      if (!d) continue
      limitDetails.push(d.limit)
      limitRemainings.push(d.remaining)
      limitResets.push(d.resetTime)
    }
  } else if (rawLimits && typeof rawLimits === 'object') {
    const d = (rawLimits as { detail?: { limit?: number | string; remaining?: number | string; resetTime?: number | string } }).detail
    if (d) {
      limitDetails.push(d.limit)
      limitRemainings.push(d.remaining)
      limitResets.push(d.resetTime)
    }
  }
  limitDetails.forEach((limitRaw, i) => {
    const limit = asNum(limitRaw)
    const remaining = asNum(limitRemainings[i])
    if (limit == null || limit <= 0) return
    const used = Math.max(0, limit - (remaining ?? limit))
    metrics.push({
      id: `kimi-plan-5h-${i}`,
      label: labels.fiveHour,
      kind: 'percent',
      percent: Math.min(100, (used / limit) * 100),
      used,
      total: limit,
      resetsAt: resetAt(limitResets[i]),
    })
  })
  const weekly = body.usage
  if (weekly) {
    const limit = asNum(weekly.limit)
    const remaining = asNum(weekly.remaining)
    if (limit != null && limit > 0) {
      const used = Math.max(0, limit - (remaining ?? limit))
      metrics.push({
        id: 'kimi-plan-weekly',
        label: labels.weekly,
        kind: 'percent',
        percent: Math.min(100, (used / limit) * 100),
        used,
        total: limit,
        resetsAt: resetAt(weekly.resetTime),
      })
    }
  }
  return metrics
}
