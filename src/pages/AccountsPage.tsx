import { Settings, Trash2, Users } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { getProviderEntries } from '@/lib/storage'
import { PROVIDERS } from '@/providers/registry'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { Badge } from '@/components/common/Badge'
import { AddAccountMenu } from '@/components/account/AddAccountMenu'
import { ProviderLogo } from '@/components/ProviderLogo'
import { formatAgo } from '@/lib/format'

export interface AccountsPageProps {
  /** Open the account drawer for an existing entry (page never hosts the drawer itself) */
  onEditAccount: (providerId: string, index: number) => void
  /** Open the account drawer in create mode at the given new entry index */
  onAddAccount: (providerId: string, newIndex: number) => void
}

/**
 * Account management page: credential-centric view grouping every account
 * under its provider. Whole rows open the editor via callback; the page keeps
 * no drawer of its own.
 */
export function AccountsPage({ onEditAccount, onAddAccount }: AccountsPageProps) {
  const t = useT()
  const { settings, results, deleteEntry } = useData()

  // Only providers that actually hold accounts form a group; registry order kept
  const groups = PROVIDERS.flatMap((def) => {
    const entries = getProviderEntries(settings, def.id)
    return entries.length > 0 ? [{ def, entries }] : []
  })

  if (groups.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t.manage.accountsTitle}
          description={t.manage.accountsDesc}
          actions={<AddAccountMenu onAdd={onAddAccount} />}
        />
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title={t.manage.noAccounts}
          action={<AddAccountMenu onAdd={onAddAccount} />}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t.manage.accountsTitle}
        description={t.manage.accountsDesc}
        actions={<AddAccountMenu onAdd={onAddAccount} />}
      />

      <div className="space-y-6">
        {groups.map(({ def, entries }) => (
          <section key={def.id} className="space-y-2">
            {/* Group head: brand mark + provider name + account count */}
            <div className="flex items-center gap-2 px-1">
              <ProviderLogo def={def} className="h-7 w-7" imgClassName="h-4 w-4" />
              <h3 className="text-sm font-semibold text-foreground">{def.name}</h3>
              <span className="text-xs text-subtle">{t.manage.accountsCount(entries.length)}</span>
            </div>

            {entries.map((cfg, i) => {
              // Result key matches the data layer convention `${providerId}-${index}`
              const fetchedAt = results[`${def.id}-${i}`]?.fetchedAt
              return (
                <div
                  key={`${def.id}-${i}`}
                  onClick={() => onEditAccount(def.id, i)}
                  className="flex cursor-pointer items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-stone-300 hover:bg-muted/40"
                >
                  {/* Left: alias / positional name + masked key tail */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {cfg.label?.trim() || t.card.accountIndex(i + 1)}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-subtle">
                      {cfg.apiKey ? `•••• ${cfg.apiKey.slice(-4)}` : t.card.unconfigured}
                    </p>
                  </div>
                  {/* Middle: enablement badge */}
                  <Badge tone={cfg.enabled ? 'success' : 'neutral'}>
                    {cfg.enabled ? t.manage.enabled : t.manage.disabled}
                  </Badge>
                  {/* Right: last successful fetch time + edit affordance */}
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {t.manage.lastOk}
                    </span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-foreground">
                      {fetchedAt ? formatAgo(fetchedAt, Date.now(), t) : t.manage.never}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      // Row click already opens the editor; avoid double firing
                      e.stopPropagation()
                      onEditAccount(def.id, i)
                    }}
                    title={t.card.goSettings}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(t.manage.deleteConfirm)) deleteEntry(def.id, i)
                    }}
                    title={t.settings.deleteTooltip}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
