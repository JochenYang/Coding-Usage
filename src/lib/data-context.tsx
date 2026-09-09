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
  SECRET_INTEGRATION_FIELDS,
  KEY_V3,
} from './storage'
import { fetchUsage } from './query'
import { recordSnapshot } from './snapshots'
import { summarizeScan, archiveDailyUsage, getDailyUsageSeries, type AgentUsageVM } from './agent-usage'
import {
  loadCachedAgentUsage,
  loadCachedResults,
  saveCachedAgentUsage,
  saveCachedResults,
} from './startup-cache'
import {
  deriveAlerts,
  loadAlerts,
  markAllRead,
  markRead,
  markReadMany,
  saveAlerts,
  unreadCount,
} from './alerts'
import { normalizeOpenErRates, type FxRates } from './rates'
import { pushAlerts } from './alert-push'
import { useT } from '../i18n/useT'

const FX_CACHE_KEY = 'coding-usage.fx.v1'
const FX_TTL_MS = 24 * 60 * 60_000

function readFxCache(): { fetchedAt: number; rates: FxRates } | null {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; rates?: unknown }
    if (typeof parsed.fetchedAt !== 'number' || !parsed.rates || typeof parsed.rates !== 'object') return null
    return { fetchedAt: parsed.fetchedAt, rates: parsed.rates as FxRates }
  } catch {
    return null
  }
}

function saveFxCache(rates: FxRates): void {
  try {
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), rates }))
  } catch {
    // best-effort cache
  }
}

/**
 * Live FX rates (1 unit = ? CNY) for every display-currency conversion.
 * open.er-api.com daily refresh → localStorage cache → static fallback in
 * convertAmount. Electron routes the request through the main process
 * (CSP blocks renderer-side external fetches); plain browser dev goes direct.
 */
