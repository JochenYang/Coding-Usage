import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig, ProviderResult } from '../types'
import { loadAlerts, renameAlertAccountKeys, saveAlerts, type AlertItem } from './alerts'
import { getSnapshots, recordSnapshot, remapSnapshotStore, type AccountSnapshot } from './snapshots'
import { loadCachedResults, saveCachedResults, withoutAccountResults } from './startup-cache'
import {
  KEY_V3,
  loadSettings,
  loadSettingsDetailed,
  needsMirrorRecovery,
  normalizeProviders,
  restoreSettingsDocument,
  saveSettings,
  SUBSCRIPTION_KEYS_VERSION,
} from './storage'

/**
 * Zhipu, Kimi, SiliconFlow and MiniMax each used to be one provider whose
 * accounts picked a site through `regionId`. Each is now two single-site
 * providers: the domestic one keeps the id, a new one takes the
 * international accounts. These tests lock the migration of accounts saved
 * before the split, and of everything else that is keyed by account — cached
 * readings, trend history, alert state — so no account is lost, no key is
 * sent to the wrong site, and no history is attributed to another account.
 */

// Node test environment has no localStorage; a Map-backed stub is the whole
// surface the storage layer needs. Its `failWritesTo` makes writes to chosen
// keys throw, as a full quota does.
function stubStorage(): { failWritesTo(...failingKeys: string[]): void; repairWrites(): void } {
  const map = new Map<string, string>()
  let failing: string[] = []
  vi.stubGlobal('localStorage', {
    get length() {
      return map.size
    },
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failing.includes(key)) throw new Error('QuotaExceededError')
      map.set(key, value)
    },
    removeItem: (key: string) => void map.delete(key),
  })
  return {
    failWritesTo: (...keys) => {
      failing = keys
    },
    repairWrites: () => {
      failing = []
    },
  }
}

// Obviously synthetic fixture values — real credentials never appear in tests.
const account = (label: string, regionId?: string): ProviderConfig => ({
  enabled: true,
  apiKey: `demo-key-${label}`,
  label,
  ...(regionId ? { regionId } : {}),
})

const reading = (fetchedAt = 1): ProviderResult => ({ status: 'ok', metrics: [], fetchedAt })

const alertOf = (accountKey: string): AlertItem => ({
  id: `${accountKey}:high-usage:m1`,
  level: 'danger',
  accountKey,
  agentName: 'demo',
  kind: 'high-usage',
  pct: 95,
  firstSeenAt: 1,
  lastSeenAt: 2,
  read: true,
})

const labels = (list: ProviderConfig[] | undefined): (string | undefined)[] =>
  (list ?? []).map((entry) => entry.label)

/** Storage keys of the two stores keyed by account that the split renames */
const SNAPSHOT_STORE = 'coding-usage.snapshots.v1'
const ALERT_STORE = 'coding-usage.alerts.v1'

/** The split providers as `[domestic, international]` */
const SITES = [
  ['zhipu', 'zai'],
  ['kimi', 'kimi-intl'],
  ['siliconflow', 'siliconflow-intl'],
  ['minimax', 'minimax-intl'],
] as const

