import { useT } from '@/i18n/useT'
import { cn } from '@/lib/cn'

export interface AttentionItem {
  /** Stable key (alert id or account row key) */
  key: string
  title: string
  detail: string | null
  level: 'danger' | 'warning' | 'info'
  /** Account row key ("providerId-index"); rows with one open the editor, others jump to alerts */
  editKey?: string
}

export interface AttentionListProps {
  /** Already capped by the caller (dashboard shows a handful, not the full log) */
  items: AttentionItem[]
  onEdit: (rowKey: string) => void
  onViewAll: () => void
  className?: string
}

const DOT: Record<AttentionItem['level'], string> = {
  danger: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-accent',
}

/**
 * "Needs attention" card: error accounts plus unread alerts in one short
 * list. It replaces the full agents table + plan cards on the overview —
 * healthy accounts need no repetition on a dashboard, and both detail views
 * keep living on their own pages.
 */
export function AttentionList({ items, onEdit, onViewAll, className }: AttentionListProps) {
  const t = useT()
  return (
    <section
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl border border-border bg-card',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <h3 className="text-[15px] font-semibold text-foreground">{t.overview.attentionTitle}</h3>
        {items.length > 0 && (
          <button
            type="button"
            onClick={onViewAll}
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t.overview.viewAll}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-5 pb-5 text-xs text-subtle">{t.overview.attentionEmpty}</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => (item.editKey ? onEdit(item.editKey) : onViewAll())}
                className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40"
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[item.level])} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">
                    {item.title}
                  </span>
                  {item.detail && (
                    <span className="mt-0.5 block truncate text-[11px] text-subtle">
                      {item.detail}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
