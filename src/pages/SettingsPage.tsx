import { useRef } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/beui/select'
import { useTheme, type ThemeMode } from '@/components/ThemeProvider'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { KNOWN_CURRENCIES } from '@/lib/rates'
import { clearSnapshots, getSnapshots, type AccountSnapshot } from '@/lib/snapshots'
import type { ProviderConfig } from '@/types'

export interface SettingsPageProps {
  className?: string
}

// App version. Kept as a literal because tsconfig.json does not enable
// resolveJsonModule, so `import pkg from '../../package.json'` would fail
// type-checking; bump alongside package.json.
const APP_VERSION = '0.1.0'

// Storage key of the local time-series store; must stay in sync with the
// private KEY constant in src/lib/snapshots.ts (snapshots.ts is not modified).
const SNAPSHOT_KEY = 'coding-usage.snapshots.v1'

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

/** Label + control row shared by every settings section */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-foreground">{label}</span>
      {children}
    </div>
  )
}

/**
 * Migrate a raw settings payload into the strict Settings field shape, the
 * same rules as storage.ts's private migrate(). Scalar fields are null when
 * absent so the caller can merge without clobbering current values.
 * Returns null when the providers record is missing or malformed.
 */
function migrateSettings(
  raw: unknown,
): {
  providers: Record<string, ProviderConfig[]>
  autoRefreshMin: number | null
  displayCurrency: string | null
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (!obj.providers || typeof obj.providers !== 'object' || Array.isArray(obj.providers)) return null

  const providers: Record<string, ProviderConfig[]> = {}
  for (const [id, value] of Object.entries(obj.providers as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      providers[id] = value.filter((v): v is ProviderConfig => !!v && typeof v === 'object')
    } else if (value && typeof value === 'object') {
      providers[id] = [value as ProviderConfig]
    } else {
      providers[id] = []
    }
  }
  return {
    providers,
    autoRefreshMin: typeof obj.autoRefreshMin === 'number' ? obj.autoRefreshMin : null,
    displayCurrency: typeof obj.displayCurrency === 'string' ? obj.displayCurrency : null,
  }
}

/** Per-account snapshot cap; mirrors MAX_PER_ACCOUNT in src/lib/snapshots.ts */
const MERGE_CAP = 2_000

/**
 * Merge imported snapshots into the localStorage store under the same key
 * snapshots.ts uses. Entries are validated (numeric `t` required) and
 * union-merged by timestamp — an older backup must never clobber newer local
 * history for the same account. Returns the number of account keys written.
 */
function mergeSnapshots(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0

  let store: Record<string, AccountSnapshot[]> = {}
  try {
    const existing = localStorage.getItem(SNAPSHOT_KEY)
    if (existing) store = JSON.parse(existing) as Record<string, AccountSnapshot[]>
  } catch {
    // corrupted store → start from empty, same as snapshots.ts
  }
  if (store == null || typeof store !== 'object' || Array.isArray(store)) store = {}

  let count = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const merged = new Map<number, AccountSnapshot>()
    for (const s of store[key] ?? []) merged.set(s.t, s) // existing history wins ties
    for (const s of value) {
      if (!!s && typeof s === 'object' && typeof (s as AccountSnapshot).t === 'number') {
        merged.set((s as AccountSnapshot).t, s as AccountSnapshot)
      }
    }
    const list = [...merged.values()].sort((a, b) => a.t - b.t).slice(-MERGE_CAP)
    if (list.length === 0) continue
    store[key] = list
    count++
  }

  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(store))
  } catch {
    // quota exceeded → best-effort, mirrors saveStore in snapshots.ts
  }
  return count
}

