import type { ParseContext, ProviderDef } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

export const novita: ProviderDef = {
  id: 'novita',
  name: 'Novita',
  accent: 'from-teal-500 to-emerald-500',
  logo: 'novita-color',
  tagline: (t) => t.providers.novita.tagline,
  docsUrl: 'https://novita.ai/docs/get-started/quickstart',
  keyUrl: 'https://novita.ai/dashboard/key',
  buildRequest(key) {
    return {
      url: 'https://api.novita.ai/v3/user/balance',
      headers: { Authorization: `Bearer ${key}` },
    }
  },
  async parseResponse(json, ctx?: ParseContext) {
    // availableBalance is denominated in 0.0001 USD and must be scaled down
    const raw = (json as { availableBalance?: unknown }).availableBalance
    const units = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN
    if (!Number.isFinite(units)) {
      const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
      throw new Error(t.providerErrors.keyOrShapeChanged)
    }
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    return [
      {
        id: 'novita-balance',
        label: t.provider.balanceLabel('USD'),
        kind: 'balance',
        remaining: Math.round((units / 10_000) * 100) / 100,
        unit: 'USD',
        detail: [],
      },
    ]
  },
}
