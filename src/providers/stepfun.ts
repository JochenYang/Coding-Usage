import type { ProviderDef } from '../types'

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
  async parseResponse(json) {
    // Account endpoint returns a single CNY figure; the API tolerates string numbers
    const raw = (json as { balance?: unknown }).balance
    const amount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN
    if (!Number.isFinite(amount)) {
      throw new Error('Key 无效或响应格式变化')
    }
    return [
      {
        id: 'stepfun-balance',
        label: '账户余额（CNY）',
        kind: 'balance',
        remaining: Math.round(amount * 100) / 100,
        unit: 'CNY',
        detail: [],
      },
    ]
  },
}
