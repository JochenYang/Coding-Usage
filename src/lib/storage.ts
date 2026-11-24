import type { ProviderConfig, Settings } from '../types'
import { DEFAULT_ALERT_THRESHOLDS, renameAlertAccountKeys, resolveThresholds } from './alerts'
import { DEFAULT_ENABLED_SUBSCRIPTIONS, isKnownSubscriptionKey } from './subscription-cards'
import { dropCachedResults } from './startup-cache'
import { renameSnapshotKeys } from './snapshots'

export const KEY_V3 = 'coding-usage.settings.v3'
const KEY_V2 = 'coding-usage.settings.v2'
const KEY_V1 = 'coding-usage.settings.v1'

/**
 * Marker prefix for safeStorage-encrypted API keys persisted under KEY_V3.
 * Must stay in sync with the constant used by the main process (electron/main.ts).
 */
export const ENC_PREFIX = 'enc:v3:'

/**
 * Subscription-card key set a settings document was written for. Version 1 is
 * the split of the Antigravity card into IDE / app / CLI: before it,
 * `antigravity` was the IDE card; from it on, `antigravity` is the app and the
 * IDE card is `antigravity-ide`.
 *
 * The marker travels inside the document rather than beside it, so a rename
 * and its write-back succeed or fail together. A marker kept elsewhere could
 * be written while the document still holds the old key — and because
 * `antigravity` is a valid key again (the app), a document that is not known
 * to be pre-split must never be renamed: that would turn a user's app card
 * back into the IDE card on every load.
 */
export const SUBSCRIPTION_KEYS_VERSION = 1

/** Card keys as they were before the current key-set version, by old key */
const LEGACY_SUBSCRIPTION_KEYS: Record<string, string> = {
  antigravity: 'antigravity-ide',
}

/**
 * `obj.subscriptionKeysVersion`, with a missing or malformed one read as
 * "pre-split". A number that JSON cannot carry back — `Infinity` is stored as
 * `null` — counts as malformed: letting it through would mark a document
 * "current" in memory and "pre-split" after the next load, and rename a card
 * the user had just enabled.
 */
export function subscriptionKeysVersionOf(obj: unknown): number {
  const version = (obj as { subscriptionKeysVersion?: unknown } | null)?.subscriptionKeysVersion
  return typeof version === 'number' && Number.isFinite(version) ? version : 0
}

/** Rewrite card keys a document written before the current key-set version uses */
function renameLegacySubscriptionKeys(keys: string[]): string[] {
  const out: string[] = []
  for (const key of keys) {
    const renamed = LEGACY_SUBSCRIPTION_KEYS[key] ?? key
    // An order list may already name the new key: keep the first position
    if (!out.includes(renamed)) out.push(renamed)
  }
  return out
}

/**
 * The renamer a settings document's own key-set version calls for. The
 * startup load and the backup import both go through here, so the two cannot
 * drift into renaming different documents.
 */
export function subscriptionKeyRenamer(obj: unknown): (keys: string[]) => string[] {
  return subscriptionKeysVersionOf(obj) < SUBSCRIPTION_KEYS_VERSION
    ? renameLegacySubscriptionKeys
    : (keys: string[]): string[] => keys
}

