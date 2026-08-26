import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { ProviderConfig, ProviderDef, ProviderResult, Settings } from '../types'
import { PROVIDERS } from '../providers/registry'
import {
  ENC_PREFIX,
  getProviderEntries,
  hasEncryptedKeys,
  hasLegacyV2Store,
  isSameEntry,
  loadSettings,
  persistSettings,
} from './storage'
import { fetchUsage } from './query'
import { recordSnapshot } from './snapshots'
import { summarizeScan, archiveDailyUsage, getDailyUsageSeries, type AgentUsageVM } from './agent-usage'
import {
  deriveAlerts,
  loadAlerts,
  markAllRead,
  markRead,
  saveAlerts,
  unreadCount,
} from './alerts'
import type { AlertItem } from './alerts'
import { useLocale } from '../i18n/LocaleProvider'

export interface Card {
  def: ProviderDef
  cfg: ProviderConfig
  index: number
  key: string
}

export interface Section {
  def: ProviderDef
  cards: Card[]
}

/** Group enabled, keyed accounts by provider in registry order */
export function buildSections(settings: Settings): Section[] {
  const out: Section[] = []
  for (const def of PROVIDERS) {
    const entries = getProviderEntries(settings, def.id)
    const cards: Card[] = []
    entries.forEach((cfg, i) => {
      if (!cfg.enabled || !cfg.apiKey) return
      cards.push({ def, cfg, index: i, key: `${def.id}-${i}` })
    })
    if (cards.length === 0) continue
    out.push({ def, cards })
  }
  return out
}

/**
 * App-wide data layer: settings + per-account fetch results + refresh scheduler
 * + derived alerts. Extracted from the former single-component App so every
 * page shares one source of truth without a state library.
 */
interface DataContextValue {
  settings: Settings
  results: Record<string, ProviderResult>
  refreshingAll: boolean
  /** Completion time of the last full refresh cycle (epoch ms), null before the first one */
  lastUpdated: number | null
  sections: Section[]
  configuredCount: number
  okCount: number
  /** Global "agent" filter (provider id or 'all') driven by the top bar select */
  agentFilter: string
  setAgentFilter: (id: string) => void
  /** Local agent usage (tokscale) view model, null-ish until the first Electron scan */
  agentUsage: AgentUsageVM
  agentUsageLoading: boolean
  refreshAgentUsage: () => Promise<void>
  /** Daily local-agent token series (trend chart); [] until history accumulates */
  agentDailySeries: (days: number) => { label: string; value: number }[]
  /** Live alert set (already merged with the persisted store) */
  alerts: AlertItem[]
  unreadAlerts: number
  markAllAlertsRead: () => void
  markAlertRead: (id: string) => void
  updateSettings: (next: Settings) => void
  /** Snapshot settings before opening an edit surface; endSettingsEdit diffs against it */
  beginSettingsEdit: () => void
  /** Diff settings against the beginSettingsEdit snapshot and refresh only changed entries */
  endSettingsEdit: () => void
  refreshOne: (
    def: ProviderDef,
    cfg: ProviderConfig,
    key: string,
    opts?: { silent?: boolean },
  ) => Promise<void>
  refreshAll: (opts?: { silent?: boolean }) => Promise<void>
  addEntry: (providerId: string) => void
  deleteEntry: (providerId: string, index: number) => void
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const { locale } = useLocale()
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [results, setResults] = useState<Record<string, ProviderResult>>({})
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [agentFilter, setAgentFilter] = useState('all')
  const [alerts, setAlerts] = useState<AlertItem[]>(loadAlerts)
  // Local agent (tokscale) usage view — populated only under Electron
  const [agentUsage, setAgentUsage] = useState<AgentUsageVM>(() => summarizeScan(null))
  const [agentUsageLoading, setAgentUsageLoading] = useState(false)

  // Snapshot of settings taken before an edit session (e.g. the accounts drawer
  // opening); endSettingsEdit diffs against it.
  const editBaseRef = useRef<Settings>(settings)

  useEffect(() => {
    // Fire-and-forget: persistSettings handles encryption + round-trip
    // verification internally and never throws (browser falls back to the
    // plaintext v2 write inside it).
    void persistSettings(settings)
  }, [settings])

