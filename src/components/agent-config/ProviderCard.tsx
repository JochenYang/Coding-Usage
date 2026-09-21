import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronRight, Eye, EyeOff, Loader2, Pencil, PlugZap, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { EASE_OUT } from '@/lib/ease'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { Badge } from '@/components/common/Badge'
import type { AgentId, AgentModel, AgentProvider } from '@/lib/agent-config'

export interface ProviderCardProps {
  agent: AgentId
  provider: AgentProvider
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  className?: string
}

/** The full effort ladder as plain text, for the cell's title attribute */
function effortList(model: AgentModel): string {
  return model.supportEfforts.length === 0 ? '—' : model.supportEfforts.join('/')
}

/** Outcome of the last probe for one model, keyed by alias */
type TestState =
  | { phase: 'testing' }
  | { phase: 'ok' }
  | { phase: 'fail'; status?: number; message: string; timeout: boolean }

/** One labelled value row inside the expanded body */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 py-1">
      <span className="text-[11px] uppercase tracking-wide text-subtle">{label}</span>
      <div className="min-w-0 text-xs text-foreground">{children}</div>
    </div>
  )
}

/**
 * Collapsed summary + expandable detail for one provider.
 *
 * The credential is never part of the payload the page loaded: it is fetched
 * per provider, on the click that reveals it, and dropped again as soon as the
 * eye is toggled back. That keeps the plaintext out of the renderer's state
 * tree — and out of any React devtools snapshot — until the user asks for it.
 */