const DEFAULT_SETTINGS: Settings = {
  providers: {},
  autoRefreshMin: 0,
  displayCurrency: 'CNY',
  usageDisplayMode: 'all',
  desktopIsland: true,
  planOrder: [],
  subscriptionOrder: [],
  enabledSubscriptions: [],
  subscriptionKeysVersion: SUBSCRIPTION_KEYS_VERSION,
  alertThresholds: { ...DEFAULT_ALERT_THRESHOLDS, lowBalance: { ...DEFAULT_ALERT_THRESHOLDS.lowBalance } },
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

/**
 * Integration fields that hold credentials (webhook URLs embed secret keys,
 * tokens are secrets outright). Encrypted exactly like provider API keys;
 * telegramChatId / weixinBotUserId are deliberately absent — they are
 * useless without their token, so they stay plaintext for simpler diffing.
 */
export const SECRET_INTEGRATION_FIELDS = [
  'wecomWebhook',
  'feishuWebhook',
  'feishuSecret',
  'dingtalkWebhook',
  'dingtalkSecret',
  'discordWebhook',
  'slackWebhook',
  'barkKey',
  'ntfyTopic',
  'telegramBotToken',
  'weixinBotToken',
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Providers that used to cover two sites through a `regionId` on each account
 * (the China site unless it was `intl`), mapped to the provider that took
 * over their international accounts when they were split. The two sites are
 * separate accounts with separate subscriptions, so each is its own entry in
 * the add-account menu now. The domestic provider keeps its id, which is why
 * the China accounts do not move.
 */
const SPLIT_SITE_PROVIDERS = {
  zhipu: 'zai',
  kimi: 'kimi-intl',
  siliconflow: 'siliconflow-intl',
  minimax: 'minimax-intl',
} as const

/**
 * Which account-keyed stores the split has already been applied to, as a
 * `+`-joined list (e.g. `results+snapshots+alerts`). The account move itself
 * is recomputed on every load (it is idempotent), but what is done to the
 * stores keyed by account must happen at most once per store: by a later
 * launch an old key may belong to a newly added account, and moving or
 * dropping it again would hit that account instead of the one the split was
 * about. So each store is recorded the moment its step is on disk, and a
 * store whose write failed is the only one retried.
 */
const SPLIT_APPLIED_KEY = 'coding-usage.split-site-accounts.v1'

/** What the pre-split migration did to one providers record. */
export interface ProviderSplit {
  /**
   * Providers an international account left. The readings cached under their
   * old indexes are stale — shifted onto another account, or orphaned until
   * a new account takes the index — so they have to be dropped.
   */
  reindexed: string[]
  /** `oldKey → newKey` for every account whose key the split changed */
  renamed: Record<string, string>
}

function withoutRegion(entry: ProviderConfig): ProviderConfig {
  const next = { ...entry }
  delete next.regionId
  return next
}

/**
 * Move accounts saved under the pre-split providers to the split ones: the
 * international accounts (`regionId === 'intl'`) go to the provider named in
 * {@link SPLIT_SITE_PROVIDERS}, behind any account already saved there; the
 * rest stay put; and the region field — meaningless on a single-site
 * provider — is dropped from both sides. Returns what the move changed.
 *
 * Idempotent: once no account carries a region there is nothing to move.
 */
function splitLegacyRegionAccounts(providers: Record<string, ProviderConfig[]>): ProviderSplit {
  const reindexed: string[] = []
  const renamed: Record<string, string> = {}
  for (const [domestic, international] of Object.entries(SPLIT_SITE_PROVIDERS)) {
    const legacy = providers[domestic] ?? []
    if (!legacy.some((entry) => entry.regionId != null)) continue
    const moved = legacy.filter((entry) => entry.regionId === 'intl')
    const kept = legacy.filter((entry) => entry.regionId !== 'intl')
    const settled = (providers[international] ?? []).map(withoutRegion)
    providers[domestic] = kept.map(withoutRegion)
    providers[international] = [...settled, ...moved.map(withoutRegion)]
    // Nothing left the list, so no account's index changed: only the region
    // field was dropped and no key needs renaming.
    if (moved.length === 0) continue
    let keptIndex = 0
    let movedIndex = 0
    legacy.forEach((entry, index) => {
      const isMoved = entry.regionId === 'intl'
      const next = isMoved ? `${international}-${settled.length + movedIndex++}` : `${domestic}-${keptIndex++}`
      if (next !== `${domestic}-${index}`) renamed[`${domestic}-${index}`] = next
    })
    // Every key the moved accounts held under this provider is now stale: a
    // kept account may have shifted onto one, and one left behind with no
    // account behind it would surface the moment a new account takes its index.
    reindexed.push(domestic)
  }
  return { reindexed, renamed }
}

/**
 * Normalize a stored providers record into account lists and move any account
 * saved before the split-site providers were split. Accounts arrive as a
 * list, or as a single object in an older format; anything else — including
 * a non-object entry — is not an account and is dropped. This is the one
 * entry point both the startup load and the settings-backup import go through,
 * so an imported document can never skip the move.
 */
export function normalizeProviders(raw: unknown): { providers: Record<string, ProviderConfig[]>; split: ProviderSplit } {
  const isAccount = (entry: unknown): entry is ProviderConfig => isObject(entry)
  const providers: Record<string, ProviderConfig[]> = {}
  if (isObject(raw)) {
    for (const [id, value] of Object.entries(raw)) {
      const entries = Array.isArray(value) ? value : isObject(value) ? [value] : []
      providers[id] = entries.filter(isAccount)
    }
  }
  return { providers, split: splitLegacyRegionAccounts(providers) }
}

/** Settings plus what loading them did to the accounts. */
export interface LoadedSettings {
  settings: Settings
  split: ProviderSplit
}

/**
 * Bring the data that is keyed by account along with a split. Cached readings
 * of a re-indexed provider are dropped (they would paint one account's
 * numbers on another's card); history and alert state are renamed to the new
 * keys, so nothing is lost and nothing is attributed to the wrong account.
 * Each of the three stores is handled once per machine — see
 * {@link SPLIT_APPLIED_KEY}.
 */
function applySplitToStoredData(split: ProviderSplit): void {
  // Nothing was renamed, so no account was moved and there is nothing to do
  if (Object.keys(split.renamed).length === 0) return

  const applied = new Set((localStorage.getItem(SPLIT_APPLIED_KEY) ?? '').split('+').filter(Boolean))
  const steps: Array<[store: string, run: () => boolean]> = [
    [
      'results',
      () => {
        for (const id of split.reindexed) dropCachedResults(id)
        // Dropping is keyed lookups and a rewrite of a cache: nothing to fail
        return true
      },
    ],
    ['snapshots', () => renameSnapshotKeys(split.renamed)],
    ['alerts', () => renameAlertAccountKeys(split.renamed)],
  ]
  for (const [store, run] of steps) {
    if (applied.has(store)) continue
    // A failed write leaves this store unrecorded: the next launch retries it,
    // and only it. Stop here so no later store gets ahead of an unrecorded one.
    if (!run()) return
    applied.add(store)
    try {
      localStorage.setItem(SPLIT_APPLIED_KEY, [...applied].join('+'))
    } catch {
      // The step is on disk but not recorded, so the next launch repeats it;
      // that finds nothing to move unless an old key was reused by then.
      return
    }
  }
}

function migrate(raw: unknown): LoadedSettings {
  const obj = (raw ?? {}) as Partial<Settings> & { providers?: Record<string, unknown> }
  const { providers, split } = normalizeProviders(obj.providers)
  const intg = obj.integrations
  // Only a document that predates the split still carries the old key; one
  // written since may hold `antigravity` as the app card, which must stay.
  const renameKeys = subscriptionKeyRenamer(obj)
  const settings: Settings = {
    providers,
    autoRefreshMin: typeof obj.autoRefreshMin === 'number' ? obj.autoRefreshMin : 0,
    displayCurrency: typeof obj.displayCurrency === 'string' ? obj.displayCurrency : 'CNY',
    usageDisplayMode: obj.usageDisplayMode === 'no-cache' ? 'no-cache' : 'all',
    desktopIsland: obj.desktopIsland !== false,
    // A card order saved by another build may hold keys this one no longer
    // renders; keeping them is harmless (they are filtered out at render) and
    // lets the order survive a provider being removed and added back.
    planOrder: Array.isArray(obj.planOrder)
      ? obj.planOrder.filter((key): key is string => typeof key === 'string')
      : [],
    subscriptionOrder: Array.isArray(obj.subscriptionOrder)
      ? renameKeys(obj.subscriptionOrder.filter((key): key is string => typeof key === 'string'))
      : [],
    // Absent on an older install: it already showed every non-experimental
    // card, so seeding that set is the only change-free upgrade. A fresh
    // install never reaches migrate() and keeps the empty default.
    enabledSubscriptions: Array.isArray(obj.enabledSubscriptions)
      ? renameKeys(obj.enabledSubscriptions.filter((key): key is string => typeof key === 'string')).filter(
          (key) => isKnownSubscriptionKey(key),
        )
      : [...DEFAULT_ENABLED_SUBSCRIPTIONS],
    // A document from a newer build keeps its (higher) version: writing this
    // build's number would make it look pre-split to that build.
    subscriptionKeysVersion: Math.max(SUBSCRIPTION_KEYS_VERSION, subscriptionKeysVersionOf(obj)),
    alertThresholds: resolveThresholds(obj.alertThresholds),
    integrations: {
      alertPush: intg?.alertPush === true,
      wecomWebhook: typeof intg?.wecomWebhook === 'string' ? intg.wecomWebhook : '',
      feishuWebhook: typeof intg?.feishuWebhook === 'string' ? intg.feishuWebhook : '',
      feishuSecret: typeof intg?.feishuSecret === 'string' ? intg.feishuSecret : '',
      dingtalkWebhook: typeof intg?.dingtalkWebhook === 'string' ? intg.dingtalkWebhook : '',
      dingtalkSecret: typeof intg?.dingtalkSecret === 'string' ? intg.dingtalkSecret : '',
      discordWebhook: typeof intg?.discordWebhook === 'string' ? intg.discordWebhook : '',
      slackWebhook: typeof intg?.slackWebhook === 'string' ? intg.slackWebhook : '',
      barkServer: typeof intg?.barkServer === 'string' ? intg.barkServer : '',
      barkKey: typeof intg?.barkKey === 'string' ? intg.barkKey : '',
      ntfyServer: typeof intg?.ntfyServer === 'string' ? intg.ntfyServer : '',
      ntfyTopic: typeof intg?.ntfyTopic === 'string' ? intg.ntfyTopic : '',
      telegramBotToken: typeof intg?.telegramBotToken === 'string' ? intg.telegramBotToken : '',
      telegramChatId: typeof intg?.telegramChatId === 'string' ? intg.telegramChatId : '',
      weixinBotToken: typeof intg?.weixinBotToken === 'string' ? intg.weixinBotToken : '',
      weixinBotUserId: typeof intg?.weixinBotUserId === 'string' ? intg.weixinBotUserId : '',
    },
  }
  return { settings, split }
}

/** Parse one stored settings document and bring account-keyed data along with any split. */
function parseStored(rawText: string): LoadedSettings {
  const loaded = migrate(JSON.parse(rawText))
  applySplitToStoredData(loaded.split)
  return loaded
}

export function loadSettingsDetailed(): LoadedSettings {
  // Corruption-tolerant cascade: v3 → legacy v2 → v1 → defaults. A key that is
  // missing or holds no settings document is skipped at every step, counted
  // exactly as `needsMirrorRecovery` counts it: a key this path cannot load
  // must not look like "nothing to recover" there, or the empty defaults
  // returned here would be saved over the mirror that still has the accounts.
  const hasBridge = typeof window !== 'undefined' && !!window.desktopBridge
  try {
    for (const key of [KEY_V3, KEY_V2, KEY_V1]) {
      // v3 is only ever written under a bridge; without one it is not this
      // build's document to read
      if (key === KEY_V3 && !hasBridge) continue
      const raw = readStored(key)
      if (!isSettingsDocument(raw)) continue
      try {
        const loaded = parseStored(raw)
        if (key === KEY_V1) {
          // After upgrade, clear the legacy key and persist under the new key
          saveSettings(loaded.settings)
          localStorage.removeItem(KEY_V1)
        }
        return loaded
      } catch {
        // Not loadable after all: the next key gets its chance
      }
    }
  } catch {
    // ignore — file mirror (Electron) or defaults below
  }
  return { settings: DEFAULT_SETTINGS, split: { reindexed: [], renamed: {} } }
}

/**
 * The settings on disk. A caller that has already read the results cache into
 * memory — anything past the first render — wants {@link loadSettingsDetailed}
 * instead, so it can drop what the split re-indexed from its own copy too.
 */
export function loadSettings(): Settings {
  return loadSettingsDetailed().settings
}

/**
 * True when this launch has a desktop bridge but no settings document in
 * localStorage — a wiped or corrupt leveldb — so the file mirror may hold the
 * only copy of the accounts. Everything that persists has to wait until the
 * mirror has been read back: the settings in memory are the empty defaults
 * until then, and saving them would replace that only copy.
 */
export function needsMirrorRecovery(hasBridge: boolean): boolean {
  if (!hasBridge) return false
  return ![KEY_V3, KEY_V2, KEY_V1].some((key) => isSettingsDocument(readStored(key)))
}

/** The value stored under `key`, or null when storage will not say. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // Reading storage itself failed (a broken leveldb): nothing can be loaded
    // from it either, so the mirror is what is left
    return null
  }
}

/**
 * Whether `raw` is a settings document — what decides if a launch has
 * anything to load. A key that is there but holds no document (a torn write,
 * a blank value) is as good as missing: the load path answers the defaults
 * for it, and only the mirror still has the accounts.
 */
function isSettingsDocument(raw: string | null): raw is string {
  if (!raw) return false
  try {
    return isObject(JSON.parse(raw))
  } catch {
    return false
  }
}

export type MirrorRestore = 'restored' | 'absent' | 'empty' | 'corrupt'

/**
 * Put a settings document read from the file mirror back into localStorage.
 * `absent` when there is no mirror (a fresh install), `empty` for a blank
 * file — what an interrupted plain write leaves behind — and `corrupt` when
 * what was read is not a settings document; storage is left untouched in all
 * three cases, so a damaged mirror never replaces the defaults with garbage.
 * The document is stored as it is — its accounts are then loaded, split-moved
 * and decrypted like those of any other launch.
 */
export function restoreSettingsDocument(backup: unknown): MirrorRestore {
  if (typeof backup !== 'string') return 'absent'
  // utf8 decoding keeps a byte-order mark; an editor that touched the file
  // can leave one, and JSON.parse would then reject the document
  const document = backup.replace(/^\uFEFF/, '')
  if (document.trim() === '') return 'empty'
  if (!isSettingsDocument(document)) return 'corrupt'
  localStorage.setItem(KEY_V3, document)
  return 'restored'
}

export function saveSettings(s: Settings): void {
  // Best-effort persistence: quota-full / private-mode must not crash the
  // settings effect (an uncaught throw here would blank the app on boot).
  try {
    localStorage.setItem(KEY_V2, JSON.stringify(s))
  } catch {
    // ignore — in-memory state stays authoritative for this session
  }
}

/** True when at least one secret is still stored encrypted (pre-hydration state) */
export function hasEncryptedKeys(s: Settings): boolean {
  return (
    Object.values(s.providers).some((entries) =>
      entries.some((e) => e.apiKey.startsWith(ENC_PREFIX)),
    ) || SECRET_INTEGRATION_FIELDS.some((f) => s.integrations[f].startsWith(ENC_PREFIX))
  )
}

/** True while the legacy plaintext store still exists (pre-v3-migration marker) */
export function hasLegacyV2Store(): boolean {
  return localStorage.getItem(KEY_V2) != null
}

/**
 * Persist settings. Under Electron with a working safeStorage, every non-empty
 * API key is encrypted (DPAPI-backed) into KEY_V3; the write is verified by
 * decrypting each ciphertext back, and only after full verification is the
 * plaintext KEY_V2 removed. Without a bridge (or when encryption is
 * unavailable) it degrades to the unchanged plaintext KEY_V2 write.
 *
 * Async and fire-and-forget safe: never throws, all failures are contained.
 * Calls are serialized through a module-level promise chain: two overlapping
 * settings writes must never interleave their encrypt/verify IPC rounds, or
 * the older snapshot could land after the newer one.
 */
let persistChain: Promise<void> = Promise.resolve()

export function persistSettings(s: Settings): Promise<void> {
  const run = persistChain.then(() => persistSettingsInner(s))
  // Keep the chain alive regardless of individual failures
  persistChain = run.catch(() => {})
  return run
}

async function persistSettingsInner(s: Settings): Promise<void> {
  try {
    const bridge = window.desktopBridge
    if (!bridge) {
      saveSettings(s)
      return
    }
    // Encrypt every non-empty plaintext key; already-prefixed keys pass through
    // untouched so re-persisting hydrated-but-unmodified data stays idempotent.
    const out: Settings = { ...s, providers: {}, integrations: s.integrations }
    let cryptoOk = true
    // Integration credentials (webhook URLs / tokens / SendKeys) get the same
    // encryption treatment as provider API keys
    for (const field of SECRET_INTEGRATION_FIELDS) {
      const src = s.integrations[field]
      if (!src || src.startsWith(ENC_PREFIX)) continue
      let enc: string | null = null
      try {
        enc = await bridge.encrypt(src)
      } catch {
        enc = null
      }
      if (!enc) {
        cryptoOk = false
        break
      }
      out.integrations = { ...out.integrations, [field]: enc }
    }
    if (!cryptoOk) {
      saveSettings(s)
      return
    }
    for (const [id, entries] of Object.entries(s.providers)) {
      const list: ProviderConfig[] = []
      for (const entry of entries) {
        if (!entry.apiKey || entry.apiKey.startsWith(ENC_PREFIX)) {
          list.push(entry)
          continue
        }
        let enc: string | null = null
        try {
          enc = await bridge.encrypt(entry.apiKey)
        } catch {
          enc = null
        }
        // Null means safeStorage is unavailable (e.g. Linux without a keyring)
        if (!enc) {
          cryptoOk = false
          break
        }
        list.push({ ...entry, apiKey: enc })
      }
      if (!cryptoOk) break
      out.providers[id] = list
    }
    if (!cryptoOk) {
      saveSettings(s)
      return
    }
    localStorage.setItem(KEY_V3, JSON.stringify(out))
    // Round-trip verification ("write new, verify, then remove old"): every
    // field encrypted in this pass must decrypt back to its source key.
    let verified = true
    for (const field of SECRET_INTEGRATION_FIELDS) {
      const src = s.integrations[field]
      if (!src || src.startsWith(ENC_PREFIX)) continue
      let dec: string | null = null
      try {
        dec = await bridge.decrypt(out.integrations[field])
      } catch {
        dec = null
      }
      if (dec !== src) {
        verified = false
        break
      }
    }
    for (const [id, entries] of Object.entries(s.providers)) {
      const stored = out.providers[id]
      for (let i = 0; i < entries.length; i++) {
        const src = entries[i].apiKey
        // Pre-existing ciphertext was verified by an earlier write already
        if (!src || src.startsWith(ENC_PREFIX)) continue
        let dec: string | null = null
        try {
          dec = await bridge.decrypt(stored[i]?.apiKey ?? '')
        } catch {
          dec = null
        }
        if (dec !== src) {
          verified = false
          break
        }
      }
      if (!verified) break
    }
    if (!verified) {
      console.warn('[storage] v3 round-trip verify failed; keeping plaintext v2 key')
      return
    }
    // Verified: the plaintext fallback is now redundant
    if (hasLegacyV2Store()) localStorage.removeItem(KEY_V2)
  } catch {
    // Never let persistence errors escape — callers use fire-and-forget
  }
}

export function getProviderEntries(s: Settings, id: string): ProviderConfig[] {
  return s.providers[id] ?? []
}

/** Shallow value equality for a ProviderConfig array */
export function isSameEntry(a: ProviderConfig | undefined, b: ProviderConfig | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.enabled === b.enabled && a.apiKey === b.apiKey && a.regionId === b.regionId && a.label === b.label
}