beforeEach(() => {
  stubStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeProviders', () => {
  it.each(SITES)('moves the %s international accounts to %s', (domestic, international) => {
    const { providers, split } = normalizeProviders({
      [domestic]: [account('intl', 'intl'), account('cn', 'cn')],
    })
    expect(labels(providers[domestic])).toEqual(['cn'])
    expect(labels(providers[international])).toEqual(['intl'])
    expect(providers[domestic].every((entry) => entry.regionId === undefined)).toBe(true)
    expect(providers[international].every((entry) => entry.regionId === undefined)).toBe(true)
    // The China account moved from index 1 to index 0
    expect(split.reindexed).toEqual([domestic])
    expect(split.renamed).toEqual({ [`${domestic}-0`]: `${international}-0`, [`${domestic}-1`]: `${domestic}-0` })
  })

  it('leaves a China-only list in place and reports nothing to clean up', () => {
    const { providers, split } = normalizeProviders({ zhipu: [account('a', 'cn'), account('b')] })
    expect(labels(providers.zhipu)).toEqual(['a', 'b'])
    expect(providers.zhipu.every((entry) => entry.regionId === undefined)).toBe(true)
    // No account changed index, so no cached reading or history is affected
    expect(split).toEqual({ reindexed: [], renamed: {} })
  })

  it('keeps the domestic indexes when the international account sat last', () => {
    const { providers, split } = normalizeProviders({ kimi: [account('cn', 'cn'), account('intl', 'intl')] })
    expect(labels(providers.kimi)).toEqual(['cn'])
    expect(labels(providers['kimi-intl'])).toEqual(['intl'])
    // Only the moved account's key changed; the China account keeps `kimi-0`
    expect(split.renamed).toEqual({ 'kimi-1': 'kimi-intl-0' })
  })

  it('flags a provider for a cache drop whenever an account left it', () => {
    // One international account and nothing else: no account shifts, but the
    // old `zhipu-0` reading is orphaned, and it would surface the moment a
    // China account is added at that index.
    const { split } = normalizeProviders({ zhipu: [account('intl', 'intl')] })
    expect(split.reindexed).toEqual(['zhipu'])
    expect(split.renamed).toEqual({ 'zhipu-0': 'zai-0' })
  })

  it('places moved accounts behind the ones already saved under the split provider', () => {
    const { providers, split } = normalizeProviders({
      zhipu: [account('old-intl', 'intl')],
      zai: [account('already-there')],
    })
    expect(labels(providers.zai)).toEqual(['already-there', 'old-intl'])
    expect(split.renamed).toEqual({ 'zhipu-0': 'zai-1' })
  })

  it('treats a missing or unknown region as the China site, like the pre-split adapter did', () => {
    const { providers } = normalizeProviders({
      zhipu: [account('bare'), account('us', 'us'), account('intl', 'intl')],
    })
    expect(labels(providers.zhipu)).toEqual(['bare', 'us'])
    expect(labels(providers.zai)).toEqual(['intl'])
  })

  it('unwraps the older single-object format', () => {
    const { providers, split } = normalizeProviders({ zhipu: { ...account('solo', 'intl') } })
    expect(labels(providers.zai)).toEqual(['solo'])
    expect(split.renamed).toEqual({ 'zhipu-0': 'zai-0' })
  })

  it('drops entries that are not accounts instead of choking on them', () => {
    const { providers } = normalizeProviders({
      zhipu: [null, 'junk', account('intl', 'intl'), 7, account('cn', 'cn')],
    })
    expect(labels(providers.zhipu)).toEqual(['cn'])
    expect(labels(providers.zai)).toEqual(['intl'])
  })

  it('carries every other account field across unchanged', () => {
    const full: ProviderConfig = {
      enabled: false,
      apiKey: 'demo-key-full',
      label: 'work',
      regionId: 'intl',
      displayCurrencies: ['USD'],
    }
    const { providers } = normalizeProviders({ minimax: [full] })
    expect(providers['minimax-intl']).toEqual([
      { enabled: false, apiKey: 'demo-key-full', label: 'work', displayCurrencies: ['USD'] },
    ])
  })

  it('is idempotent', () => {
    const first = normalizeProviders({ siliconflow: [account('intl', 'intl'), account('cn', 'cn')] })
    const second = normalizeProviders(first.providers)
    expect(second.providers).toEqual(first.providers)
    expect(second.split).toEqual({ reindexed: [], renamed: {} })
  })

  it('reads anything that is not a providers record as empty', () => {
    for (const raw of [null, undefined, 'junk', 7, [], { zhipu: 'nope', kimi: null }]) {
      const { providers, split } = normalizeProviders(raw)
      expect(providers).not.toHaveProperty('zai')
      expect(providers).not.toHaveProperty('kimi-intl')
      expect(split).toEqual({ reindexed: [], renamed: {} })
    }
  })
})

