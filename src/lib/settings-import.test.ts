import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig, Settings } from '../types'
import { getProvider } from '../providers/registry'
import { mergeImportedSettings, readImportedSettings } from './settings-import'
import { KEY_V3, loadSettingsDetailed } from './storage'

/**
 * The route a settings backup takes on import. A backup written before the
 * split-site providers were split files every account of a provider under one
 * id with a `regionId`; the import has to place each account under the
 * provider of its own site, or an international account's key is sent to the
 * China host — and saving that account would make it permanent.
 */

// Obviously synthetic fixture values — real credentials never appear in tests.
const account = (label: string, regionId?: string): ProviderConfig => ({
  enabled: true,
  apiKey: `demo-key-${label}`,
  label,
  ...(regionId ? { regionId } : {}),
})

const CURRENT: Settings = {
  providers: { deepseek: [account('kept-locally')] },
  autoRefreshMin: 0,
  displayCurrency: 'CNY',
  usageDisplayMode: 'all',
  desktopIsland: true,
  planOrder: [],
  subscriptionOrder: [],
  enabledSubscriptions: ['codex'],
  alertThresholds: { resetSoonMin: 60, highUsagePct: 90, lowBalance: { CNY: 5, USD: 1, HKD: 5, TWD: 30 } },
  integrations: {
    alertPush: false,
    wecomWebhook: '',
    feishuWebhook: '',
    feishuSecret: '',
    dingtalkWebhook: '',
    dingtalkSecret: '',
    discordWebhook: '',
    slackWebhook: '',
    barkServer: '',
    barkKey: '',
    ntfyServer: '',
    ntfyTopic: '',
    telegramBotToken: '',
    telegramChatId: '',
    weixinBotToken: '',
    weixinBotUserId: '',
  },
}

/** `[domestic id, international id, hosts an account of each may talk to]` */
const SITES = [
  ['zhipu', 'zai', ['open.bigmodel.cn'], ['api.z.ai']],
  ['kimi', 'kimi-intl', ['api.moonshot.cn', 'api.kimi.com'], ['api.moonshot.ai', 'api.kimi.com']],
  ['siliconflow', 'siliconflow-intl', ['api.siliconflow.cn'], ['api.siliconflow.com']],
  ['minimax', 'minimax-intl', ['api.minimax.cn'], ['www.minimax.io']],
] as const

const labels = (list: ProviderConfig[] | undefined): (string | undefined)[] =>
  (list ?? []).map((entry) => entry.label)

// Every request the app sends, with the key it carried. The transport reads
// the bridge once at module load, so it is stubbed before `./query` loads and
// keeps that object for the whole file.
const sent: Array<{ host: string; key: string }> = []
vi.stubGlobal('window', {
  desktopBridge: {
    fetch: async (url: string, headers: Record<string, string>) => {
      sent.push({ host: new URL(url).host, key: headers.Authorization ?? '' })
      // Refused everywhere: the request is what matters here, not the answer
      return { status: 401, body: '' }
    },
  },
})
const { fetchUsage } = await import('./query')

beforeEach(() => {
  sent.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readImportedSettings', () => {
  it('returns null when there is no providers record to import', () => {
    for (const raw of [null, undefined, 'junk', 7, [], {}, { providers: null }, { providers: 'x' }, { providers: [] }]) {
      expect(readImportedSettings(raw)).toBeNull()
    }
  })

  it.each(SITES)('places a pre-split %s account under the provider of its site', (domestic, international) => {
    const imported = readImportedSettings({
      providers: { [domestic]: [account('intl-first', 'intl'), account('cn', 'cn'), account('bare')] },
    })
    expect(labels(imported?.providers[domestic])).toEqual(['cn', 'bare'])
    expect(labels(imported?.providers[international])).toEqual(['intl-first'])
    expect(imported?.split.reindexed).toEqual([domestic])
  })

  it('leaves a provider that has no regional account alone', () => {
    const imported = readImportedSettings({ providers: { deepseek: [account('ds')] } })
    expect(labels(imported?.providers.deepseek)).toEqual(['ds'])
    expect(imported?.split).toEqual({ reindexed: [], renamed: {} })
  })
})

