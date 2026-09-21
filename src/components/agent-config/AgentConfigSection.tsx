import { AlertCircle, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ProviderCard } from './ProviderCard'
import { ProviderDrawer } from './ProviderDrawer'
import { ConfirmDialog } from '@/components/beui/confirm-dialog'
import { SearchInput } from '@/components/common/SearchInput'
import { Tooltip } from '@/components/common/Tooltip'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import {
  AGENT_IDS,
  KIMI_PROTOCOLS,
  MCODE_PROTOCOLS,
  OPENCODE_PACKAGES,
  filterProviders,
  parseAgentConfigPayload,
  type AgentConfigPayload,
  type AgentId,
  type AgentProvider,
  type AgentProviderInput,
} from '@/lib/agent-config'

/** Proper nouns — brand names, not translated */
const AGENT_LABELS: Record<AgentId, string> = {
  kimi: 'Kimi Code',
  mcode: 'MiniMax Code',
  opencode: 'OpenCode',
}

/** Protocol choices per agent; opencode's are runtime package names */
const AGENT_PROTOCOLS: Record<AgentId, readonly string[]> = {
  kimi: KIMI_PROTOCOLS,
  mcode: MCODE_PROTOCOLS,
  opencode: OPENCODE_PACKAGES,
}

/**
 * Agent configuration panel: read and edit the provider setup of the coding
 * agents installed on this machine.
 *
 * The panel is desktop-only by construction — it reads and writes files through
 * the main process — so the browser build shows an explanatory empty state
 * instead of failing. Every write reloads the payload afterwards, which keeps
 * the compare-and-swap token in step with what is on disk.
 */
export function AgentConfigSection({ className }: { className?: string }) {
  const t = useT()
  const [agent, setAgent] = useState<AgentId>('kimi')
  const [payload, setPayload] = useState<AgentConfigPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [drawer, setDrawer] = useState<{ open: boolean; provider: AgentProvider | undefined }>({
    open: false,
    provider: undefined,
  })
  const [deleteTarget, setDeleteTarget] = useState<AgentProvider | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const bridge = typeof window === 'undefined' ? undefined : window.desktopBridge

  const reload = useCallback(
    async (id: AgentId) => {
      if (!bridge) return
      setLoading(true)
      setActionError(null)
      try {
        const raw = await bridge.agentConfigRead(id)
        setPayload(parseAgentConfigPayload(id, raw))
      } catch (e) {
        setPayload(null)
        setActionError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [bridge],
  )

  useEffect(() => {
    setExpanded(new Set())
    setQuery('')
    setNotice(null)
    if (bridge) void reload(agent)
    else setPayload(null)
  }, [agent, bridge, reload])

  const providers = useMemo(
    () => filterProviders(payload?.providers ?? [], query),
    [payload, query],
  )

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleSave = async (input: AgentProviderInput): Promise<string | null> => {
    if (!bridge || !payload) return t.agentConfig.saveFailed(t.agentConfig.parseError)
    const result = await bridge.agentConfigSave(agent, payload.revision, input)
    if (!result.ok) return t.agentConfig.saveFailed(result.message ?? '')
    setNotice(result.backupPath ? t.agentConfig.savedWithBackup(result.backupPath) : null)
    await reload(agent)
    return null
  }

  const confirmDelete = async () => {
    if (!bridge || !payload || !deleteTarget) return
    const result = await bridge.agentConfigRemove(agent, payload.revision, deleteTarget.id)
    setDeleteTarget(null)
    if (!result.ok) {
      setActionError(t.agentConfig.saveFailed(result.message ?? ''))
      return
    }
    setNotice(result.backupPath ? t.agentConfig.savedWithBackup(result.backupPath) : null)
    await reload(agent)
  }

  const protocols = AGENT_PROTOCOLS[agent]
  const totalModels = payload?.providers.reduce((n, p) => n + p.models.length, 0) ?? 0

  return (
    <section className={cn('space-y-3', className)} data-agent-config={agent}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t.agentConfig.title}</h2>
          <p className="text-xs text-subtle">{t.agentConfig.desc}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border bg-card p-0.5">
            {AGENT_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setAgent(id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  agent === id
                    ? 'bg-accent text-white'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {AGENT_LABELS[id]}
              </button>
            ))}
          </div>
          {bridge && (
            <Tooltip text={t.agentConfig.reload}>
              <button
                type="button"
                onClick={() => void reload(agent)}
                disabled={loading}
                aria-label={t.agentConfig.reload}
                className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {!bridge ? (
        <div className="rounded-xl border border-border bg-card px-4 py-6 text-center">
          <p className="text-sm font-medium text-foreground">{t.agentConfig.desktopOnlyTitle}</p>
          <p className="mt-1 text-xs text-subtle">{t.agentConfig.desktopOnlyDesc}</p>
        </div>
      ) : loading && !payload ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t.agentConfig.loading}
        </div>
      ) : payload && !payload.installed ? (
        <div className="rounded-xl border border-border bg-card px-4 py-6 text-center">
          <p className="text-sm font-medium text-foreground">
            {t.agentConfig.notInstalled(AGENT_LABELS[agent])}
          </p>
          <p className="mt-1 text-xs text-subtle">
            {payload.note?.startsWith('parse-error') ? t.agentConfig.parseError : t.agentConfig.notInstalledHint}
          </p>
          {payload.note?.startsWith('parse-error') && (
            <p className="mx-auto mt-2 max-w-xl break-all font-mono text-[11px] text-danger">
              {payload.note}
            </p>
          )}
        </div>
      ) : payload ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t.agentConfig.searchPlaceholder}
              className="min-w-52 flex-1"
            />
            <span className="text-xs text-muted-foreground">
              {t.agentConfig.providersSummary(payload.providers.length, totalModels)}
            </span>
            <button
              type="button"
              data-action="add-provider"
              onClick={() => setDrawer({ open: true, provider: undefined })}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong"
            >
              <Plus className="h-3.5 w-3.5" />
              {t.agentConfig.addProvider}
            </button>
          </div>

          {!payload.cliAvailable && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              {t.agentConfig.cliMissing}
            </p>
          )}

          {notice && (
            <p className="break-all rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
              {notice}
            </p>
          )}
          {actionError && (
            <p className="break-all rounded-lg bg-danger/10 px-3 py-2 text-[11px] text-danger">
              {actionError}
            </p>
          )}

          <div className="space-y-2">
            {providers.length === 0 ? (
              <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-subtle">
                {t.agentConfig.noMatch}
              </p>
            ) : (
              providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  agent={agent}
                  provider={provider}
                  expanded={expanded.has(provider.id)}
                  onToggle={() => toggle(provider.id)}
                  onEdit={() => setDrawer({ open: true, provider })}
                  onDelete={() => setDeleteTarget(provider)}
                />
              ))
            )}
          </div>
        </>
      ) : null}

      <ProviderDrawer
        agent={agent}
        open={drawer.open}
        provider={drawer.provider}
        protocols={protocols}
        supportsEnabled={agent === 'mcode'}
        onSave={handleSave}
        onClose={() => setDrawer({ open: false, provider: undefined })}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t.agentConfig.delete}
        description={t.agentConfig.deleteHint}
        confirmText={t.agentConfig.delete}
        cancelText={t.agentConfig.cancel}
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  )
}
