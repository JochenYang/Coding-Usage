import { ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { EFFORT_LEVELS, MODEL_MODALITIES } from '@/lib/agent-config'

/** Editable draft of one model; numeric fields are strings so typing is free-form */
export interface ModelDraft {
  id: string
  displayName: string
  /** Kept as text: empty means "leave the stored value alone" */
  contextLimit: string
  outputLimit: string
  inputModalities: string[]
  capabilities: string[]
  supportEfforts: string[]
  defaultEffort: string
  /** True for a model that already exists in the file (its id is then fixed) */
  persisted: boolean
  /** Disclosure state of the parameter panel */
  expanded: boolean
}

/** Behavioural flags offered as checkboxes; modality markers live elsewhere */
const BEHAVIOURS = ['tool_use', 'thinking', 'always_thinking'] as const

/** Levels offered in addition to whatever the model already declares */
function effortOptions(current: string[]): string[] {
  const set = new Set<string>([...EFFORT_LEVELS, ...current])
  return [...set]
}

/** Small labelled checkbox shared by the parameter panel and the fetch list */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] text-foreground',
        disabled ? 'opacity-60' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-accent"
      />
      {label}
    </label>
  )
}

export interface ModelEditorProps {
  draft: ModelDraft
  onChange: (patch: Partial<ModelDraft>) => void
  onRemove: () => void
}

/**
 * One row of the model list, with a parameter panel behind a disclosure.
 *
 * The persistent/new distinction matters: an existing model's id is its key in
 * the config file, so editing it would silently delete one model and create
 * another — the field is therefore read-only once saved, while every other
 * parameter stays editable.
 */
export function ModelEditor({ draft, onChange, onRemove }: ModelEditorProps) {
  const t = useT()
  const expanded = draft.expanded

  const modalityLabel = (modality: string): string => {
    switch (modality) {
      case 'text':
        return t.agentConfig.modalityText
      case 'image':
        return t.agentConfig.modalityImage
      case 'video':
        return t.agentConfig.modalityVideo
      case 'audio':
        return t.agentConfig.modalityAudio
      case 'pdf':
        return t.agentConfig.modalityPdf
      default:
        return modality
    }
  }

  const behaviourLabel = (behaviour: string): string => {
    switch (behaviour) {
      case 'tool_use':
        return t.agentConfig.behaviourToolUse
      case 'thinking':
        return t.agentConfig.behaviourThinking
      case 'always_thinking':
        return t.agentConfig.behaviourAlwaysThinking
      default:
        return behaviour
    }
  }

  const toggleIn = (list: string[], value: string, on: boolean): string[] =>
    on ? [...list, value] : list.filter((v) => v !== value)

  const limits = [draft.contextLimit || '—', draft.outputLimit || '—'].join(' / ')

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => onChange({ expanded: !expanded })}
          aria-expanded={expanded}
          aria-label={expanded ? t.agentConfig.collapseModel : t.agentConfig.expandModel}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>

        {draft.persisted ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={draft.id}>
            {draft.id}
          </span>
        ) : (
          <input
            type="text"
            value={draft.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder={t.agentConfig.modelIdPlaceholder}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-xs text-foreground outline-none placeholder:text-subtle focus:border-accent"
          />
        )}

        <input
          type="text"
          value={draft.displayName}
          onChange={(e) => onChange({ displayName: e.target.value })}
          placeholder={t.agentConfig.modelNamePlaceholder}
          className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-0.5 text-xs text-foreground outline-none placeholder:text-subtle focus:border-accent"
        />
        <span className="hidden w-32 shrink-0 text-right text-[11px] tabular-nums text-subtle sm:block">
          {limits}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t.agentConfig.removeModel}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-danger"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t border-border px-3 py-2.5" data-model-params={draft.id}>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-28 flex-1">
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-subtle">
                {t.agentConfig.contextLimit}
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={draft.contextLimit}
                onChange={(e) => onChange({ contextLimit: e.target.value.replace(/[^0-9]/g, '') })}
                placeholder="—"
                className="w-full rounded border border-border bg-card px-2 py-1 text-xs tabular-nums text-foreground outline-none placeholder:text-subtle focus:border-accent"
              />
            </div>
            <div className="min-w-28 flex-1">
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-subtle">
                {t.agentConfig.outputLimit}
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={draft.outputLimit}
                onChange={(e) => onChange({ outputLimit: e.target.value.replace(/[^0-9]/g, '') })}
                placeholder="—"
                className="w-full rounded border border-border bg-card px-2 py-1 text-xs tabular-nums text-foreground outline-none placeholder:text-subtle focus:border-accent"
              />
            </div>
          </div>
          <p className="text-[10px] text-subtle">{t.agentConfig.limitHint}</p>

          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-subtle">
              {t.agentConfig.inputModalities}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {MODEL_MODALITIES.map((modality) => (
                <Checkbox
                  key={modality}
                  label={modalityLabel(modality)}
                  checked={draft.inputModalities.includes(modality)}
                  // Text input is implied by the format itself; offering to
                  // remove it would only produce a config the agent ignores.
                  disabled={modality === 'text'}
                  onChange={(on) =>
                    onChange({ inputModalities: toggleIn(draft.inputModalities, modality, on) })
                  }
                />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-subtle">
              {t.agentConfig.behaviour}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {BEHAVIOURS.map((behaviour) => (
                <Checkbox
                  key={behaviour}
                  label={behaviourLabel(behaviour)}
                  checked={draft.capabilities.includes(behaviour)}
                  onChange={(on) =>
                    onChange({ capabilities: toggleIn(draft.capabilities, behaviour, on) })
                  }
                />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-subtle">
              {t.agentConfig.effortLevels}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {effortOptions(draft.supportEfforts).map((level) => (
                <Checkbox
                  key={level}
                  label={level}
                  checked={draft.supportEfforts.includes(level)}
                  onChange={(on) => {
                    const supportEfforts = toggleIn(draft.supportEfforts, level, on)
                    // A default that is no longer selectable would be rejected
                    // by the agent at request time, so it is dropped with it.
                    const defaultEffort = supportEfforts.includes(draft.defaultEffort)
                      ? draft.defaultEffort
                      : ''
                    onChange({ supportEfforts, defaultEffort })
                  }}
                />
              ))}
            </div>
          </div>

          <div className="max-w-48">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-subtle">
              {t.agentConfig.effortDefault}
            </label>
            <select
              value={draft.defaultEffort}
              onChange={(e) => onChange({ defaultEffort: e.target.value })}
              className="w-full rounded border border-border bg-card px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
            >
              <option value="">{t.agentConfig.effortUnset}</option>
              {draft.supportEfforts.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}
