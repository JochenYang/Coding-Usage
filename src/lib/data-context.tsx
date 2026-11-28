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
  loadSettingsDetailed,
  needsMirrorRecovery,
  persistSettings,
  restoreSettingsDocument,
  SECRET_INTEGRATION_FIELDS,
  KEY_V3,
} from './storage'
import { fetchUsage } from './query'
import { recordSnapshot } from './snapshots'
import { summarizeScan, archiveDailyUsage, getDailyUsageSeries, type AgentUsageVM } from './agent-usage'
import {
  dropCachedResults,
  loadCachedAgentUsage,
  loadCachedResults,
  saveCachedAgentUsage,
  saveCachedResults,
  withoutAccountResults,
} from './startup-cache'
import {
  deriveAlerts,
  loadAlerts,
  markAllRead,
  markRead,
  markReadMany,
  restoredAlertId,
  saveAlerts,
  unreadCount,
} from './alerts'
import { subscriptionAlertSources, type QuotaSnapshotLike } from './subscription-alerts'
import { normalizeOpenErRates, type FxRates } from './rates'
import { pushAlerts } from './alert-push'
import { useT } from '../i18n/useT'

const FX_CACHE_KEY = 'coding-usage.fx.v1'
const FX_TTL_MS = 24 * 60 * 60_000
/**
 * setTimeout's 32-bit delay ceiling. A restore timer never asks for more:
 * an overflowed delay fires at once, which would announce a window that has
 * not recovered. A window further out is woken halfway and re-armed (see the
 * restore-timer effect).
 */
const MAX_TIMER_MS = 2 ** 31 - 1
/** Fire a beat after the reset point so the announcement never lands early on a fast clock */
const RESTORE_GRACE_MS = 1_000
/** The alert engine waits for the first quota snapshot at most this long */
const SNAPSHOT_READY_TIMEOUT_MS = 3_000
/** How often the derive memo re-runs just to re-check the snapshot age */
const AGE_TICK_MS = 60 * 60_000

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
import { buildSections, type Card, type Section } from './sections'

// Accounts and their grouping live in ./sections so that pure logic stays out of
// this React module.
export { buildSections }
export type { Card, Section }

/**
 * How this launch got its settings from the file mirror:
 * - `none`: there was nothing to recover — localStorage already held a
 *   settings document, or the mirror was never written;
 * - `pending`: the mirror is being read back, and nothing is saved meanwhile;
 * - `restored`: the mirror was put back and its accounts were loaded;
 * - `unrecovered`: the mirror had to be read but did not come back (damaged,
 *   unreadable, or not writable into localStorage), so the defaults stand.
 */
type StartupRecovery = 'none' | 'pending' | 'restored' | 'unrecovered'

/**
 * App-wide data layer: settings + per-account fetch results + refresh scheduler
 * + derived alerts. Extracted from the former single-component App so every
 * page shares one source of truth without a state library.
 *
 * `background` marks the hidden cycle window the shell opens while no window is
 * open: it refreshes, derives alerts and pushes, but it must not write settings
 * back (it would persist a snapshot taken moments ago, overwriting an edit the
 * user just made) and must not own the iLink keep-alive (destroying this window
 * at the end of the cycle would abort the session the visible window set up).
 */
