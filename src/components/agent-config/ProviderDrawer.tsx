import { Check, Download, Eye, EyeOff, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Checkbox, ModelEditor, type ModelDraft } from './ModelEditor'
import { Drawer } from '@/components/beui/drawer'
import { ConfirmDialog } from '@/components/beui/confirm-dialog'
import { Loader } from '@/components/beui/loader'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/beui/select'
import { Switch } from '@/components/beui/switch'
import { Tooltip } from '@/components/common/Tooltip'
import { useT } from '@/i18n/useT'
import type {
  AgentId,
  AgentModelInput,
  AgentModelListResult,
  AgentProvider,
  AgentProviderInput,
} from '@/lib/agent-config'

export interface ProviderDrawerProps {
  agent: AgentId
  open: boolean
  /** Undefined = create mode */
  provider: AgentProvider | undefined
  /** Protocol values the agent accepts; a wrong one fails silently at request time */
  protocols: readonly string[]
  /** True when the agent stores an enable/disable flag per provider (mcode) */
  supportsEnabled: boolean
  onSave: (input: AgentProviderInput) => Promise<string | null>
  onClose: () => void
}

function emptyDraft(): ModelDraft {
  return {
    id: '',
    originalId: '',
    displayName: '',
    contextLimit: '',
    outputLimit: '',
    inputModalities: ['text'],
    capabilities: [],
    supportEfforts: [],
    defaultEffort: '',
    persisted: false,
    expanded: true,
  }
}

/** Project a loaded model onto an editable draft, preserving every stored value */
function toDrafts(provider: AgentProvider | undefined): ModelDraft[] {
  if (!provider) return []
  return provider.models.map((model) => ({
    id: model.id,
    originalId: model.id,
    displayName: model.displayName,
    contextLimit: model.contextLimit ? String(model.contextLimit) : '',
    outputLimit: model.outputLimit ? String(model.outputLimit) : '',
    inputModalities: model.inputModalities.length > 0 ? model.inputModalities : ['text'],
    capabilities: model.capabilities,
    supportEfforts: model.supportEfforts,
    defaultEffort: model.defaultEffort ?? '',
    persisted: true,
    expanded: false,
  }))
}

/**
 * Draft → wire shape.
 *
 * Two rules keep an untouched model byte-identical in the file:
 *   - empty numerics stay undefined, so the stored value survives;
 *   - the display name is only sent when the file already had one or the user
 *     actually changed it — `AgentModel.displayName` falls back to the wire
 *     name for rendering, and writing that fallback back would add a field the
 *     record never had.
 *
 * A changed id travels with its old value so the write path can move the
 * record: without it, "an id I have not seen before" is indistinguishable from
 * "one model deleted and another added".
 */
function toModelInput(draft: ModelDraft, provider: AgentProvider | undefined): AgentModelInput {
  const id = draft.id.trim()
  // A renamed model is still looked up under the id it was loaded with, so its
  // untouched fields keep coming from the stored record.
  const original = provider?.models.find((m) => m.id === (draft.originalId || id))
  const displayName = draft.displayName.trim()
  const renameNeeded = original === undefined || displayName !== original.displayName
  return {
    id,
    originalId: draft.originalId && draft.originalId !== id ? draft.originalId : undefined,
    displayName: original?.displayNameExplicit || renameNeeded ? displayName : undefined,
    contextLimit: draft.contextLimit ? Number(draft.contextLimit) : undefined,
    outputLimit: draft.outputLimit ? Number(draft.outputLimit) : undefined,
    inputModalities: draft.inputModalities,
    capabilities: draft.capabilities,
    supportEfforts: draft.supportEfforts,
    defaultEffort: draft.defaultEffort || undefined,
  }
}

/**
 * Order-insensitive fingerprint of the model drafts.
 *
 * Used only to answer "did anything change" for the unsaved-close guard, so the
 * multi-select fields are sorted here — the written order is the one the user
 * sees, not the one this comparison happens to observe.
 */
function fingerprint(drafts: ModelDraft[]): string {
  return JSON.stringify(
    drafts.map((d) => [
      d.id,
      d.displayName,
      d.contextLimit,
      d.outputLimit,
      [...d.inputModalities].sort(),
      [...d.capabilities].sort(),
      [...d.supportEfforts].sort(),
      d.defaultEffort,
    ]),
  )
}

