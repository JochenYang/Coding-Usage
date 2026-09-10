import { useMemo, useState } from 'react'
import { Bell, CircleAlert, Info, Lock } from 'lucide-react'
import { Switch } from '@/components/beui/switch'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { Tooltip } from '@/components/common/Tooltip'
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
import { resolveThresholds } from '@/lib/alerts'
import type { AlertThresholds } from '@/types'
import { useNowTick } from '@/lib/hooks/use-now-tick'

export interface AlertsPageProps {
  className?: string
}

type AlertFilter = 'all' | 'unread'

/** Balance floors are edited per currency; the engine matches metric units case-insensitively */
const LOW_BALANCE_CURRENCIES = ['CNY', 'USD', 'HKD', 'TWD']

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
      {/* One click marks this single alert read. Deliberately no hover
          affordance: the click is a quiet "dismiss" interaction, not a
          navigation — a hover highlight would promise an action that
          never comes. */}
      <button
        type="button"
        onClick={() => onRead(alert.id)}
        className="relative flex w-full items-center gap-3 py-3 pr-1 pl-4 text-left"
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
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {alertTitle(alert, t)}
            </span>
            {alert.resolved && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-subtle">
                {t.manage.alertResolved}
              </span>
            )}
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

/** Alerts center: filterable full list of alerts plus editable rule thresholds */
export function AlertsPage({ className }: AlertsPageProps) {
  const t = useT()
  const { alerts, markAllAlertsRead, markAlertRead, settings, updateSettings } = useData()
  const [filter, setFilter] = useState<AlertFilter>('all')
  const now = useNowTick()
  const thresholds = settings.alertThresholds

  const visible = useMemo(
    () => (filter === 'unread' ? alerts.filter((a) => !a.read && !a.resolved) : alerts),
    [alerts, filter],
  )

  // Threshold edits commit on every valid keystroke (invalid/empty input is
  // ignored, so the field never writes garbage); resolveThresholds clamps.
  const setThresholds = (patch: Partial<AlertThresholds>) => {
    updateSettings({
      ...settings,
      alertThresholds: resolveThresholds({ ...thresholds, ...patch }),
    })
  }

  return (
    // Full-height column: min-height is viewport-based (the shell's inner
    // wrapper is height:auto, so min-h-full would resolve to auto and never
    // stretch). 100vh minus the h-14 top bar and the shell's vertical py-6.
    // The rules card pins to the bottom with ~48px off the window edge even
    // when the alert list is empty; the empty state centers in the freed space.
    <div className={cn('flex min-h-[calc(100vh-6.5rem)] flex-col gap-4 pb-6', className)}>
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
        <div className="flex flex-1 items-center justify-center py-10">
          <EmptyState icon={<Bell className="h-6 w-6" />} title={t.manage.noAlerts} />
        </div>
      ) : (
        <>
          <section className="rounded-2xl border border-border bg-card px-5 py-1">
            <ul className="divide-y divide-border/60">
              {visible.map((item) => (
                <AlertRow key={item.id} alert={item} now={now} onRead={markAlertRead} />
              ))}
            </ul>
          </section>
          {/* Spacer (not margin): keeps the rules card pinned when the list
              is short. The empty branch grows its own wrapper instead. */}
          <div aria-hidden className="flex-1" />
        </>
      )}

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t.manage.rulesTitle}</h2>
          <div className="flex shrink-0 items-center gap-3">
            {/* Desktop island overlay toggle: only meaningful inside Electron */}
            {window.desktopBridge && (
              <label className="flex items-center gap-2">
                <Tooltip text={t.island.desktopHint}>
                  <span className="text-[11px] text-muted-foreground">{t.island.desktopToggle}</span>
                </Tooltip>
                <Switch
                  checked={settings.desktopIsland}
                  ariaLabel={t.island.desktopToggle}
                  onCheckedChange={(on) => updateSettings({ ...settings, desktopIsland: on })}
                />
              </label>
            )}
          </div>
        </div>
        <div className="mt-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="text-xs text-muted-foreground">{t.manage.thresholdResetLabel}</span>
            <input
              type="number"
              value={thresholds.resetSoonMin}
              min={5}
              max={720}
              step={1}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setThresholds({ resetSoonMin: n })
              }}
              aria-label={t.manage.thresholdResetLabel}
              className="ml-auto w-20 rounded-lg border border-border bg-card px-2 py-1 text-right font-mono text-xs tabular-nums text-foreground outline-none focus:border-accent"
            />
            <span className="w-10 shrink-0 text-xs text-subtle">{t.manage.thresholdResetUnit}</span>
          </div>
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="text-xs text-muted-foreground">{t.manage.thresholdHighLabel}</span>
            <input
              type="number"
              value={thresholds.highUsagePct}
              min={50}
              max={100}
              step={1}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setThresholds({ highUsagePct: n })
              }}
              aria-label={t.manage.thresholdHighLabel}
              className="ml-auto w-20 rounded-lg border border-border bg-card px-2 py-1 text-right font-mono text-xs tabular-nums text-foreground outline-none focus:border-accent"
            />
            <span className="w-10 shrink-0 text-xs text-subtle">%</span>
          </div>
          <div className="flex items-start gap-2">
            <Bell className="mt-1.5 h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="mt-1.5 text-xs text-muted-foreground">{t.manage.thresholdLowLabel}</span>
            <div className="ml-auto grid shrink-0 grid-cols-2 gap-2">
              {LOW_BALANCE_CURRENCIES.map((code) => (
                <label key={code} className="flex items-center gap-1.5">
                  <span className="w-8 shrink-0 font-mono text-[11px] text-subtle">{code}</span>
                  <input
                    type="number"
                    value={thresholds.lowBalance[code] ?? 0}
                    min={0}
                    step="any"
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n >= 0) {
                        setThresholds({ lowBalance: { ...thresholds.lowBalance, [code]: n } })
                      }
                    }}
                    aria-label={`${t.manage.thresholdLowLabel} ${code}`}
                    className="w-20 rounded-lg border border-border bg-card px-2 py-1 text-right font-mono text-xs tabular-nums text-foreground outline-none focus:border-accent"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
