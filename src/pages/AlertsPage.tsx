import { useEffect, useMemo, useState } from 'react'
import { Bell, Info, TriangleAlert } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/beui/select'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'
import { useData } from '@/lib/data-context'
import type { AlertItem, AlertLevel } from '@/lib/alerts'
import { currencySymbol, formatAmount } from '@/lib/format'
import { formatCompactValue } from '@/components/charts/DonutChart'

export interface AlertsPageProps {
  className?: string
}

type AlertFilter = 'all' | 'unread'

/** Icon chip pairing per alert level; mirrors AlertsPanel so both views match */
const LEVEL_CHIP: Record<AlertLevel, string> = {
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-accent-soft text-accent',
}

/**
 * Minute-resolution clock for relative timestamps; re-renders every 30s so
 * "just now" rows age into minutes. Same approach as AlertsPanel's tick.
 */
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Title text per alert kind; same mapping as AlertsPanel */
function alertTitle(alert: AlertItem, t: Dict): string {
  if (alert.kind === 'window-reset') return t.overview.alertWindowReset(alert.agentName)
  if (alert.kind === 'high-usage') return t.overview.alertHighUsage(alert.agentName, alert.pct ?? 0)
  return t.overview.alertLowBalance(alert.agentName)
}

/** Kind-specific detail line; omitted when the numeric payload is missing */
function alertDetail(alert: AlertItem, t: Dict): string | null {
  if (alert.kind === 'window-reset' && alert.resetInMin != null) {
    return t.overview.alertResetSoon(alert.resetInMin)
  }
  if (alert.kind === 'high-usage' && alert.used != null && alert.total != null) {
    return t.overview.alertUsedDetail(
      formatCompactValue(alert.used),
      formatCompactValue(alert.total),
    )
  }
  if (alert.kind === 'low-balance' && alert.balance != null && alert.currency != null) {
    return t.overview.alertBalanceDetail(`${currencySymbol(alert.currency)}${formatAmount(alert.balance)}`)
  }
  return null
}

interface AlertRowProps {
  alert: AlertItem
  now: number
  onRead: (id: string) => void
}

/**
 * Full-width clickable alert row: level chip + title/detail + relative time.
 * Unread rows show a 2px accent bar on the left; read rows are dimmed.
 */
function AlertRow({ alert, now, onRead }: AlertRowProps) {
  const t = useT()
  const detail = alertDetail(alert, t)

  return (
    <li className={cn(alert.read && 'opacity-70')}>
      {/* Whole row is the click target; one click marks this single alert read */}
      <button
        type="button"
        onClick={() => onRead(alert.id)}
        className="relative flex w-full items-center gap-3 py-3 pr-1 pl-4 text-left transition-colors hover:bg-muted/40"
      >
        {!alert.read && (
          <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />
        )}
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            LEVEL_CHIP[alert.level],
          )}
        >
          {alert.level === 'info' ? <Info className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">
            {alertTitle(alert, t)}
          </span>
          {detail && <span className="block text-[11px] text-muted-foreground">{detail}</span>}
        </span>
        {/* Clock skew can make the diff negative; that still counts as "just now" */}
        <span className="shrink-0 text-[11px] text-subtle">
          {now - alert.firstSeenAt < 60_000
            ? t.overview.agoJust
            : t.overview.agoShort(Math.floor((now - alert.firstSeenAt) / 60_000))}
        </span>
      </button>
    </li>
  )
}

/** Alerts center: filterable full list of alerts plus a static rules reference */
export function AlertsPage({ className }: AlertsPageProps) {
  const t = useT()
  const { alerts, markAllAlertsRead, markAlertRead } = useData()
  const [filter, setFilter] = useState<AlertFilter>('all')
  const now = useNowTick()

  const visible = useMemo(
    () => (filter === 'unread' ? alerts.filter((a) => !a.read) : alerts),
    [alerts, filter],
  )

  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader
        title={t.manage.alertsCenterTitle}
        description={t.manage.alertsDesc}
        actions={
          <>
            <Select value={filter} onValueChange={(v) => setFilter(v === 'unread' ? 'unread' : 'all')}>
              <SelectTrigger className="w-24 rounded-lg border-border bg-card px-3 py-1.5 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t.manage.filterAll}</SelectItem>
                <SelectItem value="unread">{t.manage.filterUnread}</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={markAllAlertsRead}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              {t.manage.markAllRead}
            </button>
          </>
        }
      />

      {visible.length === 0 ? (
        <EmptyState icon={<Bell className="h-6 w-6" />} title={t.manage.noAlerts} />
      ) : (
        <section className="rounded-2xl border border-border bg-card px-5 py-1">
          <ul className="divide-y divide-border/60">
            {visible.map((item) => (
              <AlertRow key={item.id} alert={item} now={now} onRead={markAlertRead} />
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t.manage.rulesTitle}</h2>
        <ul className="mt-3 space-y-2">
          <li className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="text-xs text-muted-foreground">{t.manage.ruleReset}</span>
          </li>
          <li className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="text-xs text-muted-foreground">{t.manage.ruleHigh}</span>
          </li>
          <li className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="text-xs text-muted-foreground">{t.manage.ruleLow}</span>
          </li>
        </ul>
      </section>
    </div>
  )
}