describe('mergeImportedSettings', () => {
  it('replaces a provider the backup lists and keeps one it does not', () => {
    const imported = readImportedSettings({
      providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] },
    })
    const merged = mergeImportedSettings(CURRENT, imported!)
    expect(labels(merged.providers.deepseek)).toEqual(['kept-locally'])
    expect(labels(merged.providers.zhipu)).toEqual(['cn'])
    expect(labels(merged.providers.zai)).toEqual(['intl'])
  })

  it('lets absent fields and empty lists keep their current values', () => {
    const imported = readImportedSettings({ providers: {}, planOrder: [], enabledSubscriptions: [] })
    const merged = mergeImportedSettings(CURRENT, imported!)
    expect(merged).toEqual(CURRENT)
  })

  it('takes the fields the backup does carry', () => {
    const imported = readImportedSettings({
      providers: {},
      autoRefreshMin: 5,
      displayCurrency: 'USD',
      planOrder: ['zai-0'],
      enabledSubscriptions: ['kimi'],
    })
    const merged = mergeImportedSettings(CURRENT, imported!)
    expect(merged).toMatchObject({ autoRefreshMin: 5, displayCurrency: 'USD', planOrder: ['zai-0'], enabledSubscriptions: ['kimi'] })
  })
})

describe('an imported account’s key only ever reaches its own site', () => {
  const SHAPES: Record<string, ProviderConfig[]> = {
    'one international': [account('intl', 'intl')],
    'one China': [account('cn', 'cn')],
    'international first': [account('intl', 'intl'), account('cn', 'cn')],
    'China first': [account('cn', 'cn'), account('intl', 'intl')],
    'no region': [account('bare')],
  }

  it.each(SITES)(
    'for $domestic / $international',
    async (domestic, _international, chinaHosts, intlHosts) => {
    for (const [shape, accounts] of Object.entries(SHAPES)) {
      sent.length = 0
      const imported = readImportedSettings({ providers: { [domestic]: accounts } })
      if (!imported) throw new Error(`${shape}: backup rejected`)
      const merged = mergeImportedSettings(CURRENT, imported)

      for (const [providerId, entries] of Object.entries(merged.providers)) {
        const def = getProvider(providerId)
        if (!def) throw new Error(`${shape}: unknown provider ${providerId}`)
        for (const cfg of entries) void await fetchUsage(def, cfg, 'en-US')
      }

      for (const cfg of accounts) {
        const isInternational = cfg.regionId === 'intl'
        const hosts = new Set(sent.filter((r) => r.key.includes(cfg.apiKey)).map((r) => r.host))
        // The account was asked about, and only on its own site's hosts
        expect(hosts.size, `${shape}: ${cfg.label}`).toBeGreaterThan(0)
        for (const host of hosts) {
          expect(isInternational ? intlHosts : chinaHosts, `${shape}: ${cfg.label} → ${host}`).toContain(host)
        }
      }
    }
  })

  it.each(SITES)(
    'for $domestic loaded from each kind of stored document',
    async (domestic, _international, chinaHosts, intlHosts) => {
      const documents: Array<[name: string, store: (text: string) => void]> = [
        // The plaintext document, and the one the browser build reads
        ['v2', (text) => localStorage.setItem('coding-usage.settings.v2', text)],
        // The encrypted document desktop installs use (read only under a bridge)
        ['v3', (text) => localStorage.setItem(KEY_V3, text)],
        ['v1', (text) => localStorage.setItem('coding-usage.settings.v1', text)],
      ]
      for (const [document, store] of documents) {
        for (const [shape, accounts] of Object.entries(SHAPES)) {
          vi.stubGlobal('localStorage', mapBackedStorage())
          vi.stubGlobal('window', { desktopBridge: {} })
          sent.length = 0
          store(JSON.stringify({ providers: { [domestic]: accounts } }))

          const { settings } = loadSettingsDetailed()
          for (const [providerId, entries] of Object.entries(settings.providers)) {
            const def = getProvider(providerId)
            if (!def) throw new Error(`${document}/${shape}: unknown provider ${providerId}`)
            for (const cfg of entries) void await fetchUsage(def, cfg, 'en-US')
          }

          for (const cfg of accounts) {
            const isInternational = cfg.regionId === 'intl'
            const hosts = new Set(sent.filter((r) => r.key.includes(cfg.apiKey)).map((r) => r.host))
            expect(hosts.size, `${document}/${shape}: ${cfg.label}`).toBeGreaterThan(0)
            for (const host of hosts) {
              expect(isInternational ? intlHosts : chinaHosts, `${document}/${shape}: ${cfg.label} → ${host}`).toContain(host)
            }
          }
        }
      }
    },
  )
})

/** The whole localStorage surface the settings loader needs. */
function mapBackedStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
  } as Storage
}