async function fetchFxRates(): Promise<FxRates | null> {
  const url = 'https://open.er-api.com/v6/latest/USD'
  let json: unknown = null
  try {
    const bridge = window.desktopBridge
    if (bridge) {
      const r = await bridge.fetch(url, {})
      if (r.status === 200) json = JSON.parse(r.body)
    } else {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      json = await r.json()
    }
  } catch {
    json = null
  }
  return normalizeOpenErRates(json)
}
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
  /** Local agent usage (tokscale) view model, null-ish until the first Electron scan */
  agentUsage: AgentUsageVM
  agentUsageLoading: boolean
  refreshAgentUsage: () => Promise<void>
  /** Live FX rates (1 unit = ? CNY); null until fetched — conversions then use the static table */
  fxRates: FxRates | null
  /** Daily local-agent token series (trend chart); [] until history accumulates */
  agentDailySeries: (days: number) => { label: string; value: number }[]
  /** Live alert set (already merged with the persisted store) */
  alerts: AlertItem[]
  unreadAlerts: number
  markAllAlertsRead: () => void
  markAlertRead: (id: string) => void
  /** Batch variant: one state update + one persist for many ids */
  markAlertsRead: (ids: string[]) => void
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
  // Replaying the last persisted fetch results makes the first paint show
  // real numbers; the rows' stale derivation keeps the honesty (10 min mark).
  const [results, setResults] = useState<Record<string, ProviderResult>>(loadCachedResults)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [alerts, setAlerts] = useState<AlertItem[]>(loadAlerts)
  // Local agent (tokscale) usage view — replayed from the startup cache, then
  // corrected by the first scan (whose full run can take tens of seconds)
  const [agentUsage, setAgentUsage] = useState<AgentUsageVM>(
    () => loadCachedAgentUsage() ?? summarizeScan(null),
  )
  const [agentUsageLoading, setAgentUsageLoading] = useState(false)
  // Live FX rates for display-currency conversion; null = static fallback in use
  const [fxRates, setFxRates] = useState<FxRates | null>(null)

  useEffect(() => {
    void (async () => {
      const cached = readFxCache()
      if (cached && Date.now() - cached.fetchedAt < FX_TTL_MS) {
        setFxRates(cached.rates)
        return
      }
      const fresh = await fetchFxRates()
      if (fresh) {
        setFxRates(fresh)
        saveFxCache(fresh)
      } else if (cached) {
        setFxRates(cached.rates)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, [])

  // Snapshot of settings taken before an edit session (e.g. the accounts drawer
  // opening); endSettingsEdit diffs against it.
  const editBaseRef = useRef<Settings>(settings)

  useEffect(() => {
    // Persist first, then mirror the encrypted v3 document to a userData file
    // so a lost/corrupt localStorage can be restored on next launch.
    void (async () => {
      await persistSettings(settings)
      const bridge = window.desktopBridge
      if (bridge) {
        const rawV3 = localStorage.getItem(KEY_V3)
        if (rawV3) void bridge.settingsBackupWrite(rawV3)
      }
    })()
  }, [settings])

  // Startup recovery: when localStorage has no settings at all (fresh profile
  // or a wiped/corrupt leveldb), fall back to the userData file mirror.
  useEffect(() => {
    void (async () => {
      const bridge = window.desktopBridge
      if (!bridge) return
      if (localStorage.getItem(KEY_V3) || localStorage.getItem('coding-usage.settings.v2')) return
      const backup = await bridge.settingsBackupRead()
      if (backup) {
        try {
          localStorage.setItem(KEY_V3, backup)
          setSettings(loadSettings())
        } catch {
          // ignore — user can re-enter accounts
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, [])

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
        let integrations = settings.integrations
        for (const field of SECRET_INTEGRATION_FIELDS) {
          const encVal = settings.integrations[field]
          if (!encVal.startsWith(ENC_PREFIX)) continue
          let plainVal: string | null = null
          try {
            plainVal = await bridge.decrypt(encVal)
          } catch {
            plainVal = null
          }
          if (!plainVal) {
            allOk = false
            console.warn(`[data] failed to decrypt integration field "${field}"; keeping ciphertext`)
          } else {
            integrations = { ...integrations, [field]: plainVal }
          }
        }
        if (allOk) {
          updateSettings({ ...settings, providers, integrations })
        }
        // Exactly one startup fetch cycle, driven from here with the best keys
        // available: the mount refresh would have raced the decryption above
        // (ciphertext keys → 401s) and needed this re-run anyway.
        void refreshAll({ silent: true })
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
    // Under Electron with encrypted keys the mount fetch would race key
    // decryption (ciphertext keys → 401s); hydration drives the single
    // startup fetch cycle instead. Every other path fetches immediately.
    if (window.desktopBridge && hasEncryptedKeys(settings)) return
    void refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist the latest fetch results for the next launch's instant paint.
  // Debounced: a manual refresh flips results N times and only the settled
  // state is worth a synchronous localStorage round-trip.
  const resultsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (resultsSaveTimer.current) clearTimeout(resultsSaveTimer.current)
    resultsSaveTimer.current = setTimeout(() => saveCachedResults(results), 500)
    return () => {
      if (resultsSaveTimer.current) clearTimeout(resultsSaveTimer.current)
    }
  }, [results])

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
    // A warm main-process cache answers in milliseconds — hold the spinner up
    // briefly anyway so the press always reads as "a refresh happened".
    const startedAt = Date.now()
    try {
      const raw = await bridge.tokscaleScan()
      const summary = summarizeScan(raw)
      // Only archive REAL today numbers: with the corrected bucketing an empty
      // today now yields 0, and writing 0 would clobber today's archived value
      if (summary.error == null && summary.todayTotal.tokens > 0) {
        archiveDailyUsage(summary.todayTotal.tokens)
        saveCachedAgentUsage(summary)
      } else if (summary.error == null) {
        saveCachedAgentUsage(summary)
      }
      setAgentUsage(summary)
    } catch (e) {
      setAgentUsage(summarizeScan({ error: String(e) }))
    } finally {
      const elapsed = Date.now() - startedAt
      const MIN_SPIN_MS = 600
      if (elapsed < MIN_SPIN_MS) await new Promise((r) => setTimeout(r, MIN_SPIN_MS - elapsed))
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

  const markAlertsRead = useCallback(
    (ids: string[]) => {
      // One computed next + one persist: calling markAlertRead in a loop
      // would base every pass on the same stale closure and lose all but
      // the last id
      const next = markReadMany(alerts, ids)
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
      // Shift-down bound = the largest index this provider actually has
      let maxIndex = index
      for (const key of Object.keys(r)) {
        if (key.startsWith(`${providerId}-`)) {
          const i = Number(key.slice(providerId.length + 1))
          if (Number.isFinite(i) && i > maxIndex) maxIndex = i
        }
      }
      const next = { ...r }
      delete next[`${providerId}-${index}`]
      for (let i = index + 1; i <= maxIndex; i++) {
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
  const derivedAlerts = useMemo(
    () => deriveAlerts(sections, results, settings.alertThresholds),
    [sections, results, settings.alertThresholds],
  )
  useEffect(() => {
    setAlerts(derivedAlerts)
    saveAlerts(derivedAlerts)
  }, [derivedAlerts])

  // Webhook push: every refresh offers the full unread set — pushAlerts
  // applies the per-channel 4h cooldown itself, so a still-unread,
  // still-active alert re-pushes once the window lapses (this is what "at
  // most once per 4 hours per channel" promises). Filtering upstream on
  // "new since last render" starved exactly the persistent conditions (low
  // balance, long high usage) while transient window resets kept flowing.
  // Read alerts never push (acknowledged); resolved ones leave the list.
  // Skipped while credentials are still ciphertext (hydration pending) — the
  // push fires on the next refresh cycle once the plaintext lands.
  const t = useT()
  useEffect(() => {
    if (!settings.integrations.alertPush) return
    // Resolved history rows never push (their condition already cleared)
    const unread = alerts.filter((a) => !a.read && !a.resolved)
    if (unread.length === 0) return
    void pushAlerts(settings.integrations, unread, t)
  }, [alerts, settings, t])

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
      alerts,
      unreadAlerts: unread,
      markAllAlertsRead,
      markAlertRead,
      markAlertsRead,
      agentUsage,
      agentUsageLoading,
      refreshAgentUsage,
      fxRates,
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
      alerts,
      unread,
      markAllAlertsRead,
      markAlertRead,
      markAlertsRead,
      agentUsage,
      agentUsageLoading,
      refreshAgentUsage,
      fxRates,
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