/**
 * Create/edit one provider, including its model list.
 *
 * The identifier a provider is stored under is deliberately not editable:
 * kimicode keys a provider by its section name, so renaming one would have to
 * rewrite every model alias and every `provider` field in the same write; mcode
 * derives its key once at creation and treats it as immutable. The display name
 * is editable for mcode and fixed for kimicode, where the two are the same
 * string.
 *
 * "Fetch models" queries the provider's own `/models` endpoint through the main
 * process, using values typed in this form when they are present and the stored
 * ones otherwise — so it works both while creating a provider and while editing
 * an existing one.
 */
export function ProviderDrawer({
  agent,
  open,
  provider,
  protocols,
  supportsEnabled,
  onSave,
  onClose,
}: ProviderDrawerProps) {
  const t = useT()
  const isNew = provider === undefined

  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [models, setModels] = useState<ModelDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)

  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState<AgentModelListResult | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setName(provider?.name ?? '')
    setProtocol(provider?.protocol ?? protocols[0] ?? '')
    setBaseUrl(provider?.baseUrl ?? '')
    // Empty means "keep the stored credential" on the write path, so the field
    // always starts empty — the stored value is never round-tripped.
    setApiKey('')
    setShowKey(false)
    setEnabled(provider?.enabled ?? true)
    setModels(toDrafts(provider))
    setSaving(false)
    setError(null)
    setFetching(false)
    setFetchResult(null)
    setPicked(new Set())
  }, [open, provider, protocols])

  const isDirty =
    name !== (provider?.name ?? '') ||
    protocol !== (provider?.protocol ?? protocols[0] ?? '') ||
    baseUrl !== (provider?.baseUrl ?? '') ||
    apiKey !== '' ||
    enabled !== (provider?.enabled ?? true) ||
    fingerprint(models) !== fingerprint(toDrafts(provider))

  const handleClose = () => {
    if (isDirty && !saving) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  const patchModel = (index: number, patch: Partial<ModelDraft>) =>
    setModels((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)))

  const handleFetch = async () => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setFetching(true)
    setFetchResult(null)
    setPicked(new Set())
    try {
      const result = await bridge.agentConfigListModels(agent, provider?.id ?? '', {
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        protocol: protocol || undefined,
      })
      if (result.ok) {
        const known = new Set(models.map((m) => m.id.trim()))
        const fresh = (result.models ?? []).filter((id) => !known.has(id))
        setFetchResult({ ...result, models: fresh })
        setPicked(new Set(fresh))
      } else {
        setFetchResult(result)
      }
    } finally {
      setFetching(false)
    }
  }

  const addPicked = () => {
    const additions = [...picked].map((id) => ({ ...emptyDraft(), id }))
    setModels((prev) => [...prev, ...additions])
    setFetchResult(null)
    setPicked(new Set())
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    const payload: AgentProviderInput = {
      originalId: provider?.id,
      // In create mode the main process derives the stored key from the name;
      // this value is only a fallback for an agent that uses the name verbatim.
      id: provider?.id ?? name.trim(),
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim() || undefined,
      // '' clears, a value replaces, omission keeps — an untouched field sends
      // nothing, so the stored credential is never round-tripped through the UI.
      apiKey: apiKey === '' ? undefined : apiKey,
      enabled: supportsEnabled ? enabled : undefined,
      models: models.filter((m) => m.id.trim() !== '').map((m) => toModelInput(m, provider)),
    }
    const failure = await onSave(payload)
    setSaving(false)
    if (failure) setError(failure)
    else onClose()
  }

  const fetchedModels = fetchResult?.ok ? (fetchResult.models ?? []) : []

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(o) => !o && handleClose()}
        ariaLabel={isNew ? t.agentConfig.newProviderTitle : t.agentConfig.editProviderTitle}
      >
        <div className="flex items-center justify-between border-b border-border bg-card px-5 pb-4 pt-12">
          <h2 className="text-base font-semibold text-foreground">
            {isNew ? t.agentConfig.newProviderTitle : t.agentConfig.editProviderTitle}
          </h2>
          <Tooltip text={t.agentConfig.cancel} side="left">
            <button
              type="button"
              onClick={handleClose}
              aria-label={t.agentConfig.cancel}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </Tooltip>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto bg-background p-4">
          {supportsEnabled && !isNew && (
            <div className="flex items-center gap-2">
              <Switch checked={enabled} onCheckedChange={setEnabled} ariaLabel={t.settings.enabled} />
              <span className="text-xs text-muted-foreground">{t.settings.enabled}</span>
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">
              {t.agentConfig.providerName}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.agentConfig.providerNamePlaceholder}
              // Editing the name of a kimicode provider would rename its TOML
              // section, which is the storage key — not an editable field.
              disabled={!isNew && !supportsEnabled}
              className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground outline-none placeholder:text-subtle focus:border-accent disabled:opacity-60"
            />
            {isNew && (
              <p className="mt-1 text-[11px] text-subtle">{t.agentConfig.providerNameHint}</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">
              {t.agentConfig.protocol}
            </label>
            <Select value={protocol} onValueChange={setProtocol}>
              <SelectTrigger
                aria-label={t.agentConfig.protocol}
                className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {protocols.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-subtle">{t.agentConfig.protocolHint}</p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">
              {t.agentConfig.baseUrl}
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t.agentConfig.baseUrlPlaceholder}
              spellCheck={false}
              className="w-full rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-subtle focus:border-accent"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">
              {t.agentConfig.apiKey}
            </label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t.agentConfig.apiKeyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-subtle focus:border-accent"
              />
              <Tooltip text={showKey ? t.agentConfig.hide : t.agentConfig.show}>
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? t.agentConfig.hide : t.agentConfig.show}
                  className="rounded-lg border border-border bg-card px-2 text-muted-foreground hover:bg-muted"
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </Tooltip>
            </div>
            <p className="mt-1 text-[11px] text-subtle">{t.agentConfig.apiKeyKeepHint}</p>
          </div>

          <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wide text-subtle">
                {t.agentConfig.modelsLabel}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-action="fetch-models"
                  onClick={() => void handleFetch()}
                  disabled={fetching || baseUrl.trim() === ''}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  {fetching ? (
                    <Loader variant="dots" size={12} label={t.agentConfig.fetching} />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  {t.agentConfig.fetchModels}
                </button>
                <button
                  type="button"
                  onClick={() => setModels((prev) => [...prev, emptyDraft()])}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  {t.agentConfig.addModel}
                </button>
              </div>
            </div>

            {fetchResult && (
              <div className="mb-2 rounded-lg border border-border bg-background p-2" data-fetch-result>
                {fetchResult.ok ? (
                  <>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] text-subtle">
                        {t.agentConfig.fetchOk(fetchedModels.length)}
                      </span>
                      {fetchedModels.length > 0 && (
                        <button
                          type="button"
                          data-action="toggle-all-models"
                          onClick={() =>
                            setPicked((prev) =>
                              prev.size === fetchedModels.length ? new Set() : new Set(fetchedModels),
                            )
                          }
                          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {picked.size === fetchedModels.length
                            ? t.agentConfig.deselectAll
                            : t.agentConfig.selectAll}
                        </button>
                      )}
                    </div>
                    {fetchedModels.length === 0 ? (
                      <p className="text-[11px] text-subtle">{t.agentConfig.fetchNone}</p>
                    ) : (
                      <>
                        <div className="max-h-48 overflow-y-auto">
                          <div className="flex flex-col gap-1">
                            {fetchedModels.map((id) => (
                              <label
                                key={id}
                                className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted"
                              >
                                <Checkbox
                                  label={id}
                                  checked={picked.has(id)}
                                  onChange={(on) =>
                                    setPicked((prev) => {
                                      const next = new Set(prev)
                                      if (on) next.add(id)
                                      else next.delete(id)
                                      return next
                                    })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                        <button
                          type="button"
                          data-action="add-picked-models"
                          onClick={addPicked}
                          disabled={picked.size === 0}
                          className="mt-2 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-strong disabled:opacity-40"
                        >
                          {t.agentConfig.addSelected} ({picked.size})
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <p className="break-all text-[11px] text-danger">
                    {t.agentConfig.fetchFailed(fetchResult.message ?? '')}
                  </p>
                )}
              </div>
            )}

            {models.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-subtle">{t.agentConfig.noModels}</p>
            ) : (
              <div className="space-y-1.5">
                {models.map((draft, index) => (
                  <ModelEditor
                    key={`${index}-${draft.persisted ? draft.originalId || draft.id : 'new'}`}
                    draft={draft}
                    onChange={(patch) => patchModel(index, patch)}
                    onRemove={() => setModels((prev) => prev.filter((_, i) => i !== index))}
                  />
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-card px-5 py-4">
          <button
            type="button"
            data-action="save-provider"
            onClick={() => void handleSave()}
            disabled={saving || name.trim() === ''}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {saving ? <Loader variant="dots" size={14} label={t.agentConfig.saving} /> : <Check className="h-4 w-4" />}
            {saving ? t.agentConfig.saving : t.agentConfig.save}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-foreground hover:bg-muted"
          >
            {t.agentConfig.cancel}
          </button>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmClose}
        title={t.common.confirmTitle}
        description={t.settings.unsavedChanges}
        confirmText={t.common.confirm}
        cancelText={t.common.cancel}
        onConfirm={() => {
          setConfirmClose(false)
          onClose()
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  )
}