describe('loadSettingsDetailed', () => {
  it('drops only the re-indexed provider’s cached readings', () => {
    saveSettings({ ...loadSettings(), providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] } })
    saveCachedResults({ 'zhipu-0': reading(10), 'zhipu-1': reading(20), 'deepseek-0': reading(30) })

    const loaded = loadSettingsDetailed()

    expect(labels(loaded.settings.providers.zhipu)).toEqual(['cn'])
    expect(labels(loaded.settings.providers.zai)).toEqual(['intl'])
    expect(loaded.split.reindexed).toEqual(['zhipu'])
    expect(Object.keys(loadCachedResults())).toEqual(['deepseek-0'])
  })

  it('spares the readings of a provider whose id extends the migrated one', () => {
    // `kimi-intl-0` starts with `kimi-`; a prefix match would delete it
    saveSettings({ ...loadSettings(), providers: { kimi: [account('intl', 'intl'), account('cn', 'cn')] } })
    saveCachedResults({ 'kimi-0': reading(10), 'kimi-intl-0': reading(20), 'kimi-extra-0': reading(30) })

    loadSettingsDetailed()

    expect(Object.keys(loadCachedResults()).sort()).toEqual(['kimi-extra-0', 'kimi-intl-0'])
  })

  it('keeps the cached readings when only the region field is dropped', () => {
    saveSettings({ ...loadSettings(), providers: { zhipu: [account('cn', 'cn')] } })
    saveCachedResults({ 'zhipu-0': reading(10) })

    const loaded = loadSettingsDetailed()

    expect(loaded.split.reindexed).toEqual([])
    expect(Object.keys(loadCachedResults())).toEqual(['zhipu-0'])
  })

  it('carries each account’s history to its new key', () => {
    // Distinct timestamps, so the test can tell the two histories apart
    vi.useFakeTimers()
    try {
      const base = Date.parse('2026-11-22T00:00:00Z')
      vi.setSystemTime(base)
      recordSnapshot('zhipu-0', []) // international account, index 0 before the split
      vi.setSystemTime(base + 60_000)
      recordSnapshot('zhipu-1', []) // China account, index 1 before the split
    } finally {
      vi.useRealTimers()
    }
    saveSettings({ ...loadSettings(), providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] } })

    loadSettingsDetailed()

    // The keys swap: a rename done one key at a time would hand the China
    // account the international account's history
    expect(getSnapshots('zai-0').map((s) => s.t)).toEqual([Date.parse('2026-11-22T00:00:00Z')])
    expect(getSnapshots('zhipu-0').map((s) => s.t)).toEqual([Date.parse('2026-11-22T00:01:00Z')])
    expect(getSnapshots('zhipu-1')).toEqual([])
  })

  it('retargets stored alerts, including their account key', () => {
    saveAlerts([
      alertOf('zhipu-0'),
      { ...alertOf('kimi-0'), accountKey: 'filed-elsewhere' },
      alertOf('deepseek-0'),
    ])
    saveSettings({
      ...loadSettings(),
      providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')], kimi: [account('intl', 'intl')] },
    })

    loadSettingsDetailed()

    const byId = new Map(loadAlerts().map((item) => [item.id, item]))
    expect([...byId.keys()].sort()).toEqual([
      'deepseek-0:high-usage:m1',
      'kimi-intl-0:high-usage:m1',
      'zai-0:high-usage:m1',
    ])
    // The read state and first-seen time travel with the alert
    expect(byId.get('zai-0:high-usage:m1')).toMatchObject({ accountKey: 'zai-0', read: true, firstSeenAt: 1 })
    // An account key that does not match the id is left as filed
    expect(byId.get('kimi-intl-0:high-usage:m1')?.accountKey).toBe('filed-elsewhere')
  })

  it('runs on the encrypted document desktop installs use', () => {
    vi.stubGlobal('window', { desktopBridge: {} })
    localStorage.setItem(
      KEY_V3,
      JSON.stringify({ providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] } }),
    )
    saveCachedResults({ 'zhipu-0': reading(10), 'deepseek-0': reading(30) })

    const loaded = loadSettingsDetailed()

    expect(labels(loaded.settings.providers.zai)).toEqual(['intl'])
    expect(Object.keys(loadCachedResults())).toEqual(['deepseek-0'])
  })

  it('runs on the legacy v1 document', () => {
    localStorage.setItem(
      'coding-usage.settings.v1',
      JSON.stringify({ providers: { zhipu: [account('intl', 'intl')] } }),
    )
    saveCachedResults({ 'zhipu-0': reading(10) })

    const loaded = loadSettings()

    expect(labels(loaded.providers.zai)).toEqual(['intl'])
    expect(Object.keys(loadCachedResults())).toEqual([])
  })

  it('applies the cleanup once per machine', () => {
    const legacy = { ...loadSettings(), providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] } }
    saveSettings(legacy)
    saveCachedResults({ 'zhipu-0': reading(10) })
    loadSettingsDetailed()
    expect(Object.keys(loadCachedResults())).toEqual([])

    // A document can outlive a failed persist and be read again on the next
    // launch. By then `zhipu-0` is the China account's own fresh reading;
    // re-running the cleanup would throw it away every launch.
    saveSettings(legacy)
    saveCachedResults({ 'zhipu-0': reading(40) })
    recordSnapshot('zhipu-0', [])
    const before = getSnapshots('zhipu-0')

    const again = loadSettingsDetailed()

    expect(Object.keys(loadCachedResults())).toEqual(['zhipu-0'])
    expect(getSnapshots('zhipu-0')).toEqual(before)
    expect(getSnapshots('zai-0')).toEqual([])
    // The accounts themselves are still normalized on every load
    expect(labels(again.settings.providers.zai)).toEqual(['intl'])
  })

  it('retries only the store whose write failed, never one already done', () => {
    const storage = stubStorage()
    const base = Date.parse('2026-11-22T00:00:00Z')
    const clock = (at: number): void => {
      vi.useFakeTimers()
      vi.setSystemTime(at)
    }
    // Two accounts' history and alerts under their pre-split keys
    try {
      clock(base)
      recordSnapshot('zhipu-0', []) // international account
      clock(base + 60_000)
      recordSnapshot('zhipu-1', []) // China account
    } finally {
      vi.useRealTimers()
    }
    saveAlerts([alertOf('zhipu-0'), alertOf('zhipu-1')])
    // The document itself is never rewritten here, as when an older one
    // outlives a failed persist: every load recomputes the move from it.
    saveSettings({ ...loadSettings(), providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] } })

    // 1. History cannot be written: it stays where it is, nothing is recorded
    //    for it, and the store after it is not started.
    storage.failWritesTo(SNAPSHOT_STORE)
    loadSettingsDetailed()
    expect(getSnapshots('zhipu-0').map((s) => s.t)).toEqual([base])
    expect(getSnapshots('zhipu-1').map((s) => s.t)).toEqual([base + 60_000])
    expect(loadAlerts().map((item) => item.id)).toEqual(['zhipu-0:high-usage:m1', 'zhipu-1:high-usage:m1'])

    // 2. History can be written, alerts cannot: history is renamed and
    //    recorded, and only the alert store is left to retry.
    storage.repairWrites()
    storage.failWritesTo(ALERT_STORE)
    loadSettingsDetailed()
    expect(getSnapshots('zai-0').map((s) => s.t)).toEqual([base])
    expect(getSnapshots('zhipu-0').map((s) => s.t)).toEqual([base + 60_000])
    expect(loadAlerts().map((item) => item.id)).toEqual(['zhipu-0:high-usage:m1', 'zhipu-1:high-usage:m1'])
    // `zhipu-0` is the China account's own key from here on. Whatever is
    // recorded under it must survive the retries still to come — repeating
    // the history rename would hand it to the international account.
    try {
      clock(base + 600_000)
      recordSnapshot('zhipu-0', [])
    } finally {
      vi.useRealTimers()
    }

    // 3. Writes work again: the alert store is the only thing redone.
    storage.repairWrites()
    loadSettingsDetailed()
    expect(getSnapshots('zai-0').map((s) => s.t)).toEqual([base])
    expect(getSnapshots('zhipu-0').map((s) => s.t)).toEqual([base + 60_000, base + 600_000])
    expect(loadAlerts().map((item) => item.id).sort()).toEqual(['zai-0:high-usage:m1', 'zhipu-0:high-usage:m1'])
    expect(localStorage.getItem('coding-usage.split-site-accounts.v1')).toBe('results+snapshots+alerts')
  })

  it('gives the same result on every load', () => {
    const legacy = { ...loadSettings(), providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] } }
    saveSettings(legacy)
    expect(loadSettingsDetailed().settings).toEqual(loadSettingsDetailed().settings)
  })
})

