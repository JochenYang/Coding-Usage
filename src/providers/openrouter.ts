import type { ParseContext, ProviderDef } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

export const openrouter: ProviderDef = {
  id: 'openrouter',
  name: 'OpenRouter',
  accent: 'from-violet-500 to-purple-600',
  logo: 'openrouter-color',
  tagline: (t) => t.providers.openrouter.tagline,
  docsUrl: 'https://openrouter.ai/docs/api-reference/get-credits',
  keyUrl: 'https://openrouter.ai/settings/keys',
  buildRequest(key) {
    return {
      url: 'https://openrouter.ai/api/v1/credits',
      headers: { Authorization: `Bearer ${key}` },
    }
  },
  async parseResponse(json, ctx?: ParseContext) {
    const data = (json as { data?: { total_credits?: number; total_usage?: number } }).data
    if (!data || typeof data.total_credits !== 'number') {
      const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
      throw new Error(t.providerErrors.keyOrShapeChanged)
    }
    const usage = typeof data.total_usage === 'number' ? data.total_usage : 0
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    return [
      {
        id: 'openrouter-balance',
        label: t.provider.balanceLabel('USD'),
        kind: 'balance',
        remaining: Math.round((data.total_credits - usage) * 100) / 100,
        unit: 'USD',
        detail: [
          { label: t.provider.usageSpent, value: usage },
          { label: t.provider.totalToppedUp, value: data.total_credits },
        ],
      },
    ]
  },
}
