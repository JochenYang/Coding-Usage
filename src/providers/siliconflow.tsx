import type { ProviderDef } from '../types'
import { SiliconFlowLogo } from '@/components/logos/SiliconFlow'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

export const siliconflow: ProviderDef = {
  id: 'siliconflow',
  name: 'SiliconFlow',
  accent: 'from-fuchsia-500 to-purple-600',
  logo: <SiliconFlowLogo />,
  tagline: (t) => t.providers.siliconflow.tagline,
  docsUrl: 'https://docs.siliconflow.com/cn/api-reference/userinfo/get-user-info',
  keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  buildRequest(key) {
    return {
      url: 'https://api.siliconflow.cn/v1/user/info',
      headers: { Authorization: `Bearer ${key}` },
    }
  },
  async parseResponse(json, ctx) {
    const body = json as {
      code?: number
      data?: { balance?: string; chargeBalance?: string; totalBalance?: string }
    }
    if (body.code !== 20000 || !body.data) {
      throw new Error(body.code === 20012 ? 'Key 无效或已过期' : '查询失败')
    }
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const d = body.data
    const total = Number(d.totalBalance)
    if (!Number.isFinite(total)) {
      throw new Error('响应格式变化：缺少 totalBalance')
    }
    return [
      {
        id: 'siliconflow-total',
        label: t.provider.totalBalanceLabel('CNY'),
        kind: 'balance',
        remaining: total,
        unit: 'CNY',
        detail: [
          { label: t.provider.grantBalance, value: Number(d.balance) || 0 },
          { label: t.provider.topUpBalance, value: Number(d.chargeBalance) || 0 },
        ],
      },
    ]
  },
}