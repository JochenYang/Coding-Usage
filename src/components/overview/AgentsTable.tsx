import { useMemo, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import { ProviderLogo } from '../ProviderLogo'
import { ProgressBar } from '../common/ProgressBar'
import { SearchInput } from '../common/SearchInput'
import { StatusDot } from '../common/StatusDot'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../beui/select'
import type { AgentRowVM } from '@/lib/overview'
import { currencySymbol, formatAmount, formatCompactValue } from '@/lib/format'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'
import { cn } from '@/lib/cn'

export interface AgentsTableProps {
  rows: AgentRowVM[]
  /** Row key ("providerId-index") → open the account editor for that entry */
  onEdit: (rowKey: string) => void
  className?: string
}

/** Sentinel select values for the "no filter" options (locale-independent) */
const ALL_PROVIDERS = 'all'
const ALL_STATUSES = 'all'

type StatusFilter = typeof ALL_STATUSES | 'online' | 'offline' | 'error'

/** Padding shared by every header/body cell; edges align with the card padding */
const CELL = 'px-3 py-3 first:pl-5 last:pr-4'

/**
 * Plan label keyed by provider id — Dict.providers keys mirror the registry
 * ids one-to-one; an unknown id degrades to an em dash instead of throwing.
 */
function providerPlan(t: Dict, providerId: string): string {
  if (!(providerId in t.providers)) return '—'
  return t.providers[providerId as keyof Dict['providers']].plan
}

/** Agents overview card: searchable/filterable table of per-account agents */
export function AgentsTable({ rows, onEdit, className }: AgentsTableProps) {
  const t = useT()
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState(ALL_PROVIDERS)
  const [status, setStatus] = useState<StatusFilter>(ALL_STATUSES)

  // Provider dropdown options: distinct providerName in first-seen order
  const providerNames = useMemo(() => [...new Set(rows.map((r) => r.providerName))], [rows])

  // Search matches name/providerName case-insensitively, combined with both selects
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.providerName.toLowerCase().includes(q)) {
        return false
      }
      if (provider !== ALL_PROVIDERS && r.providerName !== provider) return false
      if (status !== ALL_STATUSES && r.status !== status) return false
      return true
    })
  }, [rows, search, provider, status])

  return (
    <section
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl border border-border bg-card',
        className,
      )}
    >
      {/* Header: title + search / provider / status filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <h3 className="text-[15px] font-semibold text-foreground">{t.overview.agentsTitle}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t.overview.searchAgent}
            className="w-56"
          />
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-36 rounded-lg border-border bg-card px-3 py-1.5 text-sm">
              <SelectValue placeholder={t.overview.allProviders} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROVIDERS}>{t.overview.allProviders}</SelectItem>
              {providerNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="w-32 rounded-lg border-border bg-card px-3 py-1.5 text-sm">
              <SelectValue placeholder={t.overview.allStatus} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>{t.overview.allStatus}</SelectItem>
              <SelectItem value="online">{t.overview.statusOnline}</SelectItem>
              <SelectItem value="offline">{t.overview.statusOffline}</SelectItem>
              <SelectItem value="error">{t.card.error}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Scroll region: caps the card's height on the overview canvas and lets
          big account lists scroll internally instead of stretching the page */}
      <div className="max-h-[440px] flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {/* Label columns carry their alignment so headers line up with cells */}
              {[
                { label: t.overview.colAgent, align: 'text-left' },
                { label: t.overview.colProvider, align: 'text-left' },
                { label: t.overview.colPlan, align: 'text-left' },
                { label: t.overview.colUsage, align: 'text-left' },
                { label: t.overview.colQuota, align: 'text-left' },
                { label: t.overview.colBalance, align: 'text-right' },
                { label: t.overview.colStatus, align: 'text-left' },
                { label: t.overview.colActions, align: 'text-right' },
              ].map((col) => (
                <th
                  key={col.label}
                  scope="col"
                  className={cn(
                    CELL,
                    'sticky top-0 z-10 whitespace-nowrap border-b border-border bg-card text-xs font-normal text-muted-foreground',
                    col.align,
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className={cn(CELL, 'py-10 text-center text-xs text-subtle')}>
                  {t.overview.emptyTitle}
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/40"
                >
                  {/* Agent: brand mark + alias (error detail underneath when failing) */}
                  <td className={CELL}>
                    <div className="flex items-center gap-2.5">
                      <ProviderLogo def={row.logoDef} className="h-7 w-7" imgClassName="h-4 w-4" />
                      <div className="min-w-0">
                        <span className="block max-w-[140px] truncate font-medium text-foreground">
                          {row.name}
                        </span>
                        {row.status === 'error' && row.errorText && (
                          <span className="mt-0.5 block max-w-[200px] truncate text-[11px] text-danger">
                            {row.errorText}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap text-muted-foreground')}>
                    {row.providerName}
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap')}>{providerPlan(t, row.providerId)}</td>
                  <td className={CELL}>
                    {/* N/A cells stay empty on purpose: dashes read as data and
                        misalign the columns to their right */}
                    {row.usagePct == null ? null : (
                      <div className="flex w-fit items-center gap-2">
                        <ProgressBar percent={row.usagePct} size="sm" className="w-24" />
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {Math.round(row.usagePct)}%
                        </span>
                      </div>
                    )}
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap text-xs tabular-nums')}>
                    {row.unlimited
                      ? t.metric.unlimited
                      : row.used != null && row.total != null
                        ? `${formatCompactValue(row.used)} / ${formatCompactValue(row.total)}`
                        : null}
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap text-right text-xs tabular-nums')}>
                    {row.balance
                      ? `${currencySymbol(row.balance.currency)}${formatAmount(row.balance.amount)}`
                      : null}
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap')}>
                    <span className="flex items-center gap-2">
                      <StatusDot online={row.status === 'online'} />
                      <span
                        className={cn(
                          row.status === 'online'
                            ? 'text-online'
                            : row.status === 'error'
                              ? 'text-danger'
                              : 'text-muted-foreground',
                        )}
                      >
                        {row.status === 'online'
                          ? t.overview.statusOnline
                          : row.status === 'error'
                            ? t.card.error
                            : t.overview.statusOffline}
                      </span>
                    </span>
                  </td>
                  <td className={cn(CELL, 'text-right')}>
                    {/* Opens the account editor for this row's provider entry */}
                    <button
                      type="button"
                      onClick={() => onEdit(row.key)}
                      aria-label={t.overview.colActions}
                      className="rounded p-1 transition-colors hover:bg-muted"
                    >
                      <Ellipsis className="h-4 w-4 text-subtle transition-colors hover:text-foreground" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer count reflects the currently filtered rows */}
      <div className="px-5 py-3 text-xs text-subtle">{t.overview.shownAgents(filtered.length)}</div>
    </section>
  )
}