describe('recovery after the results cache is already in memory', () => {
  it('lets the caller drop the re-indexed accounts from its own copy', () => {
    const inMemory = { 'zhipu-0': reading(10), 'zhipu-1': reading(20), 'zai-0': reading(30), 'deepseek-0': reading(40) }
    expect(withoutAccountResults(inMemory, ['zhipu'])).toEqual({
      'zai-0': reading(30),
      'deepseek-0': reading(40),
    })
    // Nothing to drop: the same object, not a copy that would re-render
    expect(withoutAccountResults(inMemory, [])).toBe(inMemory)
  })

  it('reports the split so the recovery path knows what to drop', () => {
    // The file-mirror recovery loads settings after the cache is in state;
    // the stored cleanup has already run by the time it can act.
    saveSettings({ ...loadSettings(), providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] } })
    const first = loadSettingsDetailed()
    const recovered = loadSettingsDetailed()
    // Accounts keep being normalized, so a recovery that arrives late still
    // sees which provider was re-indexed and can clear its in-memory readings
    expect(recovered.settings).toEqual(first.settings)
    expect(recovered.split.reindexed).toEqual(['zhipu'])
  })
})

describe('startup recovery from the file mirror', () => {
  const has = (...keys: string[]): boolean => keys.some((key) => localStorage.getItem(key) != null)
  const put = (key: string, value: string): void => localStorage.setItem(key, value)

  it('waits for the mirror only under a bridge and with no settings document at all', () => {
    // No bridge: the browser build has no mirror to read
    expect(needsMirrorRecovery(false)).toBe(false)
    expect(needsMirrorRecovery(true)).toBe(true)
  })

  it.each(['coding-usage.settings.v3', 'coding-usage.settings.v2', 'coding-usage.settings.v1'])(
    'does not wait when %s holds a document',
    (key) => {
      put(key, '{}')
      expect(needsMirrorRecovery(true)).toBe(false)
    },
  )

  it.each(['coding-usage.settings.v3', 'coding-usage.settings.v2', 'coding-usage.settings.v1'])(
    'waits when %s is there but holds no document',
    (key) => {
      // A torn write or a blank value: the load path answers the defaults for
      // any of these just as it would for a missing key
      for (const value of ['', '   ', 'enc', '{"providers":{"zhipu":[{"apiKey":"enc', '[]', 'null']) {
        put(key, value)
        expect(needsMirrorRecovery(true), JSON.stringify(value)).toBe(true)
      }
    },
  )

  it('does not wait while any one key still holds a document', () => {
    // A broken v3 with the accounts still under the legacy key
    put(KEY_V3, 'enc')
    put('coding-usage.settings.v2', '{}')
    expect(needsMirrorRecovery(true)).toBe(false)
  })

  it('loads from the next key when an earlier one holds no document, as the gate assumes', () => {
    vi.stubGlobal('window', { desktopBridge: {} })
    // The gate is closed because a key holds a document, so the load has to
    // reach that document — the defaults here would be saved over the mirror
    put(KEY_V3, '{"providers":{"kimi":[{"apiKey":"enc')
    put('coding-usage.settings.v2', '{')
    put('coding-usage.settings.v1', JSON.stringify({ providers: { kimi: [account('legacy')] } }))
    expect(needsMirrorRecovery(true)).toBe(false)
    expect(labels(loadSettingsDetailed().settings.providers.kimi)).toEqual(['legacy'])

    // A v3 that parses but is no document must not shadow the accounts under v2
    put(KEY_V3, '[]')
    put('coding-usage.settings.v2', JSON.stringify({ providers: { kimi: [account('plain')] } }))
    expect(needsMirrorRecovery(true)).toBe(false)
    expect(labels(loadSettingsDetailed().settings.providers.kimi)).toEqual(['plain'])
  })

  it('waits, instead of throwing, when storage itself cannot be read', () => {
    // A leveldb that will not open throws from getItem
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('NotFoundError')
      },
    })
    expect(needsMirrorRecovery(true)).toBe(true)
  })

  it('restores a mirror document as it is, to be loaded like any other launch', () => {
    // The restored document is the encrypted one desktop installs use, which
    // is only read under a bridge
    vi.stubGlobal('window', { desktopBridge: {} })
    const backup = JSON.stringify({
      providers: { zhipu: [account('intl', 'intl'), account('cn', 'cn')] },
    })
    expect(restoreSettingsDocument(backup)).toBe('restored')
    expect(has(KEY_V3)).toBe(true)
    // The usual load path takes over from here: split, drop stale readings
    const loaded = loadSettingsDetailed()
    expect(labels(loaded.settings.providers.zai)).toEqual(['intl'])
    expect(loaded.split.reindexed).toEqual(['zhipu'])
  })

  it('stores a document an editor prefixed with a byte-order mark without the mark', () => {
    // JSON.parse rejects a leading mark, so storing the text as read would
    // hand the load path a document it cannot open
    vi.stubGlobal('window', { desktopBridge: {} })
    const document = JSON.stringify({ providers: { kimi: [account('main')] } })
    expect(restoreSettingsDocument(`\uFEFF${document}`)).toBe('restored')
    expect(localStorage.getItem(KEY_V3)).toBe(document)
    expect(labels(loadSettingsDetailed().settings.providers.kimi)).toEqual(['main'])
  })

  it('reports an absent mirror and leaves storage alone', () => {
    for (const backup of [null, undefined]) {
      expect(restoreSettingsDocument(backup)).toBe('absent')
    }
    expect(has(KEY_V3)).toBe(false)
  })

  it('reports a blank file as empty: what an interrupted write leaves behind', () => {
    for (const backup of ['', ' \n', '\uFEFF']) {
      expect(restoreSettingsDocument(backup), JSON.stringify(backup)).toBe('empty')
    }
    expect(has(KEY_V3)).toBe(false)
  })

  it('refuses a mirror that is not a settings document', () => {
    // Truncated JSON, and JSON of another shape
    for (const backup of ['{"providers":{"zhipu":[{"apiKey":"enc', '[]', 'null', '42', '"text"']) {
      expect(restoreSettingsDocument(backup), JSON.stringify(backup)).toBe('corrupt')
    }
    expect(has(KEY_V3)).toBe(false)
  })
})

