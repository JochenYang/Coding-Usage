import type { ProviderConfig, Settings } from '../types'

export const KEY_V3 = 'coding-usage.settings.v3'
const KEY_V2 = 'coding-usage.settings.v2'
const KEY_V1 = 'coding-usage.settings.v1'

/**
 * Marker prefix for safeStorage-encrypted API keys persisted under KEY_V3.
 * Must stay in sync with the constant used by the main process (electron/main.ts).
 */
export const ENC_PREFIX = 'enc:v3:'

const DEFAULT_SETTINGS: Settings = {
  providers: {},
  autoRefreshMin: 0,
  displayCurrency: 'CNY',
  usageDisplayMode: 'all',
}

function migrate(raw: unknown): Settings {
  const obj = (raw ?? {}) as Partial<Settings> & { providers?: Record<string, unknown> }
  const providers: Record<string, ProviderConfig[]> = {}
  for (const [id, value] of Object.entries(obj.providers ?? {})) {
    if (Array.isArray(value)) {
      providers[id] = value.filter((v): v is ProviderConfig => !!v && typeof v === 'object') as ProviderConfig[]
    } else if (value && typeof value === 'object') {
      providers[id] = [value as ProviderConfig]
    } else {
      providers[id] = []
    }
  }
  return {
    providers,
    autoRefreshMin: typeof obj.autoRefreshMin === 'number' ? obj.autoRefreshMin : 0,
    displayCurrency: typeof obj.displayCurrency === 'string' ? obj.displayCurrency : 'CNY',
    usageDisplayMode: obj.usageDisplayMode === 'no-cache' ? 'no-cache' : 'all',
  }
}


export function loadSettings(): Settings {
  // Corruption-tolerant cascade: fresh v3 → legacy v2 → v1 → defaults.
  // A broken v3 must NOT fall through to empty settings — v2 may still hold
  // the plaintext copy and a file mirror (via IPC) may exist too.
  try {
    const rawV3 = localStorage.getItem(KEY_V3)
    if (rawV3 && window.desktopBridge) {
      try {
        return migrate(JSON.parse(rawV3))
      } catch {
        // v3 is corrupt — fall through to v2 instead of losing accounts
      }
    }
    const rawV2 = localStorage.getItem(KEY_V2)
    if (rawV2) return migrate(JSON.parse(rawV2))
    const rawV1 = localStorage.getItem(KEY_V1)
    if (rawV1) {
      const migrated = migrate(JSON.parse(rawV1))
      // After upgrade, clear the legacy key and persist under the new key
      saveSettings(migrated)
      localStorage.removeItem(KEY_V1)
      return migrated
    }
  } catch {
    // ignore — file mirror (Electron) or defaults below
  }
  return DEFAULT_SETTINGS
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

/** True when at least one account key is still stored encrypted (pre-hydration state) */
export function hasEncryptedKeys(s: Settings): boolean {
  return Object.values(s.providers).some((entries) =>
    entries.some((e) => e.apiKey.startsWith(ENC_PREFIX)),
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
 */
export async function persistSettings(s: Settings): Promise<void> {
  try {
    const bridge = window.desktopBridge
    if (!bridge) {
      saveSettings(s)
      return
    }
    // Encrypt every non-empty plaintext key; already-prefixed keys pass through
    // untouched so re-persisting hydrated-but-unmodified data stays idempotent.
    const out: Settings = { ...s, providers: {} }
    let cryptoOk = true
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

export function getEntryConfig(s: Settings, id: string, index: number): ProviderConfig | undefined {
  return s.providers[id]?.[index]
}

/** Shallow value equality for a ProviderConfig array */
export function isSameEntry(a: ProviderConfig | undefined, b: ProviderConfig | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.enabled === b.enabled && a.apiKey === b.apiKey && a.regionId === b.regionId && a.label === b.label
}
