import type { ProviderDef, UsageMetric } from '../types'

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
    return [metric]
  },
}