/**
 * The Antigravity card was split into IDE / app / CLI, and `antigravity` went
 * from naming the IDE card to naming the app card. A document written before
 * the split must have its IDE card moved to `antigravity-ide` — once. From
 * then on `antigravity` is the app card a user may enable, and must stay.
 */
describe('subscription card keys across the Antigravity split', () => {
  const put = (value: unknown): void => localStorage.setItem(KEY_V3, JSON.stringify(value))
  const settingsDocument = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    providers: {},
    enabledSubscriptions: ['antigravity', 'codex'],
    subscriptionOrder: ['antigravity', 'codex'],
    ...extra,
  })

  beforeEach(() => {
    // The v3 document is only read under a bridge, as on a desktop install
    vi.stubGlobal('window', { desktopBridge: {} })
  })

  it('moves the IDE card of a document written before the split', () => {
    put(settingsDocument())
    const { settings } = loadSettingsDetailed()
    expect(settings.enabledSubscriptions).toEqual(['antigravity-ide', 'codex'])
    expect(settings.subscriptionOrder).toEqual(['antigravity-ide', 'codex'])
    expect(settings.subscriptionKeysVersion).toBe(SUBSCRIPTION_KEYS_VERSION)
  })

  it('leaves the app card of a document written since the split alone', () => {
    put(settingsDocument({ subscriptionKeysVersion: SUBSCRIPTION_KEYS_VERSION }))
    expect(loadSettingsDetailed().settings.enabledSubscriptions).toEqual(['antigravity', 'codex'])
  })

  it('renames once: reloading the saved result changes nothing', () => {
    put(settingsDocument())
    const first = loadSettingsDetailed().settings
    put(first)
    expect(loadSettingsDetailed().settings).toEqual(first)
  })

  it('keeps the app card a user adds after the upgrade', () => {
    put(settingsDocument())
    const upgraded = loadSettingsDetailed().settings
    put({ ...upgraded, enabledSubscriptions: [...upgraded.enabledSubscriptions, 'antigravity'] })
    expect(loadSettingsDetailed().settings.enabledSubscriptions).toEqual(['antigravity-ide', 'codex', 'antigravity'])
  })

  it('keeps a newer document’s version, so a later build does not rename again', () => {
    put(settingsDocument({ subscriptionKeysVersion: SUBSCRIPTION_KEYS_VERSION + 1 }))
    const { settings } = loadSettingsDetailed()
    expect(settings.subscriptionKeysVersion).toBe(SUBSCRIPTION_KEYS_VERSION + 1)
    expect(settings.enabledSubscriptions).toEqual(['antigravity', 'codex'])
  })

  it('seeds a document from before cards were selectable with all three cards', () => {
    put({ providers: {} })
    const { settings } = loadSettingsDetailed()
    expect(settings.enabledSubscriptions).toEqual(
      expect.arrayContaining(['antigravity-ide', 'antigravity', 'antigravity-cli']),
    )
  })

  it('treats a version too large for JSON as pre-split instead of passing it through', () => {
    // JSON.parse('1e400') is Infinity and JSON.stringify(Infinity) is null.
    // Passed through, such a document reads "current" on this load and
    // "pre-split" after it is saved — the next load would then rename a card.
    localStorage.setItem(
      KEY_V3,
      '{"providers":{},"enabledSubscriptions":["antigravity","codex"],"subscriptionKeysVersion":1e400}',
    )
    const { settings } = loadSettingsDetailed()
    expect(settings.enabledSubscriptions).toEqual(['antigravity-ide', 'codex'])
    expect(settings.subscriptionKeysVersion).toBe(SUBSCRIPTION_KEYS_VERSION)
    // Saved as a real number, so the next load sees the same document
    put(settings)
    expect(loadSettingsDetailed().settings.enabledSubscriptions).toEqual(['antigravity-ide', 'codex'])
  })
})

