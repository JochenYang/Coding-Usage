import { useEffect, useState } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { AlertItem, AlertLevel } from '@/lib/alerts'
import { currencySymbol, formatAmount } from '@/lib/format'
import { formatCompactValue } from '@/components/charts/DonutChart'
import { useT } from '@/i18n/useT'

export interface AlertsPanelProps {
  alerts: AlertItem[]
  onViewAll: () => void
  /** Number of entries rendered (default 3) */
  max?: number
  className?: string
}

/** Icon chip pairing per alert level; danger/warning share the same glyph */
const LEVEL_CHIP: Record<AlertLevel, string> = {
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-accent-soft text-accent',
}

/**
 * Minute-resolution clock for relative timestamps; re-renders every 30s so
 * "just now" rows age into minutes without any external timer wiring.
 */
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Single alert entry: level chip + title/detail column + relative time */
function AlertRow({ alert, now }: { alert: AlertItem; now: number }) {
  const t = useT()

  // Title always renders; kind-specific params are optional so guard each
  const title =
    alert.kind === 'window-reset'
      ? t.overview.alertWindowReset(alert.agentName)
      : alert.kind === 'high-usage'
        ? t.overview.alertHighUsage(alert.agentName, alert.pct ?? 0)
        : t.overview.alertLowBalance(alert.agentName)

  // Detail is omitted when its numeric payload is missing
  let detail: string | null = null
  if (alert.kind === 'window-reset' && alert.resetInMin != null) {
    detail = t.overview.alertResetSoon(alert.resetInMin)
  } else if (alert.kind === 'high-usage' && alert.used != null && alert.total != null) {
    detail = t.overview.alertUsedDetail(
      formatCompactValue(alert.used),
      formatCompactValue(alert.total),
    )
  } else if (alert.kind === 'low-balance' && alert.balance != null && alert.currency != null) {
    detail = t.overview.alertBalanceDetail(
      `${currencySymbol(alert.currency)}${formatAmount(alert.balance)}`,
    )
  }

  return (
    <li className="flex items-center gap-3 py-3">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          LEVEL_CHIP[alert.level],
        )}
      >
        {alert.level === 'info' ? (
          <Info className="h-4 w-4" />
        ) : (
          <TriangleAlert className="h-4 w-4" />
        )}
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

/** "Recent alerts" card: newest entries first (pre-sorted by the store) */
export function AlertsPanel({ alerts, onViewAll, max = 3, className }: AlertsPanelProps) {
  const t = useT()
  const now = useNowTick()
  const visible = alerts.slice(0, max)

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
          {t.overview.emptyTitle}
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