export function ProviderCard({
  agent,
  provider,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  className,
}: ProviderCardProps) {
  const t = useT()
  const reduce = useReducedMotion()
  const [revealed, setRevealed] = useState<string | null>(null)
  const [revealError, setRevealError] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})

  /**
   * Probe one model with a minimal live request.
   *
   * The wire name (`model.model`) is what gets sent, not the alias — kimicode
   * aliases often differ from the name the upstream actually serves. Results
   * stay in component state: they describe this moment, not the file.
   */
  const runTest = async (model: AgentModel) => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setTests((prev) => ({ ...prev, [model.alias]: { phase: 'testing' } }))
    try {
      const result = await bridge.agentConfigTestModel(agent, provider.id, model.model)
      setTests((prev) => ({
        ...prev,
        [model.alias]: result.ok
          ? { phase: 'ok' }
          : {
              phase: 'fail',
              status: result.status,
              message: result.message ?? '',
              timeout: (result.message ?? '').includes('no response within'),
            },
      }))
    } catch (e) {
      setTests((prev) => ({
        ...prev,
        [model.alias]: {
          phase: 'fail',
          message: e instanceof Error ? e.message : String(e),
          timeout: false,
        },
      }))
    }
  }

  const editable = !provider.readOnly

  /** Icon for the model's last probe result */
  const testGlyph = (model: AgentModel) => {
    const state = tests[model.alias]
    if (state?.phase === 'testing') {
      return <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
    }
    if (state?.phase === 'ok') return <Check className="mx-auto h-3.5 w-3.5 text-online" />
    if (state?.phase === 'fail') return <X className="mx-auto h-3.5 w-3.5 text-danger" />
    // A plug reads as "connectivity" here; a link icon would suggest opening a
    // URL, and a play triangle says "run", which is vaguer than it needs to be.
    return <PlugZap className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
  }

  /**
   * Status text shown next to the probe glyph — empty until a probe has run.
   *
   * Deliberately terse: gateways like to return paragraphs (and sometimes
   * support URLs) in their error bodies, and printing that inline would wreck
   * the table. A status code is enough to tell a wrong key from a wrong path
   * from a timeout.
   */
  const testText = (model: AgentModel): string => {
    const state = tests[model.alias]
    if (state?.phase === 'ok') return t.agentConfig.testSuccess
    if (state?.phase !== 'fail') return ''
    if (state.timeout) return t.agentConfig.testTimeout
    if (state.status) return String(state.status)
    return t.agentConfig.testFailed
  }

  const toggleReveal = async () => {
    if (revealed !== null) {
      setRevealed(null)
      return
    }
    setRevealError(false)
    const bridge = window.desktopBridge
    if (!bridge) return
    const result = await bridge.agentConfigReveal(agent, provider.id)
    if (result.ok && result.key) setRevealed(result.key)
    else setRevealError(true)
  }

  const keyText = revealed ?? provider.maskedKey ?? t.agentConfig.keyUnset

  return (
    <div className={cn('rounded-xl border border-border bg-card', className)}>
      <button
        type="button"
        data-provider-card={provider.id}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{provider.name}</span>
            {provider.protocol && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {provider.protocol}
              </span>
            )}
            {provider.readOnly && <Badge tone="neutral">{t.agentConfig.builtinBadge}</Badge>}
            {provider.readOnlyReason && !provider.readOnly && (
              <Badge tone="neutral">{t.agentConfig.migratedBadge}</Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-subtle">
            {provider.baseUrl ?? t.agentConfig.baseUrlUnset}
          </div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {provider.models.length}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="border-t border-border px-4 py-3">
              {provider.readOnlyReason && (
                <p className="mb-2 rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                  {provider.readOnly
                    ? t.agentConfig.builtinHint
                    : provider.readOnlyReason === 'migrated'
                      ? t.agentConfig.migratedHint
                      : provider.readOnlyReason}
                </p>
              )}

              <Field label={t.agentConfig.baseUrl}>
                <span className="break-all font-mono">
                  {provider.baseUrl ?? t.agentConfig.baseUrlUnset}
                </span>
              </Field>

              <Field label={t.agentConfig.apiKey}>
                {provider.hasKey || revealed ? (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-all font-mono">
                      {revealError ? (
                        <span className="text-danger">{t.agentConfig.revealFailed}</span>
                      ) : (
                        keyText
                      )}
                    </span>
                    {provider.maskedKey !== undefined || provider.hasKey ? (
                      <button
                        type="button"
                        onClick={() => void toggleReveal()}
                        aria-label={revealed ? t.agentConfig.hide : t.agentConfig.show}
                        className="shrink-0 rounded-md border border-border px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    ) : null}
                  </div>
                ) : provider.maskedKey ? (
                  // A credential the config names but that is not set (an
                  // environment variable the runtime would look up) is still
                  // worth showing by name — "not set" alone would hide which
                  // variable is missing.
                  <span className="font-mono text-muted-foreground">
                    {provider.maskedKey}
                    <span className="ml-1.5 text-subtle">{t.agentConfig.keyUnset}</span>
                  </span>
                ) : (
                  <span className="text-subtle">{t.agentConfig.keyUnset}</span>
                )}
              </Field>

              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-subtle">
                    {t.agentConfig.models}
                  </span>
                  {editable && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={onEdit}
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                        {t.agentConfig.edit}
                      </button>
                      <button
                        type="button"
                        onClick={onDelete}
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-danger"
                      >
                        <Trash2 className="h-3 w-3" />
                        {t.agentConfig.delete}
                      </button>
                    </div>
                  )}
                </div>

                {provider.models.length === 0 ? (
                  <p className="text-xs text-subtle">{t.agentConfig.noModels}</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full table-fixed text-left text-xs">
                      <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-subtle">
                        <tr>
                          <th className="w-[30%] px-2 py-1.5 font-medium">
                            {t.agentConfig.modelId}
                          </th>
                          <th className="w-[16%] px-2 py-1.5 font-medium">
                            {t.agentConfig.modelName}
                          </th>
                          <th className="w-[12%] px-2 py-1.5 text-right font-medium">
                            {t.agentConfig.contextLimit}
                          </th>
                          <th className="w-[12%] px-2 py-1.5 text-right font-medium">
                            {t.agentConfig.outputLimit}
                          </th>
                          <th className="w-[16%] px-2 py-1.5 font-medium">
                            {t.agentConfig.efforts}
                          </th>
                          <th className="w-[14%] px-1 py-1.5 text-center font-medium">
                            {t.agentConfig.testModel}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {provider.models.map((model) => (
                          <tr key={model.alias} className="border-t border-border">
                            <td className="truncate px-2 py-1.5 font-mono text-foreground" title={model.id}>
                              {model.id}
                            </td>
                            <td className="truncate px-2 py-1.5 text-muted-foreground" title={model.displayName}>
                              {model.displayName}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                              {model.contextLimit?.toLocaleString() ?? '—'}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                              {model.outputLimit?.toLocaleString() ?? '—'}
                            </td>
                            <td className="truncate px-2 py-1.5 text-muted-foreground" title={effortList(model)}>
                              {model.supportEfforts.length === 0 ? (
                                '—'
                              ) : (
                                model.supportEfforts.map((effort, index) => (
                                  <span key={effort}>
                                    {index > 0 && <span className="text-subtle">/</span>}
                                    <span
                                      className={
                                        effort === model.defaultEffort
                                          ? 'font-medium text-foreground'
                                          : undefined
                                      }
                                    >
                                      {effort}
                                    </span>
                                  </span>
                                ))
                              )}
                            </td>
                            <td className="px-1 py-1">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  data-test-model={model.alias}
                                  onClick={() => void runTest(model)}
                                  disabled={tests[model.alias]?.phase === 'testing'}
                                  aria-label={`${t.agentConfig.testModel}: ${model.id}`}
                                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
                                >
                                  {testGlyph(model)}
                                </button>
                                {testText(model) !== '' && (
                                  <span
                                    className={cn(
                                      'text-[10px] tabular-nums',
                                      tests[model.alias]?.phase === 'ok'
                                        ? 'text-online'
                                        : 'text-danger',
                                    )}
                                  >
                                    {testText(model)}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