describe('renameAlertAccountKeys', () => {
  it('matches a whole account key, not a prefix of one', () => {
    saveAlerts([alertOf('kimi-0'), alertOf('kimir-0'), alertOf('kimi-10')])

    renameAlertAccountKeys({ 'kimi-0': 'kimi-intl-0' })

    // Only `kimi-0` is renamed; `kimir-0` and `kimi-10` merely contain `kimi`
    expect(loadAlerts().map((item) => item.id)).toEqual(['kimi-intl-0:high-usage:m1', 'kimir-0:high-usage:m1', 'kimi-10:high-usage:m1'])
    expect(loadAlerts().map((item) => item.accountKey)).toEqual(['kimi-intl-0', 'kimir-0', 'kimi-10'])
  })

  it('never leaves two alerts with the same id', () => {
    // An alert already filed under the new id collides with the renamed one
    saveAlerts([alertOf('kimi-0'), alertOf('kimi-intl-0'), alertOf('deepseek-0')])

    renameAlertAccountKeys({ 'kimi-0': 'kimi-intl-0' })

    expect(loadAlerts().map((item) => item.id)).toEqual(['kimi-intl-0:high-usage:m1', 'deepseek-0:high-usage:m1'])
  })

  it('leaves the stored list alone when no alert belongs to a renamed account', () => {
    saveAlerts([alertOf('deepseek-0')])
    renameAlertAccountKeys({ 'kimi-0': 'kimi-intl-0' })
    expect(loadAlerts()).toEqual([alertOf('deepseek-0')])
  })

  it('reports a list it could not write back', () => {
    const storage = stubStorage()
    saveAlerts([alertOf('zhipu-0')])
    storage.failWritesTo(ALERT_STORE)
    expect(renameAlertAccountKeys({ 'zhipu-0': 'zai-0' })).toBe(false)
  })
})

describe('remapSnapshotStore', () => {
  const snap = (t: number): AccountSnapshot => ({ t })

  it('returns the store untouched for an empty rename', () => {
    const store = { 'zhipu-0': [snap(1)] }
    expect(remapSnapshotStore(store, {})).toBe(store)
    expect(store).toEqual({ 'zhipu-0': [snap(1)] })
  })

  it('swaps keys without handing one account’s history to another', () => {
    const store = { 'zhipu-0': [snap(1)], 'zhipu-1': [snap(2)], 'deepseek-0': [snap(3)] }
    remapSnapshotStore(store, { 'zhipu-0': 'zai-0', 'zhipu-1': 'zhipu-0' })
    expect(store).toEqual({ 'zai-0': [snap(1)], 'zhipu-0': [snap(2)], 'deepseek-0': [snap(3)] })
  })

  it('ignores keys the store does not have', () => {
    const store = { 'kimi-3': [snap(1)] }
    remapSnapshotStore(store, { 'kimi-0': 'kimi-intl-0', 'kimi-1': 'kimi-0' })
    expect(store).toEqual({ 'kimi-3': [snap(1)] })
  })
})
