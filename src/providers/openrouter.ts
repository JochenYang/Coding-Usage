import type { ProviderDef } from '../types'

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
  async parseResponse(json) {
    const data = (json as { data?: { total_credits?: number; total_usage?: number } }).data
    if (!data || typeof data.total_credits !== 'number') {
      throw new Error('Key 无效或响应格式变化')
    }
    const usage = typeof data.total_usage === 'number' ? data.total_usage : 0
    return [
      {
        id: 'openrouter-balance',
        label: '剩余额度（USD）',
        kind: 'balance',
        remaining: Math.round((data.total_credits - usage) * 100) / 100,
        unit: 'USD',
        detail: [
          { label: '已用', value: usage },
          { label: '累计充值', value: data.total_credits },
        ],
      },
    ]
  },
}
