import type { ProviderDef } from '../types'

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
  async parseResponse(json) {
    // availableBalance is denominated in 0.0001 USD and must be scaled down
    const raw = (json as { availableBalance?: unknown }).availableBalance
    const units = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN
    if (!Number.isFinite(units)) {
      throw new Error('Key 无效或响应格式变化')
    }
    return [
      {
        id: 'novita-balance',
        label: '可用余额（USD）',
        kind: 'balance',
        remaining: Math.round((units / 10_000) * 100) / 100,
        unit: 'USD',
        detail: [],
      },
    ]
  },
}
