import { ArrowRight, Zap } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/cn'
import bellArt from '@/assets/dashboard/bell.png'

export interface ActivityItem {
  /** Stable key (alert id or account row key) */
  key: string
  title: string
  detail: string | null
  level: 'danger' | 'warning' | 'info'
  /** When it happened, as a short wall-clock label; blank when unknown */
  time?: string
  /** Account row key ("providerId-index"); rows with one open the editor, others jump to alerts */
  editKey?: string
}

export interface RecentActivityProps {
  /** Already capped by the caller (dashboard shows a handful, not the full log) */
  items: ActivityItem[]
  onEdit: (rowKey: string) => void
  onViewAll: () => void
  className?: string
}

const DOT: Record<ActivityItem['level'], string> = {
  danger: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-accent',
}

/**
 * "Recent activity" card: a short timeline of what happened lately — accounts
 * whose query failed (first: they are the actionable ones) and the alerts
 * still live, newest first. Healthy accounts need no repetition on a
 * dashboard; their detail views keep living on their own pages.
 */
export function RecentActivity({ items, onEdit, onViewAll, className }: RecentActivityProps) {
  const t = useT()
  return (
    <section
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card',
        className,
      )}
    >
      {/* Same 20px top inset as the sibling cards, so the three titles of the
          bottom row sit on one line */}
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-foreground">
          <Zap className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="truncate">{t.overview.attentionTitle}</span>
        </h2>
        {items.length > 0 && (
          <button
            type="button"
            onClick={onViewAll}
            className="group flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-accent-text transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t.overview.viewMore}
            <ArrowRight
              className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-5 pb-4 pt-1 text-center">
          <img src={bellArt} alt="" aria-hidden className="h-20 w-auto select-none" />
          <p className="mt-1 text-xs text-muted-foreground">{t.overview.attentionEmpty}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => (item.editKey ? onEdit(item.editKey) : onViewAll())}
                className="group flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[item.level])} aria-hidden />
                {/* Fixed-width column: every entry's text starts at the same x */}
                <span className="w-10 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {item.time ?? ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">
                    {item.title}
                  </span>
                  {item.detail && (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {item.detail}
                    </span>
                  )}
                </span>
                <ArrowRight
                  className="h-3.5 w-3.5 shrink-0 text-subtle transition-colors group-hover:text-accent"
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