  // One-shot hydration/migration after mount (Electron only):
  // 1. v3 data loads with ciphertext keys — decrypt them into memory so the UI
  //    works. Until hydration lands (millisecond-scale) fetchUsage may see a
  //    ciphertext key and get a 401; acceptable and self-healing.
  // 2. v2 data under a capable bridge migrates straight to encrypted v3 via
  //    persistSettings (which verifies, then drops the plaintext v2 key).
  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    if (hasEncryptedKeys(settings)) {
      void (async () => {
        const providers: Settings['providers'] = {}
        let allOk = true
        for (const [id, entries] of Object.entries(settings.providers)) {
          const list: ProviderConfig[] = []
          for (const entry of entries) {
            if (!entry.apiKey.startsWith(ENC_PREFIX)) {
              list.push(entry)
              continue
            }
            let plain: string | null = null
            try {
              plain = await bridge.decrypt(entry.apiKey)
            } catch {
              plain = null
            }
            if (!plain) {
              allOk = false
              console.warn(`[data] failed to decrypt a key for "${id}" #${list.length}; keeping ciphertext`)
              list.push(entry)
              continue
            }
            list.push({ ...entry, apiKey: plain })
          }
          providers[id] = list
        }
        // Only flip to plaintext when every key decrypted; on partial failure the
        // ciphertext entries stay and keep failing visibly instead of vanishing.
        if (allOk) {
          updateSettings({ ...settings, providers })
          // The mount refresh raced hydration and went out with ciphertext keys
          // (401s); re-run silently so the decrypted keys take effect at once
          // instead of waiting for the next manual/auto refresh.
          void refreshAll({ silent: true })
        }
      })()
    } else if (hasLegacyV2Store()) {
      void persistSettings(settings)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydration runs once on mount
  }, [])

  const refreshOne = useCallback(
    async (
      def: ProviderDef,
      cfg: ProviderConfig,
      key: string,
      opts?: { silent?: boolean },
    ) => {
      if (!cfg.enabled || !cfg.apiKey) {
        setResults((r) => ({ ...r, [key]: { status: 'unconfigured' } }))
        return
      }
      const silent = opts?.silent ?? false
      // Silent refresh (auto-refresh timer): keep the last result visible, skip the loading flash.
      // Manual refresh: flip to loading so the user gets visual feedback.
      if (!silent) {
        setResults((r) => ({ ...r, [key]: { status: 'loading' } }))
      }
      const result = await fetchUsage(def, cfg, locale)
      setResults((r) => {
        // In silent mode, if the user kicked off a manual refresh during the fetch,
        // preserve that loading state instead of clobbering it with the silent result.
        if (silent && r[key]?.status === 'loading') return r
        return { ...r, [key]: result }
      })
      if (result.status === 'ok' && result.metrics) {
        // Feed the local time-series store for trends / today consumption
        recordSnapshot(key, result.metrics)
        setLastUpdated(Date.now())
      }
    },
    [locale],
  )

  // Keep a ref so the callback identity stays stable across settings edits
  // (typing in an editor field must not tear down the auto-refresh interval).
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const refreshAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false
      if (!silent) setRefreshingAll(true)
      try {
        const sections = buildSections(settingsRef.current)
        const cards = sections.flatMap((s) => s.cards)
        await Promise.all(cards.map((c) => refreshOne(c.def, c.cfg, c.key, { silent })))
      } finally {
        // Always clear the spinner, even if a single account refresh throws
        if (!silent) setRefreshingAll(false)
      }
    },
    [refreshOne],
  )

  useEffect(() => {
    void refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch silently when locale changes so adapter metric labels update immediately
  const prevLocaleRef = useRef(locale)
  useEffect(() => {
    if (prevLocaleRef.current !== locale) {
      prevLocaleRef.current = locale
      void refreshAll({ silent: true })
    }
  }, [locale, refreshAll])

  useEffect(() => {
    if (!settings.autoRefreshMin) return
    const t = setInterval(
      () => void refreshAll({ silent: true }),
      settings.autoRefreshMin * 60_000,
    )
    return () => clearInterval(t)
  }, [settings.autoRefreshMin, refreshAll])

  // Local agent scan: on mount (Electron only) + every 5 minutes. The main
  // process caches the expensive scan, so this polling is cheap.
  const refreshAgentUsage = useCallback(async () => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setAgentUsageLoading(true)
    try {
      const raw = await bridge.tokscaleScan()
      const summary = summarizeScan(raw)
      if (summary.error == null) archiveDailyUsage(summary.todayTotal.tokens)
      setAgentUsage(summary)
    } catch (e) {
      setAgentUsage(summarizeScan({ error: String(e) }))
    } finally {
      setAgentUsageLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!window.desktopBridge) return
    void refreshAgentUsage()
    const t = setInterval(() => void refreshAgentUsage(), 5 * 60_000)
    return () => clearInterval(t)
  }, [refreshAgentUsage])

  const markAllAlertsRead = useCallback(() => {
    // Compute from current state (not inside the updater) so persistence stays
    // out of the reducer and StrictMode double-invoke can't double-write.
    const next = markAllRead(alerts)
    setAlerts(next)
    saveAlerts(next)
  }, [alerts])

  const markAlertRead = useCallback(
    (id: string) => {
      const next = markRead(alerts, id)
      setAlerts(next)
      saveAlerts(next)
    },
    [alerts],
  )

  const updateSettings = useCallback((next: Settings) => {
    // Sync the ref immediately: the drawer's save→close sequence runs
    // endSettingsEdit in the same event, before the state update re-renders.
    settingsRef.current = next
    setSettings(next)
  }, [])

  const beginSettingsEdit = useCallback(() => {
    editBaseRef.current = settings
  }, [settings])

  const endSettingsEdit = useCallback(() => {
    // Read through the ref: the save→close sequence updates settings and ends
    // the edit session in one event, before React re-renders with new state.
    const prev = editBaseRef.current
    const after = settingsRef.current
    editBaseRef.current = after
    const changed: Array<{ def: ProviderDef; cfg: ProviderConfig; key: string; exists: boolean }> = []
    for (const def of PROVIDERS) {
      const before = getProviderEntries(prev, def.id)
      const now = getProviderEntries(after, def.id)
      const len = Math.max(before.length, now.length)
      for (let i = 0; i < len; i++) {
        if (!isSameEntry(before[i], now[i])) {
          const cfg = now[i]
          const key = `${def.id}-${i}`
          changed.push({ def, cfg: cfg as ProviderConfig, key, exists: !!cfg })
        }
      }
    }
    setResults((r) => {
      const next = { ...r }
      for (const def of PROVIDERS) {
        const before = getProviderEntries(prev, def.id)
        const now = getProviderEntries(after, def.id)
        for (let i = now.length; i < before.length; i++) {
          delete next[`${def.id}-${i}`]
        }
      }
      return next
    })
    for (const { def, cfg, key, exists } of changed) {
      if (!exists) continue
      void refreshOne(def, cfg, key)
    }
  }, [refreshOne])

  const addEntry = useCallback((providerId: string) => {
    setSettings((s) => {
      const entries = getProviderEntries(s, providerId).slice()
      entries.push({ enabled: false, apiKey: '' })
      return { ...s, providers: { ...s.providers, [providerId]: entries } }
    })
  }, [])

  const deleteEntry = useCallback((providerId: string, index: number) => {
    setSettings((s) => {
      const entries = getProviderEntries(s, providerId).slice()
      if (index < 0 || index >= entries.length) return s
      entries.splice(index, 1)
      return { ...s, providers: { ...s.providers, [providerId]: entries } }
    })
    setResults((r) => {
      const next = { ...r }
      delete next[`${providerId}-${index}`]
      for (let i = index + 1; i < 50; i++) {
        const oldKey = `${providerId}-${i}`
        if (next[oldKey]) {
          next[`${providerId}-${i - 1}`] = next[oldKey]
          delete next[oldKey]
        }
      }
      return next
    })
  }, [])

  const sections = useMemo(() => buildSections(settings), [settings])

  // Re-derive the alert set whenever fresh results arrive; persist the merge.
  const derivedAlerts = useMemo(() => deriveAlerts(sections, results), [sections, results])
  useEffect(() => {
    setAlerts(derivedAlerts)
    saveAlerts(derivedAlerts)
  }, [derivedAlerts])

  const configuredCount = sections.reduce((s, sec) => s + sec.cards.length, 0)
  const okCount = sections.reduce(
    (s, sec) => s + sec.cards.filter((c) => results[c.key]?.status === 'ok').length,
    0,
  )
  const unread = useMemo(() => unreadCount(alerts), [alerts])

  const value = useMemo<DataContextValue>(
    () => ({
      settings,
      results,
      refreshingAll,
      lastUpdated,
      sections,
      configuredCount,
      okCount,
      agentFilter,
      setAgentFilter,
      alerts,
      unreadAlerts: unread,
      markAllAlertsRead,
      markAlertRead,
      agentUsage,
      agentUsageLoading,
      refreshAgentUsage,
      agentDailySeries: getDailyUsageSeries,
      updateSettings,
      beginSettingsEdit,
      endSettingsEdit,
      refreshOne,
      refreshAll,
      addEntry,
      deleteEntry,
    }),
    [
      settings,
      results,
      refreshingAll,
      lastUpdated,
      sections,
      configuredCount,
      okCount,
      agentFilter,
      alerts,
      unread,
      markAllAlertsRead,
      markAlertRead,
      agentUsage,
      agentUsageLoading,
      refreshAgentUsage,
      updateSettings,
      beginSettingsEdit,
      endSettingsEdit,
      refreshOne,
      refreshAll,
      addEntry,
      deleteEntry,
    ],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within <DataProvider>')
  return ctx
}
