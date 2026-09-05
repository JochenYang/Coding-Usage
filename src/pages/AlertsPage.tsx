import { useMemo, useState } from 'react'
import { Bell, CircleAlert, Info, Lock } from 'lucide-react'
import { Switch } from '@/components/beui/switch'
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
import { useData } from '@/lib/data-context'
import type { AlertItem, AlertLevel } from '@/lib/alerts'
import { alertDetail, alertTitle } from '@/lib/alert-text'
import { useNowTick } from '@/lib/hooks/use-now-tick'

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
          {
            alert.kind === 'window-reset' ? (
              <CircleAlert className="h-4 w-4" />
            ) : alert.kind === 'high-usage' ? (
              <Lock className="h-4 w-4" />
            ) : (
              <Info className="h-4 w-4" />
            )
          }
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
  const { alerts, markAllAlertsRead, markAlertRead, settings, updateSettings } = useData()
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
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t.manage.rulesTitle}</h2>
          <div className="flex shrink-0 items-center gap-3">
            {/* Desktop island overlay toggle: only meaningful inside Electron */}
            {window.desktopBridge && (
              <label className="flex items-center gap-2" title={t.island.desktopHint}>
                <span className="text-[11px] text-muted-foreground">{t.island.desktopToggle}</span>
                <Switch
                  checked={settings.desktopIsland}
                  ariaLabel={t.island.desktopToggle}
                  onCheckedChange={(on) => updateSettings({ ...settings, desktopIsland: on })}
                />
              </label>
            )}
          </div>
        </div>
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
