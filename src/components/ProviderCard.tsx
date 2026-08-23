import { Loader } from './beui/loader'
import { RefreshCw, X } from 'lucide-react'
import type { ProviderConfig, ProviderDef, ProviderResult } from '../types'
import type { Dict } from '../i18n/types'
import { formatAgo } from '../lib/format'
import { useT } from '../i18n/useT'
import { MetricList } from './MetricList'
import { ProviderLogo } from './ProviderLogo'
import { Popover, PopoverContent, PopoverTrigger } from './beui/popover'

function StatusDot({ result }: { result: ProviderResult | undefined }) {
  const color =
    result?.status === 'ok'
      ? 'bg-success'
      : result?.status === 'error'
        ? 'bg-danger'
        : result?.status === 'needs-proxy'
          ? 'bg-warning'
          : 'bg-muted-foreground/40'
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
}

function CardBody({
  result,
  cfg,
  t,
  onGoSettings,
}: {
  result: ProviderResult | undefined
  cfg: ProviderConfig
  t: Dict
  onGoSettings: () => void
}) {
  if (result?.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy>
        <Loader variant="dots" size={14} speed={1.2} label={t.card.loading} />
        <span>{t.card.loading}</span>
      </div>
    )
  }
  if (result?.status === 'ok' && result.metrics) {
    // Multi-currency providers (e.g. DeepSeek) honor cfg.displayCurrencies when set.
    // When unset, every metric the adapter returned is shown.
    const filtered = cfg.displayCurrencies?.length
      ? result.metrics.filter((m) => m.unit != null && cfg.displayCurrencies!.includes(m.unit))
      : result.metrics
    if (filtered.length === 0) {
      return (
        <div className="text-xs text-subtle">
          {t.card.unconfigured}
          <button className="ml-1 text-stone-700 underline-offset-2 hover:underline" onClick={onGoSettings}>
            {t.card.goSettings}
          </button>
        </div>
      )
    }
    return <MetricList metrics={filtered} />
  }
  if (result?.status === 'needs-proxy') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
        <div className="mb-1 font-semibold">{t.card.needsProxy}</div>
        {t.card.needsProxyDetail}
        <code className="mx-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono">npm run proxy</code>
        {t.card.needsProxyAfter}
      </div>
    )
  }
  if (result?.status === 'error') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-relaxed text-red-700">
        {result.error ?? t.card.error}
      </div>
    )
  }
  return (
    <div className="text-xs text-subtle">
      {t.card.unconfigured}
      <button className="ml-1 text-stone-700 underline-offset-2 hover:underline" onClick={onGoSettings}>
        {t.card.goSettings}
      </button>
    </div>
  )
}

export function ProviderCard({
  def,
  cfg,
  index,
  totalEntries,
  result,
  onRefresh,
  onGoSettings,
  onDelete,
}: {
  def: ProviderDef
  cfg: ProviderConfig
  index: number
  totalEntries: number
  result: ProviderResult | undefined
  onRefresh: () => void
  onGoSettings: () => void
  onDelete: () => void
}) {
  const t = useT()
  const isLoading = result?.status === 'loading'
  const subLabel = cfg.label?.trim() || (totalEntries > 1 ? t.card.accountIndex(index + 1) : '')
  const caption = subLabel ? `${def.tagline(t)} · ${subLabel}` : def.tagline(t)
  const statusText =
    result?.status === 'ok'
      ? t.card.normal
      : result?.status === 'error'
        ? t.card.error
        : result?.status === 'needs-proxy'
          ? t.card.needsProxy
          : result == null
            ? t.card.unconfigured
            : null
  return (
    <div className="group relative flex overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all hover:border-stone-300 hover:shadow-md">
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <ProviderLogo def={def} className="h-9 w-9" imgClassName="h-5 w-5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <StatusDot result={result} />
                <h2 className="truncate text-sm font-semibold text-foreground">{def.name}</h2>
                {!isLoading && statusText && (
                  <span className="shrink-0 text-[11px] text-subtle">{statusText}</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {result?.fetchedAt && !isLoading && (
                  <span className="text-[11px] text-subtle">{formatAgo(result.fetchedAt, Date.now(), t)}</span>
                )}
                <Popover key={`refresh-${result?.fetchedAt ?? 'init'}`} trigger="hover" side="top" align="center" sideOffset={2}>
                  <PopoverTrigger>
                    <button
                      onClick={onRefresh}
                      disabled={isLoading}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      {isLoading ? (
                        <Loader variant="spinner" size={13} speed={1.4} label={t.card.refreshing} />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <div className="text-xs text-popover-foreground">{t.card.refresh}</div>
                  </PopoverContent>
                </Popover>
                <Popover key={`delete-${result?.fetchedAt ?? 'init'}`} trigger="hover" side="top" align="center" sideOffset={2}>
                  <PopoverTrigger>
                    <button
                      onClick={onDelete}
                      className="rounded-md p-1 text-subtle transition-all hover:bg-red-50 hover:text-danger"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <div className="text-xs text-popover-foreground">{t.card.deleteHint}</div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-subtle">{caption}</p>
          </div>
        </div>
        <CardBody result={result} cfg={cfg} t={t} onGoSettings={onGoSettings} />
      </div>
    </div>
  )
}
