import type { ProviderDef } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * SiliconFlow's two sites are separate accounts with separate balances, so
 * each is its own provider pinned to its own host and currency. They used to
 * be one provider with a region switch; accounts saved before the split are
 * moved by `normalizeProviders` (storage.ts). Only the host, the
 * settlement currency and the links differ — the response shape is identical.
 */
function siliconflowDef(site: 'cn' | 'intl'): ProviderDef {
  const intl = site === 'intl'
  const id = intl ? 'siliconflow-intl' : 'siliconflow'
  // The China site settles in CNY, the international one in USD
  const currency = intl ? 'USD' : 'CNY'
  return {
    id,
    name: intl ? 'SiliconFlow Intl' : 'SiliconFlow',
    accent: 'from-fuchsia-500 to-purple-600',
    logo: 'siliconcloud-color',
    tagline: (t) => t.providers[id].tagline,
    // The China docs site no longer publishes its API reference, so that
    // entry points at the guide it does serve.
    docsUrl: intl
      ? 'https://docs.siliconflow.com/cn/api-reference/userinfo/get-user-info'
      : 'https://docs.siliconflow.cn/cn/userguide/quickstart',
    keyUrl: intl ? 'https://cloud.siliconflow.com/account/ak' : 'https://cloud.siliconflow.cn/account/ak',
    buildRequest(key) {
      return {
        url: `https://api.siliconflow.${intl ? 'com' : 'cn'}/v1/user/info`,
        headers: { Authorization: `Bearer ${key}` },
      }
    },
    async parseResponse(json, ctx) {
      const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
      const body = json as {
        code?: number
        data?: { balance?: string; chargeBalance?: string; totalBalance?: string }
      }
      if (body.code !== 20000 || !body.data) {
        throw new Error(body.code === 20012 ? t.providerErrors.keyExpiredOrInvalid : t.providerErrors.queryFailed)
      }
      const d = body.data
      const total = Number(d.totalBalance)
      if (!Number.isFinite(total)) {
        throw new Error(t.providerErrors.missingField('totalBalance'))
      }
      return [
        {
          id: 'siliconflow-total',
          label: t.provider.totalBalanceLabel(currency),
          kind: 'balance',
          remaining: total,
          unit: currency,
          detail: [
            { label: t.provider.grantBalance, value: Number(d.balance) || 0 },
            { label: t.provider.topUpBalance, value: Number(d.chargeBalance) || 0 },
          ],
        },
      ]
    },
  }
}

export const siliconflow = siliconflowDef('cn')
export const siliconflowIntl = siliconflowDef('intl')