/** System settings page: appearance, refresh cadence, data backup, about */
export function SettingsPage({ className }: SettingsPageProps) {
  const t = useT()
  const { theme, setTheme } = useTheme()
  const { settings, updateSettings } = useData()
  const fileRef = useRef<HTMLInputElement>(null)

  // Auto-refresh options mirror TopBar's autoOptions; numeric values stay
  // stable across locales so settings.autoRefreshMin migration is unaffected.
  const autoOptions: { value: number; label: string }[] = [
    { value: 0, label: t.autoRefresh.manual },
    { value: 0.25, label: t.autoRefresh.sec15 },
    { value: 0.5, label: t.autoRefresh.sec30 },
    { value: 1, label: t.autoRefresh.min1 },
    { value: 3, label: t.autoRefresh.min3 },
    { value: 5, label: t.autoRefresh.min5 },
    { value: 15, label: t.autoRefresh.min15 },
    { value: 30, label: t.autoRefresh.min30 },
  ]

  const handleExport = () => {
    // One snapshot list per configured account slot, keyed "providerId-index"
    // exactly like data-context's card keys.
    const snapshots: Record<string, AccountSnapshot[]> = {}
    for (const [pid, entries] of Object.entries(settings.providers)) {
      entries.forEach((_entry, i) => {
        snapshots[`${pid}-${i}`] = getSnapshots(`${pid}-${i}`)
      })
    }
    const payload = {
      app: 'coding-usage',
      exportedAt: new Date().toISOString(),
      settings,
      snapshots,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'coding-usage-backup.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file after a fix
    if (!file) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      window.alert(t.prefs.importBad)
      return
    }

    const wrapper = (parsed ?? {}) as Record<string, unknown>
    const migrated = migrateSettings(wrapper.settings ?? parsed)
    if (!migrated) {
      window.alert(t.prefs.importBad)
      return
    }

    // Merge imported fields over current settings; absent scalars keep theirs
    updateSettings({
      providers: { ...settings.providers, ...migrated.providers },
      autoRefreshMin: migrated.autoRefreshMin ?? settings.autoRefreshMin,
      displayCurrency: migrated.displayCurrency ?? settings.displayCurrency,
    })
    mergeSnapshots(wrapper.snapshots)
  }

  const handleClear = () => {
    if (window.confirm(t.prefs.clearConfirm)) clearSnapshots()
  }

  return (
    <div className={cn('space-y-6', className)}>
      <PageHeader title={t.pages.settingsTitle} description={t.pages.settingsHint} />

      {/* Appearance */}
      <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t.prefs.appearance}</h2>

        <SettingRow label={t.prefs.theme}>
          <div className="flex items-center gap-1.5">
            {THEME_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setTheme(mode)}
                aria-pressed={theme === mode}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs',
                  theme === mode
                    ? 'bg-accent text-white'
                    : 'border border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {t.header.theme[mode]}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label={t.prefs.language}>
          <LocaleSwitcher />
        </SettingRow>
      </section>

      {/* Refresh */}
      <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t.prefs.refresh}</h2>

        <SettingRow label={t.prefs.refreshInterval}>
          <Select
            value={String(settings.autoRefreshMin)}
            onValueChange={(v) => updateSettings({ ...settings, autoRefreshMin: Number(v) })}
          >
            <SelectTrigger className="w-32 rounded-lg border-border bg-card px-3 py-1.5 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {autoOptions.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </section>

      {/* Data */}
      <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t.prefs.data}</h2>

        <SettingRow label={t.prefs.displayCurrency}>
          <Select
            value={settings.displayCurrency}
            onValueChange={(v) => updateSettings({ ...settings, displayCurrency: v })}
          >
            <SelectTrigger className="w-28 rounded-lg border-border bg-card px-3 py-1.5 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KNOWN_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">{t.prefs.exportHint}</p>
            <p className="text-xs text-muted-foreground">{t.prefs.importHint}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              {t.prefs.exportData}
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              {t.prefs.importData}
            </button>
            {/* Hidden picker: keeps import styling on the visible button */}
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => void handleImportFile(e)}
              className="hidden"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleClear}
            className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10"
          >
            {t.prefs.clearSnapshots}
          </button>
        </div>
      </section>

      {/* About */}
      <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t.prefs.about}</h2>

        {/* App name as the card's identity line */}
        <div className="text-sm font-medium text-foreground">{t.app.title}</div>

        <SettingRow label={t.prefs.version}>
          <span className="text-xs text-muted-foreground">{APP_VERSION}</span>
        </SettingRow>
      </section>
    </div>
  )
}
