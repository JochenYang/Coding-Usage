import { BarChart3, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderConfig, ProviderDef, ProviderResult, Settings } from './types'
import { PROVIDERS } from './providers/registry'
import {
  getProviderEntries,
  isSameEntry,
  loadSettings,
  saveSettings,
} from './lib/storage'
import { fetchUsage, pingProxy } from './lib/query'
import { useT } from './i18n/useT'
import { useLocale } from './i18n/LocaleProvider'
import { Header } from './components/Header'
import { ProviderCard } from './components/ProviderCard'
import { ProviderLogo } from './components/ProviderLogo'
import { SettingsPanel } from './components/SettingsPanel'
import { Loader } from './components/beui/loader'

interface Card {
  def: ProviderDef
  cfg: ProviderConfig
  index: number
  key: string
}

interface Section {
  def: ProviderDef
  cards: Card[]
}

function buildSections(settings: Settings): Section[] {
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

export default function App() {
  const t = useT()
  const { locale } = useLocale()
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [results, setResults] = useState<Record<string, ProviderResult>>({})
  const [proxyOnline, setProxyOnline] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)

  // Snapshot of settings taken before opening the drawer; used to diff on close for smart refresh
  const prevSettingsRef = useRef<Settings>(settings)
  useEffect(() => {
    if (settingsOpen) prevSettingsRef.current = settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  useEffect(() => saveSettings(settings), [settings])

  useEffect(() => {
    let alive = true
    const ping = async () => {
      const online = await pingProxy()
      if (alive) setProxyOnline(online)
    }
    void ping()
    const t = setInterval(ping, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const refreshOne = useCallback(
    async (def: ProviderDef, cfg: ProviderConfig, key: string, opts?: { silent?: boolean }) => {
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
      const result = await fetchUsage(def, cfg, proxyOnline, locale)
      setResults((r) => {
        // In silent mode, if the user kicked off a manual refresh during the fetch,
        // preserve that loading state instead of clobbering it with the silent result.
        if (silent && r[key]?.status === 'loading') return r
        return { ...r, [key]: result }
      })
    },
    [proxyOnline, locale],
  )

  const refreshAllEnabled = useCallback(
    async (snapshot: Settings, opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false
      if (!silent) setRefreshingAll(true)
      const sections = buildSections(snapshot)
      const cards = sections.flatMap((s) => s.cards)
      await Promise.all(cards.map((c) => refreshOne(c.def, c.cfg, c.key, { silent })))
      if (!silent) setRefreshingAll(false)
    },
    [refreshOne],
  )

  useEffect(() => {
    void refreshAllEnabled(settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch silently when locale changes so adapter metric labels update immediately
  const prevLocaleRef = useRef(locale)
  useEffect(() => {
    if (prevLocaleRef.current !== locale) {
      prevLocaleRef.current = locale
      void refreshAllEnabled(settings, { silent: true })
    }
  }, [locale, refreshAllEnabled, settings])

  const refreshedAfterProxy = useRef(false)
  useEffect(() => {
    if (proxyOnline && !refreshedAfterProxy.current) {
      refreshedAfterProxy.current = true
      void refreshAllEnabled(settings)
    }
  }, [proxyOnline, refreshAllEnabled, settings])

  useEffect(() => {
    if (!settings.autoRefreshMin) return
    const t = setInterval(
      () => void refreshAllEnabled(settings, { silent: true }),
      settings.autoRefreshMin * 60_000,
    )
    return () => clearInterval(t)
  }, [settings.autoRefreshMin, refreshAllEnabled, settings])

  const sections = useMemo(() => buildSections(settings), [settings])
  const configuredCount = sections.reduce((s, sec) => s + sec.cards.length, 0)
  const okCount = sections.reduce(
    (s, sec) => s + sec.cards.filter((c) => results[c.key]?.status === 'ok').length,
    0,
  )

  /** Close settings drawer: diff settings, refresh only changed entries; cards already in correct state are not refetched */
  const handleSettingsClose = useCallback(() => {
    const prev = prevSettingsRef.current
    const after = settings
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
    setSettingsOpen(false)
    setResults((prev) => {
      const next = { ...prev }
      for (const def of PROVIDERS) {
        const before = getProviderEntries(prevSettingsRef.current, def.id)
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
  }, [settings, refreshOne])

  const handleDeleteEntry = useCallback((providerId: string, index: number) => {
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

  const handleAddEntry = useCallback((providerId: string) => {
    setSettings((s) => {
      const entries = getProviderEntries(s, providerId).slice()
      entries.push({ enabled: false, apiKey: '' })
      return { ...s, providers: { ...s.providers, [providerId]: entries } }
    })
    // After adding, auto-open the settings drawer to that provider's block so the key can be filled in immediately
    setSettingsOpen(true)
  }, [])

  const handleSettingsChange = useCallback((next: Settings) => {
    setSettings(next)
  }, [])

  return (
    <div className="min-h-screen">
      <Header
        okCount={okCount}
        totalConfigured={configuredCount}
        refreshing={refreshingAll}
        autoRefreshMin={settings.autoRefreshMin}
        onAutoRefreshChange={(autoRefreshMin) => setSettings({ ...settings, autoRefreshMin })}
        onRefreshAll={() => void refreshAllEnabled(settings, { silent: true })}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {configuredCount === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-5 text-center">
            <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-gradient-to-br from-muted to-background text-stone-500 shadow-sm">
              <BarChart3 className="h-9 w-9" />
              <Loader
                variant="ascii-line"
                size={12}
                speed={1}
                label=""
                className="absolute -right-2 -top-2 text-stone-400"
              />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">{t.empty.title}</h2>
              <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
                {t.empty.description}
              </p>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-2 rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-semibold text-stone-50 shadow-sm transition-transform hover:scale-[1.02] hover:bg-stone-800"
            >
              <Plus className="h-4 w-4" />
              {t.empty.openSettings}
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {sections.map((sec) => (
              <section key={sec.def.id}>
                <header className="mb-3 flex items-center gap-3">
                  <ProviderLogo def={sec.def} className="h-7 w-7" imgClassName="h-4 w-4" />
                  <h2 className="text-sm font-semibold text-foreground">{sec.def.name}</h2>
                  <span className="text-xs text-subtle">{t.card.accountsCount(sec.cards.length)}</span>
                </header>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {sec.cards.map((c) => (
                    <ProviderCard
                      key={c.key}
                      def={c.def}
                      cfg={c.cfg}
                      index={c.index}
                      totalEntries={sec.cards.length}
                      result={results[c.key]}
                      onRefresh={() => void refreshOne(c.def, c.cfg, c.key)}
                      onGoSettings={() => setSettingsOpen(true)}
                      onDelete={() => handleDeleteEntry(c.def.id, c.index)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={handleSettingsChange}
        onClose={handleSettingsClose}
        onAddEntry={handleAddEntry}
        onDeleteEntry={handleDeleteEntry}
      />
    </div>
  )
}
