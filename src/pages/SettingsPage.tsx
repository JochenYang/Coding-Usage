import { useEffect, useRef, useState } from 'react'
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
import { ConfirmDialog } from '@/components/beui/confirm-dialog'
import { GitHubIcon } from '@/components/logos/GitHubIcon'
import { Tooltip } from '@/components/common/Tooltip'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { KNOWN_CURRENCIES } from '@/lib/rates'
import { clearSnapshots, getSnapshots, remapSnapshotStore, type AccountSnapshot } from '@/lib/snapshots'
import { mergeImportedSettings, readImportedSettings } from '@/lib/settings-import'
import { getUsageHistoryStats, purgeUsageHistory } from '@/lib/usage-store'
import type { IntegrationsSettings, ProviderConfig } from '@/types'

export interface SettingsPageProps {
  className?: string
}

// Injected by electron-vite's renderer `define` from package.json — always in
// sync with the release version, no manual bumping.
const APP_VERSION = __APP_VERSION__

/** Public project repository linked from Settings → About */
const REPO_URL = 'https://github.com/JochenYang/Coding-Usage'

/** Live auto-update state, driven by the main process's status events */
function useUpdateState(): {
  update: DesktopUpdateState | null
  updateText: string
  setUpdate: (s: DesktopUpdateState) => void
} {
  const t = useT()
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null)

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    return bridge.onUpdateStatus(setUpdate)
  }, [])

  let updateText: string
  if (!update) {
    updateText = t.prefs.updates.hint
  } else {
    switch (update.status) {
      case 'checking':
        updateText = t.prefs.updates.checking
        break
      case 'not-available':
        updateText = t.prefs.updates.upToDate
        break
      case 'available':
        updateText = t.prefs.updates.available(update.version ?? '')
        break
      case 'downloading':
        updateText = t.prefs.updates.downloading(update.percent ?? 0)
        break
      case 'downloaded':
        updateText = t.prefs.updates.downloaded(update.version ?? '')
        break
      case 'error':
        updateText = update.message === 'dev' ? t.prefs.updates.devMode : t.prefs.updates.error
        break
      default:
        updateText = t.prefs.updates.hint
    }
    if (update.mirror && update.status !== 'error') {
      updateText += ` · ${t.prefs.updates.via(update.mirror)}`
    }
  }
  return { update, updateText, setUpdate }
}

/** Purge scopes offered by the settings page: day counts, plus "everything" */
const PURGE_SCOPES = [30, 90, 180, 365] as const

/**
 * Local agent usage history: the stored range plus the purge control.
 *
 * The history lives in the main process (electron/usage-store.ts), so this hook
 * is all the settings page needs to know about it. `stats` stays null when the
 * store is unavailable — the browser build, or a failed IPC — and the section is
 * hidden rather than offering a control whose effect cannot be confirmed.
 */
