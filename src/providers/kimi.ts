import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * Kimi / Moonshot adapter: account balance (moonshot API) plus the Kimi Code
 * plan windows (api.kimi.com/coding/v1/usages, same key). The plan query is
 * best-effort — a failure there must not hide the balance metrics.
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
  async parseResponse(json, ctx) {
    const regionId = ctx?.regionId
    const body = json as {
      code?: number
      data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number }
    }
    if (body.code !== 0 || !body.data) {
      throw new Error('Key 无效或请求被拒绝')
    }
    const d = body.data
    if (typeof d.available_balance !== 'number') {
      throw new Error('响应格式变化：缺少 available_balance')
    }
    const metric: UsageMetric = {
      id: 'kimi-available',
      label: '可用余额',
      kind: 'balance',
      remaining: d.available_balance,
      unit: regionId === 'intl' ? 'USD' : 'CNY',
      detail: [
        { label: '现金余额', value: d.cash_balance ?? 0 },
        { label: '代金券', value: d.voucher_balance ?? 0 },
      ],
    }
    const metrics: UsageMetric[] = [metric]

    // Kimi Code plan windows (optional: endpoint mirrors the same API key)
    if (ctx?.fetch) {
      try {
        const t = DICTS[(ctx.locale as Locale | undefined) ?? 'zh-CN']
        const planMetrics = await fetchKimiPlan(ctx.fetch, ctx.key, t.windows.fiveHour, t.windows.weeklyPlan)
        metrics.push(...planMetrics)
      } catch {
        // plan endpoint unavailable/expired — balance above stays visible
      }
    }
    return metrics
  },
}

async function fetchKimiPlan(
  fetchFn: (url: string, headers: Record<string, string>) => Promise<Response>,
  key: string | undefined,
  fiveHourLabel: string,
  weeklyLabel: string,
): Promise<UsageMetric[]> {
  const res = await fetchFn('https://api.kimi.com/coding/v1/usages', {
    Authorization: `Bearer ${key ?? ''}`,
    Accept: 'application/json',
  })
  if (!res.ok) return []
  const body = (await res.json()) as {
    limits?: unknown
    usage?: { limit?: number | string; remaining?: number | string; resetTime?: number | string }
  }
  const asNum = (v: number | string | undefined): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined
  }
  const resetAt = (v: number | string | undefined): number | undefined => {
    const n = asNum(v)
    if (n == null) return undefined
    // seconds or milliseconds — anything < 1e12 is seconds
    return n < 1e12 ? n * 1000 : n
  }
  const metrics: UsageMetric[] = []
  // cc-switch 实测 shapes: `limits: [{ detail: {...} }]` (array of entries) —
  // defensive support for both the array and the plain object form.
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
      label: fiveHourLabel,
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
        label: weeklyLabel,
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
