import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

const ZHIPU_BASE_URLS: Record<string, string> = {
  cn: 'https://open.bigmodel.cn',
  intl: 'https://api.z.ai',
}

interface ZhipuLimit {
  type?: string
  unit?: number
  percentage?: number
  nextResetTime?: number
  remaining?: number
  currentValue?: number
  usage?: number
}

export const zhipu: ProviderDef = {
  id: 'zhipu',
  name: 'Z.ai',
  accent: 'from-sky-500 to-cyan-500',
  logo: 'zhipu-color',
  tagline: (t) => t.providers.zhipu.tagline,
  regions: (t) => [
    { id: 'cn', label: t.regions.zhipuCN, baseUrl: ZHIPU_BASE_URLS.cn },
    { id: 'intl', label: t.regions.zhipuIntl, baseUrl: ZHIPU_BASE_URLS.intl },
  ],
  docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/usage-notes',
  keyUrl: 'https://bigmodel.cn/console/coding-plan',
  buildRequest(key, regionId) {
    const baseUrl = ZHIPU_BASE_URLS[regionId ?? 'cn'] ?? ZHIPU_BASE_URLS.cn
    // Zhipu's usage API authenticates with the raw key directly in the `Authorization` header (no Bearer prefix)
    return {
      url: `${baseUrl}/api/monitor/usage/quota/limit`,
      headers: { Authorization: key, 'Accept-Language': 'en-US,en' },
    }
  },
  async parseResponse(json, ctx) {
    const body = json as {
      success?: boolean
      msg?: string
      code?: number
      data?: { level?: string; limits?: ZhipuLimit[] }
    }
    if (body.success !== true || !body.data?.limits) {
      throw new Error(body.msg ?? (body.code === 401 ? 'Key 无效或已过期' : '查询失败'))
    }
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const plan = (body.data.level ?? '').toUpperCase()
    const metrics: UsageMetric[] = []
    // TOKENS_LIMIT: unit=3 → 5h window, unit=6 → weekly window; legacy plans have only one
    const tokenLimits = body.data.limits
      .filter((l) => l.type === 'TOKENS_LIMIT')
      .sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0))
    const windowNames =
      tokenLimits.length > 1 ? [t.windows.fiveHour, t.windows.weeklyPlan] : [t.windows.planQuota]
    tokenLimits.forEach((l, i) => {
      if (typeof l.percentage !== 'number') return
      metrics.push({
        id: `zhipu-tokens-${i}`,
        label: plan ? `${plan} · ${windowNames[i]}` : windowNames[i],
        kind: 'percent',
        percent: l.percentage,
        resetsAt: typeof l.nextResetTime === 'number' ? l.nextResetTime : undefined,
      })
    })
    // TIME_LIMIT: MCP monthly call count
    const mcp = body.data.limits.find((l) => l.type === 'TIME_LIMIT')
    if (mcp && typeof mcp.currentValue === 'number') {
      metrics.push({
        id: 'zhipu-mcp',
        label: t.windows.mcpMonthly,
        kind: 'percent',
        percent: mcp.usage ? (mcp.currentValue / mcp.usage) * 100 : 0,
        used: mcp.currentValue,
        total: mcp.usage,
        unit: `${mcp.currentValue} / ${mcp.usage ?? '?'}`,
        resetsAt: typeof mcp.nextResetTime === 'number' ? mcp.nextResetTime : undefined,
      })
    }
    if (metrics.length === 0) throw new Error('响应中没有任何额度数据')
    return metrics
  },
}