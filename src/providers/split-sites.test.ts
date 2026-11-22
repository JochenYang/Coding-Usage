import { describe, expect, it } from 'vitest'
import type { ProviderDef, ProviderConfig } from '../types'
import { normalizeProviders } from '../lib/storage'
import { PROVIDERS } from './registry'
import { kimi, kimiIntl } from './kimi'
import { minimax, minimaxIntl } from './minimax'
import { siliconflow, siliconflowIntl } from './siliconflow'
import { zai, zhipu } from './zhipu'

/**
 * Zhipu, Kimi, SiliconFlow and MiniMax each used to be one provider with a
 * China / International region switch. They are separate accounts with
 * separate subscriptions, so each site is now its own provider pinned to its
 * own host — a key from one site must never be sent to the other, not even
 * through a stale `regionId` saved before the split or imported from an old
 * backup.
 */

// Obviously synthetic fixture values — real credentials never appear in tests.
const KEY = 'demo-key-0000000000000000000000000000.abcdefghijklmnop'

interface Site {
  domestic: ProviderDef
  international: ProviderDef
  /** `[chinaHost, internationalHost]` */
  hosts: [string, string]
}

const SITES: Site[] = [
  { domestic: zhipu, international: zai, hosts: ['open.bigmodel.cn', 'api.z.ai'] },
  { domestic: kimi, international: kimiIntl, hosts: ['api.moonshot.cn', 'api.moonshot.ai'] },
  { domestic: siliconflow, international: siliconflowIntl, hosts: ['api.siliconflow.cn', 'api.siliconflow.com'] },
  { domestic: minimax, international: minimaxIntl, hosts: ['api.minimax.cn', 'www.minimax.io'] },
]

/** The host a request is sent to */
const hostOf = (def: ProviderDef, key: string, regionId?: string): string =>
  new URL(def.buildRequest(key, regionId).url).host

describe.each(SITES)('$domestic.id / $international.id', ({ domestic, international, hosts }) => {
  it('pins each provider to its own host and ignores any region argument', () => {
    expect(hostOf(domestic, KEY)).toBe(hosts[0])
    expect(hostOf(international, KEY)).toBe(hosts[1])
    // A pre-split argument must not reroute a key to the other site
    expect(hostOf(domestic, KEY, 'intl')).toBe(hosts[0])
    expect(hostOf(international, KEY, 'cn')).toBe(hosts[1])
  })

  it('exposes no region choice: the site is the provider', () => {
    expect(domestic.regions).toBeUndefined()
    expect(international.regions).toBeUndefined()
  })

  it('registers both, each under its own id', () => {
    const registered = new Set(PROVIDERS.map((def) => def.id))
    expect(registered.has(domestic.id)).toBe(true)
    expect(registered.has(international.id)).toBe(true)
    // Two names in the add-plan menu have to stay two entries
    expect(domestic.id).not.toBe(international.id)
    expect(domestic.name).not.toBe(international.name)
  })

  it('links to a console and docs page over https', () => {
    for (const def of [domestic, international]) {
      expect(new URL(def.keyUrl).protocol).toBe('https:')
      expect(new URL(def.docsUrl).protocol).toBe('https:')
    }
  })

  it('sends a migrated account’s key to the site the account was saved for', () => {
    // The full route a stored account takes: the pre-split list, through the
    // migration, into the request of the provider it ends up under.
    const { providers } = normalizeProviders({
      [domestic.id]: [
        { enabled: true, apiKey: 'demo-key-intl', label: 'intl', regionId: 'intl' },
        { enabled: true, apiKey: 'demo-key-cn', label: 'cn', regionId: 'cn' },
      ],
    })
    const routeOf = (def: ProviderDef): string[] =>
      (providers[def.id] ?? []).map((entry: ProviderConfig) => `${entry.label}@${hostOf(def, entry.apiKey)}`)

    expect(routeOf(domestic)).toEqual([`cn@${hosts[0]}`])
    expect(routeOf(international)).toEqual([`intl@${hosts[1]}`])
  })
})

describe('site-specific facts', () => {
  it('shows each SiliconFlow balance in its own site’s currency', async () => {
    const payload = { code: 20000, data: { totalBalance: '12', balance: '2', chargeBalance: '10' } }
    const [china] = await siliconflow.parseResponse(payload, { locale: 'zh-CN' })
    const [intl] = await siliconflowIntl.parseResponse(payload, { locale: 'zh-CN' })
    expect(china.unit).toBe('CNY')
    expect(intl.unit).toBe('USD')
  })

  it('shows each Kimi balance in its own site’s currency', async () => {
    const payload = { code: 0, data: { available_balance: 5, cash_balance: 3, voucher_balance: 2 } }
    const [china] = await kimi.parseResponse(payload, { locale: 'zh-CN' })
    const [intl] = await kimiIntl.parseResponse(payload, { locale: 'zh-CN' })
    expect(china.unit).toBe('CNY')
    expect(intl.unit).toBe('USD')
  })

  it('sends MiniMax’s China requests to the new minimax.cn hosts', () => {
    // The console moved off minimaxi.com; the old host redirects to the new one
    expect(hostOf(minimax, KEY)).toBe('api.minimax.cn')
    expect(minimax.buildRequest(KEY).headers.Referer).toBe('https://platform.minimax.cn/')
    expect(new URL(minimax.keyUrl).host).toBe('platform.minimax.cn')
    expect(new URL(minimaxIntl.keyUrl).host).toBe('platform.minimax.io')
  })

  it('links each site of a split console to that site’s own pages', () => {
    // MiniMax, SiliconFlow and Zhipu run a console per site
    for (const { domestic, international } of SITES) {
      if (domestic === kimi) continue
      expect(new URL(domestic.keyUrl).host).not.toBe(new URL(international.keyUrl).host)
      expect(new URL(domestic.docsUrl).host).not.toBe(new URL(international.docsUrl).host)
    }
  })

  it('points both Kimi providers at the one console both sites share', () => {
    // platform.moonshot.cn redirects to platform.kimi.com, so there is no
    // separate China console to link to
    for (const link of ['docsUrl', 'keyUrl'] as const) {
      expect(kimi[link]).toBe(kimiIntl[link])
      expect(new URL(kimi[link]).host).toBe('platform.kimi.com')
    }
  })

  it('reads the same Zhipu payload into the same windows on both sites', async () => {
    // Asserted on behaviour, not on the two providers sharing a function
    const payload = {
      success: true,
      code: 200,
      data: { level: 'lite', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 42 }] },
    }
    const china = await zhipu.parseResponse(payload, { locale: 'zh-CN' })
    const intl = await zai.parseResponse(payload, { locale: 'zh-CN' })
    expect(intl).toEqual(china)
  })
})