interface DataContextValue {
  settings: Settings
  results: Record<string, ProviderResult>
  refreshingAll: boolean
  /** Completion time of the last full refresh cycle (epoch ms), null before the first one */
  lastUpdated: number | null
  /**
   * Increments whenever a refresh cycle finishes — auto or manual, whatever the
   * per-account outcomes. Cards outside the provider pipeline (the subscription
   * quota probes) follow this rather than `lastUpdated`, which only moves once a
   * fetch has actually succeeded.
   */
  refreshTick: number
  sections: Section[]
  configuredCount: number
  okCount: number
  /** Local agent usage (tokscale) view model, null-ish until the first Electron scan */
  agentUsage: AgentUsageVM
  agentUsageLoading: boolean
  refreshAgentUsage: () => Promise<void>
  /** Live FX rates (1 unit = ? CNY); null until fetched — conversions then use the static table */
  fxRates: FxRates | null
  /**
   * Daily local-agent token series (trend chart); [] until history accumulates.
   * `day` is part of the contract: the trends page densifies this series onto a
   * calendar grid, and dropping the field would silently fall back to counting
   * records instead of days.
   */
  agentDailySeries: (days: number) => { day: string; label: string; value: number }[]
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
  /**
   * Forget every cached reading of the listed providers' accounts, in state
   * and on disk. For a caller that replaces a provider's account list
   * outside an edit session: the readings are keyed by account index, so the
   * old ones would land on whichever account holds that index now.
   */
  dropAccountResults: (providerIds: string[]) => void
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider({
  children,
  background = false,
}: {
  children: ReactNode
  /** True in the shell's hidden cycle window: read-only with respect to settings */
  background?: boolean
}) {
  const { locale } = useLocale()
  // The persisted stores are read in one go, in the order the split-site
  // account migration needs: loading the settings drops stale readings and
  // renames stored history, so the results cache and the alert store are
  // read only after it has run. Doing it here instead of in three separate
  // initializers keeps that order from depending on declaration order.
  const [boot] = useState(() => ({
    settings: loadSettings(),
    results: loadCachedResults(),
    alerts: loadAlerts(),
    // With no settings document in localStorage, the defaults loaded above are
    // not the user's settings: the file mirror may still have them. Nothing
    // may be saved until it has been read back (see the recovery effect).
    recovery: (needsMirrorRecovery(!!window.desktopBridge) ? 'pending' : 'none') as StartupRecovery,
  }))
  const [settings, setSettings] = useState<Settings>(boot.settings)
  const [recovery, setRecovery] = useState<StartupRecovery>(boot.recovery)
  const recoveryPending = recovery === 'pending'
  // A launch that needed the mirror and did not get it back is still running
  // on the empty defaults. Writing them anywhere would destroy the only copy
  // of the accounts: into the mirror directly, or into localStorage — where
  // they would make the next launch skip recovery and mirror them anyway. So
  // nothing is persisted until the user changes something; until then every
  // launch reads the mirror again.
  const runningOnDefaults = recovery === 'unrecovered' && settings === boot.settings
  // Replaying the last persisted fetch results makes the first paint show
  // real numbers; the rows' stale derivation keeps the honesty (10 min mark).
  const [results, setResults] = useState<Record<string, ProviderResult>>(boot.results)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  // Bumped once per finished cycle; see DataContextValue.refreshTick
  const [refreshTick, setRefreshTick] = useState(0)
  const [alerts, setAlerts] = useState<AlertItem[]>(boot.alerts)
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
    // The hidden cycle window only refreshes: persisting from here would rewrite
    // every credential (fresh DPAPI blobs) on every cycle and could write back a
    // settings snapshot older than an edit made in the foreground.
    if (background) return
    // Hold while startup recovery is still reading the mirror: the settings in
    // state are the empty defaults until then, and the mirror write below would
    // replace the only copy of the accounts with them.
    if (recoveryPending) return
    // Hold just the same after a recovery that did not succeed (see
    // `runningOnDefaults`): the defaults must reach neither localStorage nor
    // the mirror until there is a real change to save.
    if (runningOnDefaults) return
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
  }, [settings, background, recoveryPending, runningOnDefaults])

  // Startup recovery: when localStorage has no settings at all (fresh profile
  // or a wiped/corrupt leveldb), fall back to the userData file mirror. It
  // runs before anything is persisted, so the mirror still holds what the
  // previous launch saved when it is read.
  //
  // The window is one IPC round-trip, and a change made inside it loses to
  // the restored settings: the accounts come back whole, which matters more
  // than a preference toggled in the first milliseconds of the launch.
  useEffect(() => {
    if (!recoveryPending) return
    void (async () => {
      // The gate opens no matter how the recovery goes. Staying closed would
      // silently drop every change the user makes in this session, which is
      // worse than starting without the restored accounts.
      let next: StartupRecovery = 'unrecovered'
      try {
        const backup = await window.desktopBridge?.settingsBackupRead()
        // The gate only opens under a bridge, so no answer at all means the
        // bridge itself is gone: nothing came back, which is not "no mirror"
        if (backup === undefined) {
          console.warn('[data] the desktop bridge went away during recovery; starting without the mirror')
        } else if (backup === null) {
          // No mirror was ever written: a fresh profile, not a lost one
          next = 'none'
        } else {
          const outcome = restoreSettingsDocument(backup)
          if (outcome === 'restored') {
            const loaded = loadSettingsDetailed()
            setSettings(loaded.settings)
            // By now the results cache is already in state, so the split's
            // cleanup of stored readings cannot reach it: drop the re-indexed
            // providers from the in-memory copy too, or the first paint shows
            // one account's numbers on another's card.
            dropAccountResults(loaded.split.reindexed)
            next = 'restored'
          } else {
            // `empty` or `corrupt`: either way there is nothing to restore,
            // and saying which tells a blank file from a damaged one
            console.warn(`[data] the settings mirror is ${outcome}; starting without it`)
          }
        }
      } catch (error) {
        // Unreadable, or read but not writable back into localStorage
        console.warn(`[data] could not restore the settings mirror: ${error instanceof Error ? error.message : String(error)}`)
      }
      setRecovery(next)
    })()
    // dropAccountResults is stable; the gate itself is the only trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryPending])

  // One-shot hydration/migration after mount (Electron only):
  // 1. v3 data loads with ciphertext keys — decrypt them into memory so the UI
  //    works. Until hydration lands (millisecond-scale) fetchUsage may see a
  //    ciphertext key and get a 401; acceptable and self-healing.
  // 2. v2 data under a capable bridge migrates straight to encrypted v3 via
  //    persistSettings (which verifies, then drops the plaintext v2 key).
  // It runs once startup recovery has settled: accounts restored from the
  // mirror arrive as ciphertext too, and skipping this for them would leave
  // every request of the session failing with 401.
  useEffect(() => {
    if (recoveryPending) return
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
    } else if (hasLegacyV2Store() && !runningOnDefaults) {
      // Only what the launch actually loaded from v2 is worth migrating. After
      // a failed recovery the key can still be there with nothing loadable in
      // it, and what is in memory is the empty default: persisting it here
      // would get around the hold in `runningOnDefaults` — the next launch
      // would find a settings document and never read the mirror again.
      void persistSettings(settings)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydration runs once per launch, after recovery
  }, [recoveryPending])

  // WeChat iLink keep-alive: main owns the getupdates long-poll once a
  // decrypted bot token exists. The app is opened on demand, so the loop
  // only needs to live for this run — it is what keeps sendmessage from
  // answering {ret:-2, prepare failed} after a cold start. Disconnect and
  // app quit both stop it.
  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge || background) return
    const token = settings.integrations.weixinBotToken
    const userId = settings.integrations.weixinBotUserId
    if (token && !token.startsWith(ENC_PREFIX) && userId) {
      void bridge.ilinkSessionStart(token)
      return () => {
        void bridge.ilinkSessionStop()
      }
    }
    void bridge.ilinkSessionStop()
  }, [settings.integrations.weixinBotToken, settings.integrations.weixinBotUserId, background])

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

  // Local agent scan. One shot at mount (a local scan needs no decrypted
  // keys), then it rides the same refresh cycle as everything else — the
  // manual refresh buttons and the auto-refresh tick, both through refreshAll —
  // so its cadence follows the user's auto-refresh setting instead of a hidden
  // timer. The main process caches a scan for 5 minutes; silent (timer-driven)
  // attempts are throttled just past that window, so each allowed attempt
  // yields a real rescan instead of re-transferring cached JSON.
  const AGENT_REFRESH_MIN_MS = 5 * 60_000 + 30_000
  const agentAttemptAtRef = useRef(0)
  /** In-flight scan shared by overlapping callers (mount cycle + refreshAll) */
  const agentInflightRef = useRef<Promise<void> | null>(null)

  const refreshAgentUsage = useCallback(async (opts?: { silent?: boolean }) => {
    const bridge = window.desktopBridge
    if (!bridge) return
    const silent = opts?.silent ?? false
    if (silent && Date.now() - agentAttemptAtRef.current < AGENT_REFRESH_MIN_MS) return
    // Overlapping triggers (mount effect + mount refreshAll, rapid clicks)
    // share the running round-trip; the initiating call owns the spinner.
    if (agentInflightRef.current) return agentInflightRef.current
    agentAttemptAtRef.current = Date.now()
    const run = (async (): Promise<void> => {
      if (!silent) setAgentUsageLoading(true)
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
        if (!silent) {
          const elapsed = Date.now() - startedAt
          const MIN_SPIN_MS = 600
          if (elapsed < MIN_SPIN_MS) await new Promise((r) => setTimeout(r, MIN_SPIN_MS - elapsed))
          setAgentUsageLoading(false)
        }
      }
    })()
    agentInflightRef.current = run
    try {
      await run
    } finally {
      if (agentInflightRef.current === run) agentInflightRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!window.desktopBridge) return
    void refreshAgentUsage()
  }, [refreshAgentUsage])

  // Returning to a visible window (wake from sleep, minimized across midnight)
  // asks for a silent attempt so "today" numbers cannot sit on yesterday's
  // totals; quick switch-backs are absorbed by the throttle above.
  useEffect(() => {
    if (!window.desktopBridge) return
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshAgentUsage({ silent: true })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [refreshAgentUsage])

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
      // Fire-and-forget: the local-usage card owns its own spinner, and a real
      // rescan takes far longer than the provider fetches.
      void refreshAgentUsage({ silent })
      try {
        const sections = buildSections(settingsRef.current)
        const cards = sections.flatMap((s) => s.cards)
        await Promise.all(cards.map((c) => refreshOne(c.def, c.cfg, c.key, { silent })))
      } finally {
        // Always clear the spinner, even if a single account refresh throws
        if (!silent) setRefreshingAll(false)
        // The cycle is over whether or not every fetch landed; cards outside
        // this pipeline re-read on the tick (see DataContextValue.refreshTick)
        setRefreshTick((n) => n + 1)
      }
    },
    [refreshOne, refreshAgentUsage],
  )

  useEffect(() => {
    // Nothing to fetch while startup recovery is still reading the mirror;
    // it runs again on the restored settings once recovery has settled.
    if (recoveryPending) return
    // Under Electron with encrypted keys the mount fetch would race key
    // decryption (ciphertext keys → 401s); hydration drives the single
    // startup fetch cycle instead. Every other path fetches immediately.
    if (window.desktopBridge && hasEncryptedKeys(settings)) return
    void refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryPending])

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

  // `runningOnDefaults` learns that the user changed something from `settings`
  // no longer being the object the launch started from. This and the two entry
  // edits below are user actions, so that reading holds; an automatic update
  // has to keep the same object, or the hold after a failed recovery lifts on
  // its own.
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

  const dropAccountResults = useCallback((providerIds: string[]) => {
    if (providerIds.length === 0) return
    for (const id of providerIds) dropCachedResults(id)
    setResults((current) => withoutAccountResults(current, providerIds))
  }, [])

  const sections = useMemo(() => buildSections(settings), [settings])
  const t = useT()

  // Last-known-good subscription readings (Claude, Codex, …) from the main
  // process. The cards probe on their own; this is the one place the alert
  // engine can see them. Read on mount and whenever a probe wrote a new
  // reading — polling on the refresh tick would be a cycle late, because the
  // cards probe right after the tick.
  const [quotaSnapshot, setQuotaSnapshot] = useState<QuotaSnapshotLike>({})
  // False until the first snapshot read settled (or there is no bridge). A
  // derive before that sees no subscription sources and files every live
  // subscription alert as resolved; the snapshot landing would flip it back
  // to live, and that resolved→live edge is what the island treats as a new
  // event — every launch would re-pop every persistent subscription alert.
  // Without a bridge there is nothing to wait for.
  const [snapshotReady, setSnapshotReady] = useState(() => !window.desktopBridge)
  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    let cancelled = false
    const read = () => {
      bridge
        .quotaSnapshot()
        .then((snapshot) => {
          if (!cancelled) setQuotaSnapshot(snapshot)
        })
        .catch(() => {
          // No snapshot is the same as an empty one.
        })
        .finally(() => {
          if (!cancelled) setSnapshotReady(true)
        })
    }
    read()
    // A bridge that never answers must not hold the alert engine hostage.
    const watchdog = setTimeout(() => {
      if (!cancelled) setSnapshotReady(true)
    }, SNAPSHOT_READY_TIMEOUT_MS)
    const unsubscribe = bridge.onQuotaUpdated(read)
    return () => {
      cancelled = true
      clearTimeout(watchdog)
      unsubscribe()
    }
  }, [])

  // Only cards the user kept on the plans page raise alerts: a disabled card
  // must not keep announcing a snapshot it left behind.
  const enabledSubscriptions = useMemo(
    () => new Set(settings.enabledSubscriptions),
    [settings.enabledSubscriptions],
  )

  // Low-frequency clock for the derive memo: the snapshot age check inside
  // `subscriptionAlertSources` only runs when the memo recomputes, and with
  // auto-refresh off nothing else moves for hours. One tick an hour is
  // enough for a day-old reading to age out without churning the engine.
  // Side effect to know about: the derive commits a fresh array on every
  // tick, so the webhook push effect runs hourly too and its 4h cooldown —
  // "a still-unread, still-active alert re-pushes once the window lapses" —
  // now holds with auto-refresh off as well, where it previously only did
  // for users who had a refresh interval set.
  const [ageTick, setAgeTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setAgeTick((n) => n + 1), AGE_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // Re-derive the alert set whenever fresh results arrive; persist the merge.
  // Subscription windows are normalized on every round (not memoized apart)
  // so the snapshot age check runs against the current clock.
  const derivedAlerts = useMemo(
    () =>
      deriveAlerts(
        sections,
        results,
        settings.alertThresholds,
        subscriptionAlertSources(quotaSnapshot, enabledSubscriptions, t, Date.now()),
      ),
    // ageTick is a clock input, not a value the memo reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, results, settings.alertThresholds, quotaSnapshot, enabledSubscriptions, t, ageTick],
  )
  useEffect(() => {
    if (!snapshotReady) return
    setAlerts(derivedAlerts)
    saveAlerts(derivedAlerts)
  }, [derivedAlerts, snapshotReady])

  // Restore timer: a window that raised high-usage announces its recovery
  // when its reset point passes. It is a local timer on `resetsAt`, not a
  // re-probe — the cards only probe while the plans page is open, so the
  // reading may be stale, but the reset time itself is exact. One announcement
  // per window per reset point: the id carries both, and the next derive
  // files the row as resolved history. Rebuilt on every alerts change (the
  // derive round re-stamps all rows); the target instant stays the same.
  const [wakeTick, setWakeTick] = useState(0)
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const now = Date.now()
    for (const alert of alerts) {
      if (alert.kind !== 'high-usage' || alert.resolved || alert.resetsAt == null || !alert.metricId) continue
      const delay = alert.resetsAt - now
      // Past reset points are the engine's business (stale guard).
      if (delay <= 0) continue
      // Beyond one timer's reach (a monthly window seen right after its
      // reset): wake up halfway and let the effect re-arm with a delay that
      // fits. An overflowed setTimeout fires at once and would announce a
      // window that has not recovered.
      if (delay + RESTORE_GRACE_MS > MAX_TIMER_MS) {
        timers.push(setTimeout(() => setWakeTick((n) => n + 1), Math.min(delay, MAX_TIMER_MS / 2)))
        continue
      }
      const id = restoredAlertId(alert.accountKey, alert.metricId, alert.resetsAt)
      if (alerts.some((a) => a.id === id)) continue
      timers.push(
        setTimeout(() => {
          const restored: AlertItem = {
            id,
            level: 'info',
            accountKey: alert.accountKey,
            agentName: alert.agentName,
            kind: 'window-restored',
            metricId: alert.metricId,
            windowLabel: alert.windowLabel,
            resetsAt: alert.resetsAt,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            read: false,
          }
          // Same pattern as the mark-read callbacks: compute from state, set,
          // persist — never a side effect inside the updater. The rows that
          // described this window as still pending (exhausted, or about to
          // reset) are closed here too: until the next derive (which may be
          // an hour away with auto-refresh off) they would otherwise keep
          // reading "exhausted" / "resets in 30 min" next to the row that
          // says it recovered.
          const next = [
            ...alerts.map((a) =>
              (a.kind === 'high-usage' || a.kind === 'window-reset') &&
              !a.resolved &&
              a.accountKey === alert.accountKey &&
              a.metricId === alert.metricId
                ? { ...a, resolved: true }
                : a,
            ),
            restored,
          ]
          setAlerts(next)
          saveAlerts(next)
        }, delay + RESTORE_GRACE_MS),
      )
    }
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
    // wakeTick is a clock input, not a value the effect reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts, wakeTick])

  // Webhook push: every refresh offers the full unread set — pushAlerts
  // applies the per-channel 4h cooldown itself, so a still-unread,
  // still-active alert re-pushes once the window lapses (this is what "at
  // most once per 4 hours per channel" promises). Filtering upstream on
  // "new since last render" starved exactly the persistent conditions (low
  // balance, long high usage) while transient window resets kept flowing.
  // Read alerts never push (acknowledged); resolved ones leave the list.
  // Skipped while credentials are still ciphertext (hydration pending) — the
  // push fires on the next refresh cycle once the plaintext lands.
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
      refreshTick,
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
      dropAccountResults,
    }),
    [
      settings,
      results,
      refreshingAll,
      lastUpdated,
      refreshTick,
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
      dropAccountResults,
    ],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within <DataProvider>')
  return ctx
}
