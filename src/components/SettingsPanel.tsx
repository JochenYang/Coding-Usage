import { Eye, EyeOff, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { ProviderConfig, ProviderDef, Settings } from '../types'
import { PROVIDERS } from '../providers/registry'
import { getProviderEntries } from '../lib/storage'
import { fetchUsage, pingProxy } from '../lib/query'
import { useT } from '../i18n/useT'
import { Switch } from './beui/switch'
import { Loader } from './beui/loader'
import { Drawer } from './beui/drawer'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './beui/select'
import { ProviderLogo } from './ProviderLogo'

interface SettingsPanelProps {
  open: boolean
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
  onAddEntry: (providerId: string) => void
  onDeleteEntry: (providerId: string, index: number) => void
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string }

function EntryEditor({
  def,
  cfg,
  index,
  totalEntries,
  test,
  onPatch,
  onDelete,
  onTest,
}: {
  def: ProviderDef
  cfg: ProviderConfig
  index: number
  totalEntries: number
  test: TestState
  onPatch: (patch: Partial<ProviderConfig>) => void
  onDelete: () => void
  onTest: () => void
}) {
  const t = useT()
  const [showKey, setShowKey] = useState(false)
  const subLabel = cfg.label?.trim() || (totalEntries > 1 ? `账户 ${index + 1}` : '')
  return (
    <div className="rounded-xl border border-border bg-muted/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full bg-gradient-to-r ${def.accent}`} />
          <span className="text-xs font-semibold text-foreground">{subLabel || def.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onDelete}
            title={t.settings.deleteTooltip}
            className="rounded-md p-1 text-subtle hover:bg-red-50 hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Switch
          checked={cfg.enabled}
          onCheckedChange={(enabled) => onPatch({ enabled })}
          ariaLabel={`${t.settings.enabled} ${def.name} ${subLabel}`}
        />
        <span className="text-xs text-muted-foreground">{t.settings.enabled}</span>
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">{t.settings.aliasLabel}</label>
        <input
          type="text"
          value={cfg.label ?? ''}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder={t.settings.aliasPlaceholder(totalEntries)}
          className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground outline-none placeholder:text-subtle focus:border-stone-900"
        />
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">{t.settings.apiKeyLabel}</label>
        <div className="flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={cfg.apiKey}
            onChange={(e) => onPatch({ apiKey: e.target.value })}
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
          <button
            onClick={onTest}
            disabled={test.phase === 'testing' || !cfg.apiKey}
            className="flex min-w-[64px] items-center justify-center gap-1.5 rounded-lg bg-stone-900 px-3 text-xs font-medium text-stone-50 hover:bg-stone-800 disabled:opacity-50"
          >
            {test.phase === 'testing' ? (
              <Loader variant="dots" size={14} label={t.settings.testing} />
            ) : (
              t.settings.test
            )}
          </button>
        </div>
        {def.regions && (() => {
          const regions = typeof def.regions === 'function' ? def.regions(t) : def.regions
          return (
            <Select
              value={cfg.regionId ?? regions[0].id}
              onValueChange={(v) => onPatch({ regionId: v })}
            >
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
          )
        })()}
        {def.id === 'deepseek' && (
          <div className="mt-3">
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-subtle">
              {t.card.displayCurrencies}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {(['CNY', 'USD'] as const).map((c) => {
                const checked = cfg.displayCurrencies?.includes(c) ?? false
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      const cur = cfg.displayCurrencies ?? []
                      const next = checked ? cur.filter((x) => x !== c) : [...cur, c]
                      onPatch({ displayCurrencies: next.length ? next : undefined })
                    }}
                    className={
                      'rounded-md border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ' +
                      (checked
                        ? 'border-stone-900 bg-stone-900 text-stone-50'
                        : 'border-border bg-card text-foreground hover:bg-muted')
                    }
                    aria-pressed={checked}
                  >
                    {c}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 text-[11px] text-subtle">{t.card.displayCurrenciesHint}</p>
          </div>
        )}
      </div>
      {test.phase === 'success' && (
        <p className="mt-2 text-xs text-emerald-700">✓ {test.message}</p>
      )}
      {test.phase === 'error' && <p className="mt-2 text-xs text-red-700">✕ {test.message}</p>}
    </div>
  )
}

export function SettingsPanel({
  open,
  settings,
  onChange,
  onClose,
  onAddEntry,
  onDeleteEntry,
}: SettingsPanelProps) {
  const t = useT()
  const [tests, setTests] = useState<Record<string, TestState>>({})

  const patchEntry = (providerId: string, index: number, patch: Partial<ProviderConfig>) => {
    const entries = getProviderEntries(settings, providerId).slice()
    if (!entries[index]) entries[index] = { enabled: false, apiKey: '' }
    entries[index] = { ...entries[index], ...patch }
    onChange({ ...settings, providers: { ...settings.providers, [providerId]: entries } })
  }

  const runTest = async (def: ProviderDef, cfg: ProviderConfig, index: number) => {
    if (!cfg.apiKey) return
    const testKey = `${def.id}-${index}`
    setTests((t) => ({ ...t, [testKey]: { phase: 'testing' } }))
    try {
      const proxyOnline = await pingProxy()
      const result = await fetchUsage(def, cfg, proxyOnline)
      if (result.status === 'ok' && result.metrics) {
        const summary = result.metrics
          .map((m) =>
            m.kind === 'percent'
              ? `${m.label} ${Math.round(m.percent ?? 0)}%`
              : `${m.label} ${m.remaining ?? '—'}${m.unit ?? ''}`,
          )
          .join('；')
        setTests((prev) => ({ ...prev, [testKey]: { phase: 'success', message: summary } }))
      } else if (result.status === 'needs-proxy') {
        setTests((prev) => ({
          ...prev,
          [testKey]: { phase: 'error', message: t.settings.needsProxyError },
        }))
      } else {
        setTests((prev) => ({
          ...prev,
          [testKey]: { phase: 'error', message: result.error ?? t.card.error },
        }))
      }
    } catch (e) {
      setTests((prev) => ({
        ...prev,
        [testKey]: { phase: 'error', message: e instanceof Error ? e.message : String(e) },
      }))
    }
  }

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} ariaLabel={t.settings.title}>
      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-4">
        <h2 className="text-base font-semibold text-foreground">{t.settings.title}</h2>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t.settings.close}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto bg-background p-4">
        {PROVIDERS.map((def) => {
          const entries = getProviderEntries(settings, def.id)
          return (
            <section key={def.id}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ProviderLogo def={def} className="h-6 w-6" imgClassName="h-4 w-4" />
                  <h3 className="text-sm font-semibold text-foreground">{def.name}</h3>
                  <a
                    href={def.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-stone-600 underline-offset-2 hover:underline"
                  >
                    {t.settings.getKey}
                  </a>
                </div>
                <button
                  onClick={() => onAddEntry(def.id)}
                  className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <Plus className="h-3 w-3" />
                  {t.settings.addAccount}
                </button>
              </div>
              <div className="space-y-3">
                {entries.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border bg-card p-4 text-center text-xs text-subtle">
                    {t.settings.noAccount}
                  </div>
                )}
                {entries.map((cfg, i) => (
                  <EntryEditor
                    key={i}
                    def={def}
                    cfg={cfg}
                    index={i}
                    totalEntries={entries.length}
                    test={tests[`${def.id}-${i}`] ?? { phase: 'idle' }}
                    onPatch={(patch) => patchEntry(def.id, i, patch)}
                    onDelete={() => onDeleteEntry(def.id, i)}
                    onTest={() => runTest(def, cfg, i)}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
      
    </Drawer>
  )
}
