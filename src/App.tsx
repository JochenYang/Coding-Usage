import { useEffect, useState } from 'react'
import { DataProvider, useData } from './lib/data-context'
import { useView } from './lib/router'
import { AppShell } from './components/layout/AppShell'
import { OverviewPage } from './pages/OverviewPage'
import { AgentsPage } from './pages/AgentsPage'
import { AccountsPage } from './pages/AccountsPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { PlansPage } from './pages/PlansPage'
import { AlertsPage } from './pages/AlertsPage'
import { SettingsPage } from './pages/SettingsPage'
import { UsageStatsPage } from './pages/UsageStatsPage'
import { CostAnalysisPage } from './pages/CostAnalysisPage'
import { TrendsPage } from './pages/TrendsPage'
import { IntegrationsPage } from './pages/IntegrationsPage'
import { AccountDrawer } from './components/account/AccountDrawer'
import { getProvider } from './providers/registry'
import { getProviderEntries } from './lib/storage'
import { IslandSurface, useIslandMode } from './components/layout/IslandSurface'
import type { ProviderConfig } from './types'

export default function App() {
  // The dedicated island overlay window loads this same bundle with a bare
  // #/island hash: render ONLY the surface there — no DataProvider, so the
  // overlay never runs a second instance of the refresh/scan side effects.
  const islandMode = useIslandMode()
  if (islandMode) return <IslandSurface />
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  )
}

/** Which provider entry the AccountDrawer is currently operating on */
interface EditorTarget {
  pid: string
  idx: number
  /** create = always append (used by "add account" flows, incl. save-and-continue) */
  mode: 'edit' | 'create'
}

function Shell() {
  const [view, navigate] = useView()
  const {
    settings,
    updateSettings,
    beginSettingsEdit,
    endSettingsEdit,
    deleteEntry,
  } = useData()
  const [editor, setEditor] = useState<EditorTarget | null>(null)

  // The overlay body click relays here: focus main + open the alerts page
  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    return bridge.onOpenAlerts(() => navigate('alerts'))
  }, [navigate])

  const openEditor = (pid: string, idx: number) => {
    beginSettingsEdit()
    setEditor({ pid, idx, mode: 'edit' })
  }
  // Create mode targets the append slot at pick time; the drawer keeps an empty
  // form across "save & continue" so consecutive saves each append.
  const openCreateEditor = (pid: string, idx: number) => {
    beginSettingsEdit()
    setEditor({ pid, idx, mode: 'create' })
  }
  const closeEditor = () => {
    setEditor(null)
    endSettingsEdit()
  }

  const editorDef = editor ? getProvider(editor.pid) : undefined
  // Create mode always sees an undefined cfg (empty form), no matter how many
  // accounts have been appended since the session started.
  const editorCfg =
    editor && editor.mode === 'edit'
      ? getProviderEntries(settings, editor.pid)[editor.idx]
      : undefined

  /** Save into the existing slot (edit) or append (create mode) */
  const handleEditorSave = (next: ProviderConfig) => {
    if (!editor) return
    const entries = getProviderEntries(settings, editor.pid).slice()
    if (editor.mode === 'create' || editor.idx >= entries.length) entries.push(next)
    else entries[editor.idx] = next
    updateSettings({ ...settings, providers: { ...settings.providers, [editor.pid]: entries } })
  }

  return (
    <AppShell view={view} navigate={navigate}>
      {view === 'overview' && (
        <OverviewPage onEditAccount={openEditor} onViewAllAlerts={() => navigate('alerts')} />
      )}
      {view === 'agents' && <AgentsPage />}
      {view === 'accounts' && (
        <AccountsPage onEditAccount={openEditor} onAddAccount={openCreateEditor} />
      )}
      {view === 'providers' && (
        <ProvidersPage onAddAccount={openCreateEditor} onEditAccount={openEditor} />
      )}
      {view === 'plans' && <PlansPage onAddAccount={openCreateEditor} />}
      {view === 'alerts' && <AlertsPage />}
      {view === 'settings' && <SettingsPage />}
      {view === 'usage-stats' && <UsageStatsPage />}
      {view === 'cost-analysis' && <CostAnalysisPage />}
      {view === 'trends' && <TrendsPage />}
      {view === 'integrations' && <IntegrationsPage />}

      {editor && editorDef && (
        <AccountDrawer
          open
          def={editorDef}
          index={editor.idx}
          cfg={editorCfg}
          onSave={handleEditorSave}
          onDelete={
            editorCfg
              ? () => {
                  deleteEntry(editor.pid, editor.idx)
                  // Closing first prevents the drawer from silently re-binding
                  // to the shifted next entry (or flipping to create mode).
                  closeEditor()
                }
              : undefined
          }
          onClose={closeEditor}
        />
      )}
    </AppShell>
  )
}
