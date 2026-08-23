import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

export const deepseek: ProviderDef = {
  id: 'deepseek',
  name: 'DeepSeek',
  accent: 'from-blue-600 to-indigo-600',
  logo: 'deepseek-color',
  tagline: (t) => t.providers.deepseek.tagline,
  docsUrl: 'https://api-docs.deepseek.com/api/get-user-balance/',
  keyUrl: 'https://platform.deepseek.com/api_keys',
  buildRequest(key) {
    return {
      url: 'https://api.deepseek.com/user/balance',
      headers: { Authorization: `Bearer ${key}` },
    }
  },
  async parseResponse(json, ctx) {
    const body = json as {
      is_available?: boolean
      balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[]
    }
    const infos = body.balance_infos
    if (!Array.isArray(infos) || infos.length === 0) {
      throw new Error('Key 无效或响应格式变化')
    }
    // Locale is injected by the dispatcher via ParseContext; fallback to zh-CN when absent
    // (e.g. SSR / unit tests calling parseResponse directly without going through fetchUsage).
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    return infos.map((info, i): UsageMetric => {
      const currency = info.currency ?? ''
      const total = Number(info.total_balance)
      return {
        id: `deepseek-${currency || i}`,
        label: currency ? t.provider.balanceLabel(currency) : t.provider.balanceLabelFallback,
        kind: 'balance',
        remaining: Number.isFinite(total) ? total : undefined,
        unit: currency,
        detail: [
          { label: t.provider.topUpBalance, value: Number(info.topped_up_balance) || 0 },
          { label: t.provider.grantBalance, value: Number(info.granted_balance) || 0 },
        ],
      }
    })
  },
}