import { CircleAlert, Info, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { AlertItem, AlertKind, AlertLevel } from '@/lib/alerts'
import { alertDetail, alertTitle } from '@/lib/alert-text'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useT } from '@/i18n/useT'

export interface AlertsPanelProps {
  alerts: AlertItem[]
  onViewAll: () => void
  /** Number of entries rendered (default 3) */
  max?: number
  className?: string
}

/** Icon chip pairing per alert level */
const LEVEL_CHIP: Record<AlertLevel, string> = {
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-accent-soft text-accent',
}

/** Glyph per alert kind: reset windows, quota usage, low balance */
const KIND_ICON: Record<AlertKind, typeof Info> = {
  'window-reset': CircleAlert,
  'high-usage': Lock,
  'low-balance': Info,
}

/** Single alert entry: level chip + title/detail column + relative time */
function AlertRow({ alert, now }: { alert: AlertItem; now: number }) {
  const t = useT()

  const title = alertTitle(alert, t)
  const detail = alertDetail(alert, t)

  return (
    <li className="flex items-center gap-3 py-3">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          LEVEL_CHIP[alert.level],
        )}
      >
        {(() => {
          const Icon = KIND_ICON[alert.kind]
          return <Icon className="h-4 w-4" />
        })()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{title}</div>
        {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
      </div>
      {/* Clock skew can make the diff negative; that still counts as "just now" */}
      <span className="shrink-0 text-[11px] text-subtle">
        {now - alert.firstSeenAt < 60_000
          ? t.overview.agoJust
          : t.overview.agoShort(Math.floor((now - alert.firstSeenAt) / 60_000))}
      </span>
    </li>
  )
}

/** "Recent alerts" card: newest entries first (pre-sorted by the store); resolved history renders only in the alerts center */
export function AlertsPanel({ alerts, onViewAll, max = 3, className }: AlertsPanelProps) {
  const t = useT()
  const now = useNowTick()
  const visible = alerts.filter((a) => !a.resolved).slice(0, max)

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{t.overview.alertsTitle}</h2>
        <button
          type="button"
          onClick={onViewAll}
          className="text-xs text-accent hover:text-accent-strong"
        >
          {t.overview.viewAll}
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-[11px] text-subtle">
          {t.manage.noAlerts}
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {visible.map((alert) => (
            <AlertRow key={alert.id} alert={alert} now={now} />
          ))}
        </ul>
      )}
    </section>
  )
}
