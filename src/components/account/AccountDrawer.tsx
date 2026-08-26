import { Check, Eye, EyeOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ProviderConfig, ProviderDef, ProviderRegion } from '../../types'
import type { Dict } from '../../i18n/types'
import { fetchUsage } from '../../lib/query'
import { useLocale } from '../../i18n/LocaleProvider'
import { useT } from '../../i18n/useT'
import { Drawer } from '../beui/drawer'
import { Loader } from '../beui/loader'
import { Switch } from '../beui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../beui/select'
import { ProviderLogo } from '../ProviderLogo'

/**
 * Drawer editor scoped to ONE account of one provider (SettingsPanel's
 * EntryEditor interaction model, extracted). When `cfg` is undefined the
 * drawer runs in create mode: the form starts empty and saving produces a
 * brand-new ProviderConfig; otherwise it edits the entry in place.
 */
export interface AccountDrawerProps {
  open: boolean
  def: ProviderDef
  index: number
  /** Undefined = create mode (empty form, save creates the account) */
  cfg: ProviderConfig | undefined
  onSave: (next: ProviderConfig) => void
  /** When provided, a delete button is shown (guarded by window.confirm) */
  onDelete?: () => void
  onClose: () => void
  className?: string
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok' }
  | { phase: 'error'; message: string }

/** Regions may be a static array or a locale-driven factory; normalize to an array. */
function resolveRegions(def: ProviderDef, t: Dict): ProviderRegion[] {
  if (!def.regions) return []
  return typeof def.regions === 'function' ? def.regions(t) : def.regions
}

export function AccountDrawer({
  open,
  def,
  index,
  cfg,
  onSave,
  onDelete,
  onClose,
  className,
}: AccountDrawerProps) {
  const t = useT()
  const { locale } = useLocale()
  const isNew = cfg === undefined

  // Controlled form state, reset from props whenever the drawer opens or the
  // edited entry changes (spec: reset on open / cfg identity change).
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [regionId, setRegionId] = useState<string | undefined>(undefined)
  const [enabled, setEnabled] = useState(true)
  const [showKey, setShowKey] = useState(false)
  const [test, setTest] = useState<TestState>({ phase: 'idle' })

  /** True when the form differs from the persisted config (used for the
   *  unsaved-changes guard on close). Create mode counts any typed content. */
  const isDirty =
    apiKey.trim() !== (cfg?.apiKey ?? '') ||
    label.trim() !== (cfg?.label ?? '') ||
    enabled !== (cfg?.enabled ?? true) ||
    regionId !== cfg?.regionId

  /** Close with a confirmation guard when typed input would be lost */
  const handleClose = () => {
    if (isDirty && !window.confirm(t.settings.unsavedChanges)) return
    onClose()
  }

  useEffect(() => {
    if (!open) return
    setLabel(cfg?.label ?? '')
    setApiKey(cfg?.apiKey ?? '')
    setRegionId(cfg?.regionId)
    setEnabled(cfg?.enabled ?? true)
    setShowKey(false)
    setTest({ phase: 'idle' })
  }, [open, cfg])

  const regions = resolveRegions(def, t)

  /** Build a ProviderConfig from current form values (shared by save and test).
   *  Spreads the existing cfg first so fields outside this form (e.g.
   *  displayCurrencies) survive an edit-mode save. */
  const buildConfig = (): ProviderConfig => ({
    ...cfg,
    enabled,
    apiKey: apiKey.trim(),
    label: label.trim() || undefined,
    // Only multi-region providers carry a regionId; fall back to the first region.
    regionId: regions.length > 0 ? regionId ?? regions[0].id : undefined,
  })

  const handleSave = () => {
    onSave(buildConfig())
    onClose()
  }

  // Create-mode only: append the account and keep the form open, emptied, for
  // the next one — batch-adding several keys in one session.
  const handleSaveAndContinue = () => {
    onSave(buildConfig())
    setLabel('')
    setApiKey('')
    setRegionId(undefined)
    setEnabled(true)
    setShowKey(false)
    setTest({ phase: 'idle' })
  }

  const handleTest = async () => {
    if (!apiKey.trim()) return
    setTest({ phase: 'testing' })
    try {
      const result = await fetchUsage(def, buildConfig(), locale)
      if (result.status === 'ok') {
        setTest({ phase: 'ok' })
      } else {
        setTest({ phase: 'error', message: result.error ?? t.card.error })
      }
    } catch (e) {
      setTest({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleDelete = () => {
    if (onDelete && window.confirm(t.card.deleteHint)) onDelete()
  }

  // Header subtitle: create mode shows the "add" copy; edit mode prefers the
  // current alias input, falling back to the positional #N marker.
  const subtitle = isNew ? t.settings.addAccount : label.trim() || `#${index + 1}`

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && handleClose()}
      ariaLabel={def.name}
      className={className}
    >
      {/* Title bar: top padding clears the Windows caption-button overlay */}
      <div className="flex items-center justify-between border-b border-border bg-card px-5 pb-4 pt-12">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogo def={def} className="h-8 w-8" imgClassName="h-5 w-5" />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">{def.name}</h2>
            <p className="truncate text-xs text-subtle">{subtitle}</p>
          </div>
        </div>
        <button
          onClick={handleClose}
          title={t.settings.close}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Form body */}
      <div className="flex-1 overflow-y-auto bg-background p-4">
        <div className="rounded-xl border border-border bg-muted/60 p-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              ariaLabel={`${t.settings.enabled} ${def.name}`}
            />
            <span className="text-xs text-muted-foreground">{t.settings.enabled}</span>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">
              {t.settings.aliasLabel}
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t.settings.aliasPlaceholder(index + 1)}
              className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground outline-none placeholder:text-subtle focus:border-stone-900"
            />
          </div>

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-[11px] uppercase tracking-wide text-subtle">
                {t.settings.apiKeyLabel}
              </label>
              <a
                href={def.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-stone-600 underline-offset-2 hover:underline"
              >
                {t.settings.getKey}
              </a>
            </div>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t.settings.apiKeyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-subtle focus:border-stone-900"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                title={showKey ? t.settings.hide : t.settings.show}
                className="rounded-lg border border-border bg-card px-2 text-muted-foreground hover:bg-muted"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {regions.length > 0 && (
            <Select value={regionId ?? regions[0].id} onValueChange={setRegionId}>
              <SelectTrigger
                aria-label="Region"
                className="mt-2 w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {regions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 border-t border-border bg-card px-5 py-4">
        {/* Neither dict has a "save" key, so the primary action is an icon-only
            button with an English aria-label — same allowance as the existing
            hardcoded aria-labels (SearchInput "Clear search", Drawer "Close"). */}
        <button
          type="button"
          onClick={handleSave}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Check className="h-4 w-4" />
          {t.settings.save}
        </button>
        {isNew && (
          <button
            type="button"
            onClick={handleSaveAndContinue}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Check className="h-4 w-4" />
            {t.settings.saveContinue}
          </button>
        )}
        <button
          onClick={handleTest}
          disabled={test.phase === 'testing' || !apiKey.trim()}
          className="flex min-w-[64px] items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {test.phase === 'testing' ? (
            <Loader variant="dots" size={14} label={t.settings.testing} />
          ) : (
            t.settings.test
          )}
        </button>
        {/* Inline test outcome: green "normal" on success, red message on failure */}
        <div className="min-w-0 flex-1">
          {test.phase === 'ok' && (
            <p className="truncate text-xs text-emerald-700">✓ {t.card.normal}</p>
          )}
          {test.phase === 'error' && (
            <p className="truncate text-xs text-red-700" title={test.message}>
              ✕ {test.message}
            </p>
          )}
        </div>
        {onDelete && (
          <button
            onClick={handleDelete}
            title={t.settings.deleteTooltip}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-red-50"
          >
            {t.card.delete}
          </button>
        )}
      </div>
    </Drawer>
  )
}