function useUsageHistory() {
  const t = useT()
  const { refreshAgentUsage } = useData()
  const [stats, setStats] = useState<UsageHistoryStats | null>(null)
  /** Chosen scope: a day count, or 'all' for the whole history */
  const [scope, setScope] = useState('90')
  const [confirming, setConfirming] = useState(false)
  const [purging, setPurging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getUsageHistoryStats().then((next) => {
      if (!cancelled) setStats(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const purge = async () => {
    setConfirming(false)
    setPurging(true)
    try {
      const result = await purgeUsageHistory(scope === 'all' ? null : Number(scope))
      if (!result) {
        // The one destructive control in the app must never fail silently
        setNotice(t.prefs.purgeFailed)
        return
      }
      setStats(result.stats)
      setNotice(t.prefs.purgeDone(result.removed))
      // The main process dropped its cached scan, so this re-merges from what
      // actually remains. Without it the usage pages would keep showing the
      // deleted days until the next scheduled refresh.
      void refreshAgentUsage()
    } finally {
      setPurging(false)
    }
  }

  return { stats, scope, setScope, confirming, setConfirming, purging, notice, purge }
}

// Storage key of the local time-series store; must stay in sync with the
// private KEY constant in src/lib/snapshots.ts.
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

/** Per-account snapshot cap; mirrors MAX_PER_ACCOUNT in src/lib/snapshots.ts */
const MERGE_CAP = 2_000

/** The account → snapshot lists of an imported backup; anything else reads as empty. */
function snapshotListsOf(raw: unknown): Record<string, AccountSnapshot[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const lists: Record<string, AccountSnapshot[]> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) lists[key] = value as AccountSnapshot[]
  }
  return lists
}

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
  const { settings, updateSettings, refreshAll, dropAccountResults } = useData()
  const { update, updateText, setUpdate } = useUpdateState()
  const history = useUsageHistory()
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
    // Credentials never leave the machine in plaintext (AGENTS.md hard rule):
    // strip API keys and the webhook/bot secrets from the exported copy. The
    // import path still accepts old backups that carry keys, so existing
    // backups keep working; after importing a stripped export the user
    // re-enters their keys.
    const safeProviders: Record<string, ProviderConfig[]> = {}
    for (const [pid, entries] of Object.entries(settings.providers)) {
      safeProviders[pid] = entries.map((entry) => ({ ...entry, apiKey: '' }))
    }
    const safeIntegrations: IntegrationsSettings = {
      ...settings.integrations,
      // Webhook URLs embed the channel key; telegram/weixin bot tokens are
      // credentials. Chat id / user id are not secrets and are kept.
      wecomWebhook: '',
      feishuWebhook: '',
      telegramBotToken: '',
      weixinBotToken: '',
    }
    const payload = {
      app: 'coding-usage',
      exportedAt: new Date().toISOString(),
      settings: { ...settings, providers: safeProviders, integrations: safeIntegrations },
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
    setImportError(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      setImportError(t.prefs.importBad)
      return
    }

    const wrapper = (parsed ?? {}) as Record<string, unknown>
    const imported = readImportedSettings(wrapper.settings ?? parsed)
    if (!imported) {
      setImportError(t.prefs.importBad)
      return
    }

    updateSettings(mergeImportedSettings(settings, imported))

    // The backup's history is keyed by the accounts as they were exported. A
    // backup from before the split carries the old keys, so rename it to the
    // accounts it was just imported as before merging it into local history.
    mergeSnapshots(remapSnapshotStore(snapshotListsOf(wrapper.snapshots), imported.split.renamed))
    // Accounts of a pre-split backup landed on other indexes, so every reading
    // cached under this provider's old indexes belongs to a different account
    // now — including ones with no card to refresh them away, such as a
    // disabled account. Drop them from state and disk alike, then refresh.
    dropAccountResults(imported.split.reindexed)
    if (imported.split.reindexed.length > 0) void refreshAll()
  }

  const [confirmClear, setConfirmClear] = useState(false)
  /** Inline import failure notice (themed text, not a native alert box) */
  const [importError, setImportError] = useState<string | null>(null)
  const handleClear = () => {
    setConfirmClear(false)
    clearSnapshots()
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

        <SettingRow label={t.prefs.usageMode}>
          <Select
            value={settings.usageDisplayMode}
            onValueChange={(v) =>
              updateSettings({ ...settings, usageDisplayMode: v === 'no-cache' ? 'no-cache' : 'all' })
            }
          >
            <SelectTrigger className="w-36 rounded-lg border-border bg-card px-3 py-1.5 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.prefs.usageAll}</SelectItem>
              <SelectItem value="no-cache">{t.prefs.usageNoCache}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

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
            <p className="text-xs text-muted-foreground">{t.prefs.exportNoKeys}</p>
            <p className="text-xs text-muted-foreground">{t.prefs.importHint}</p>
            {importError && <p className="text-xs text-danger">{importError}</p>}
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
            onClick={() => setConfirmClear(true)}
            className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10"
          >
            {t.prefs.clearSnapshots}
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmClear}
        title={t.prefs.clearSnapshots}
        description={t.prefs.clearConfirm}
        confirmText={t.prefs.clearSnapshots}
        cancelText={t.common.cancel}
        danger
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />

      {/* Local agent usage history — rendered only when the main-process store
          answered, i.e. never in the browser build */}
      {history.stats && (
        <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">{t.prefs.usageHistory}</h2>

          <p className="text-xs text-muted-foreground">{t.prefs.usageHistoryHint}</p>

          <SettingRow label={t.prefs.usageHistoryRange}>
            <span className="text-xs text-muted-foreground">
              {history.stats.days === 0
                ? t.prefs.usageHistoryEmpty
                : t.prefs.usageHistorySpan(
                    history.stats.days,
                    history.stats.oldest ?? '',
                    history.stats.newest ?? '',
                  )}
            </span>
          </SettingRow>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-foreground">{t.prefs.purgeScope}</span>
              <div className="flex items-center gap-2">
                <Select value={history.scope} onValueChange={history.setScope}>
                  <SelectTrigger className="w-32 rounded-lg border-border bg-card px-3 py-1.5 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PURGE_SCOPES.map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {t.prefs.purgeDays(days)}
                      </SelectItem>
                    ))}
                    <SelectItem value="all">{t.prefs.purgeAll}</SelectItem>
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  disabled={history.purging || history.stats.days === 0}
                  onClick={() => history.setConfirming(true)}
                  className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  {t.prefs.purgeAction}
                </button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t.prefs.purgeHint}</p>
            {history.notice && <p className="text-xs text-muted-foreground">{history.notice}</p>}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={history.confirming}
        title={t.prefs.purgeAction}
        description={
          history.scope === 'all' ? t.prefs.purgeConfirmAll : t.prefs.purgeConfirm(Number(history.scope))
        }
        confirmText={t.prefs.purgeAction}
        cancelText={t.common.cancel}
        danger
        onConfirm={() => void history.purge()}
        onCancel={() => history.setConfirming(false)}
      />

      {/* About — version row followed by the update block */}
      <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t.prefs.about}</h2>

        {/* App name as the card's identity line, with the repo link pinned to
            the right edge like the version row below */}
        <SettingRow label={t.app.title}>
          <Tooltip text={t.prefs.repoLink} side="left">
            <button
              type="button"
              onClick={() => {
                const bridge = window.desktopBridge
                if (bridge) void bridge.openExternal(REPO_URL)
                else window.open(REPO_URL, '_blank', 'noopener')
              }}
              aria-label={t.prefs.repoLink}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <GitHubIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </SettingRow>

        <SettingRow label={t.prefs.version}>
          <span className="text-xs text-muted-foreground">{APP_VERSION}</span>
        </SettingRow>

        <SettingRow label={t.prefs.updates.title}>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{updateText}</span>
            {update?.status === 'downloaded' && (
              <button
                type="button"
                onClick={() => void window.desktopBridge?.installUpdate()}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong"
              >
                {t.prefs.updates.installNow}
              </button>
            )}
            <button
              type="button"
              disabled={update?.status === 'checking' || update?.status === 'downloading'}
              onClick={() => {
                const bridge = window.desktopBridge
                if (!bridge) return
                void bridge.checkForUpdates().then(setUpdate)
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t.prefs.updates.check}
            </button>
          </div>
        </SettingRow>
      </section>
    </div>
  )
}
