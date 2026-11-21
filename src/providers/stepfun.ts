import type { ParseContext, ProviderDef } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

export const stepfun: ProviderDef = {
  id: 'stepfun',
  name: 'StepFun',
  accent: 'from-blue-500 to-cyan-500',
  logo: 'stepfun-avatar',
  tagline: (t) => t.providers.stepfun.tagline,
  docsUrl: 'https://platform.stepfun.com/docs/overview/quickstart',
  keyUrl: 'https://platform.stepfun.com/api-key',
  buildRequest(key) {
    return {
      url: 'https://api.stepfun.com/v1/accounts',
      headers: { Authorization: `Bearer ${key}` },
    }
  },
  async parseResponse(json, ctx?: ParseContext) {
    // Account endpoint returns a single CNY figure; the API tolerates string numbers
    const raw = (json as { balance?: unknown }).balance
    const amount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN
    if (!Number.isFinite(amount)) {
      const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
      throw new Error(t.providerErrors.keyOrShapeChanged)
    }
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    return [
      {
        id: 'stepfun-balance',
        label: t.provider.balanceLabel('CNY'),
        kind: 'balance',
        remaining: Math.round(amount * 100) / 100,
        unit: 'CNY',
        detail: [],
      },
    ]
  },
}
