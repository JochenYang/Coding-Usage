import { ExternalLink, Plus } from 'lucide-react'
import type { Dict } from '@/i18n/types'
import type { ProviderDef, ProviderRegion } from '@/types'
import { PROVIDERS } from '@/providers/registry'
import { getProviderEntries } from '@/lib/storage'
import { useData } from '@/lib/data-context'
import { ProviderLogo } from '@/components/ProviderLogo'
import { PageHeader } from '@/components/common/PageHeader'
import { Badge } from '@/components/common/Badge'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/cn'

export interface ProvidersPageProps {
  /** Open the account drawer in create mode for a provider (index = append slot) */
  onAddAccount: (providerId: string, newIndex: number) => void
  /** Open the account drawer for an existing entry */
  onEditAccount: (providerId: string, index: number) => void
}

/**
 * Region list resolution. `ProviderDef.regions` may be a static array or a
 * locale-driven factory; both normalize to an array here so render code stays
 * branch-free.
 */
function resolveRegions(def: ProviderDef, t: Dict): ProviderRegion[] {
  if (typeof def.regions === 'function') return def.regions(t)
  return def.regions ?? []
}

/** External docs/key link with a trailing external-link glyph */
function ProviderLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1 text-xs text-accent hover:text-accent-strong"
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </a>
  )
}

/** One provider card: brand identity, account list, region chips, add + links */
function ProviderCard({
  def,
  onAddAccount,
  onEditAccount,
}: {
  def: ProviderDef
  onAddAccount: (providerId: string, newIndex: number) => void
  onEditAccount: (providerId: string, index: number) => void
}) {
  const t = useT()
  const { settings, results } = useData()
  const regions = resolveRegions(def, t)
  // Every stored entry counts, enabled or not — this is a management overview
  const entries = getProviderEntries(settings, def.id)
  const accountCount = entries.length

  return (
    <article className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <ProviderLogo def={def} className="h-10 w-10" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{def.name}</div>
          <div className="truncate text-xs text-muted-foreground">{def.tagline(t)}</div>
        </div>
      </div>

      <div className="mt-3 text-sm tabular-nums text-muted-foreground">
        {t.manage.accountsCount(accountCount)}
      </div>

      {/* Per-account rows: status dot + name + enablement; clicking opens the editor */}
      {entries.length > 0 && (
        <div className="mt-2 space-y-1">
          {entries.map((cfg, i) => {
            const result = results[`${def.id}-${i}`]
            return (
              <button
                key={`${def.id}-${i}`}
                type="button"
                onClick={() => onEditAccount(def.id, i)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    result?.status === 'ok'
                      ? 'bg-online'
                      : result?.status === 'error'
                        ? 'bg-danger'
                        : 'bg-offline',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {cfg.label?.trim() || t.card.accountIndex(i + 1)}
                </span>
                <Badge tone={cfg.enabled ? 'success' : 'neutral'}>
                  {cfg.enabled ? t.manage.enabled : t.manage.disabled}
                </Badge>
              </button>
            )
          })}
        </div>
      )}

      {regions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {/* Regions are a small fixed set per provider, so id keys cannot collide */}
          {regions.map((region) => (
            <span
              key={region.id}
              className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {region.label}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          onClick={() => onAddAccount(def.id, accountCount)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus className="h-3.5 w-3.5" />
          {t.settings.addAccount}
        </button>
        <ProviderLink href={def.docsUrl} label={t.manage.openDocs} />
        <ProviderLink href={def.keyUrl} label={t.manage.openKey} />
      </div>
    </article>
  )
}

/**
 * Providers page: registry-driven card grid. Each card is an entry point —
 * "add account" opens the editor drawer for that provider; links lead to docs
 * and the key console.
 */
export function ProvidersPage({ onAddAccount, onEditAccount }: ProvidersPageProps) {
  const t = useT()

  return (
    <div className="space-y-4">
      <PageHeader title={t.manage.providersTitle} description={t.manage.providersDesc} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PROVIDERS.map((def) => (
          <ProviderCard
            key={def.id}
            def={def}
            onAddAccount={onAddAccount}
            onEditAccount={onEditAccount}
          />
        ))}
      </div>
    </div>
  )
}
