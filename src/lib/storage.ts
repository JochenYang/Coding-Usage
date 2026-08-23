import type { ProviderConfig, Settings } from '../types'

const KEY_V2 = 'coding-usage.settings.v2'
const KEY_V1 = 'coding-usage.settings.v1'

const DEFAULT_SETTINGS: Settings = { providers: {}, autoRefreshMin: 0 }

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
  }
}

export function loadSettings(): Settings {
  try {
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
    // ignore
  }
  return DEFAULT_SETTINGS
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY_V2, JSON.stringify(s))
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
