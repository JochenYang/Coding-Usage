import type { UsageMetric } from '../types'
import { formatAmount, formatDaysFromNow } from '../lib/format'
import { UNLIMITED_KEY } from '../lib/metric-helpers'
import { useT } from '../i18n/useT'
import { useLocale } from '../i18n/LocaleProvider'
import { ResetCountdown } from './ResetCountdown'

function percentColor(p: number): string {
  if (p >= 90) return 'bg-danger'
  if (p >= 70) return 'bg-warning'
  return 'bg-success'
}

function PercentMetric({ metric }: { metric: UsageMetric }) {
  const t = useT()
  // Detect the unlimited state by exact match against the shared sentinel
  // (minimax adapter stamps UNLIMITED_KEY into `unit` for total=0 windows).
  // Render label comes from the dict so locale switching reflects in the UI.
  const isUnlimited = metric.unit === UNLIMITED_KEY
  // When unlimited, render a full green progress bar without the percent label (avoid misleading the user)
  const p = isUnlimited ? 100 : Math.min(100, Math.max(0, Math.round(metric.percent ?? 0)))
  // For count-based windows, prefer the locale-aware template over the raw unit string.
  const remainingText =
    !isUnlimited && metric.used != null && metric.total != null
      ? t.metric.remaining(metric.used, metric.total)
      : null
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-foreground">{metric.label}</span>
        {isUnlimited ? (
          <span className="text-sm font-semibold tabular-nums text-emerald-600">{t.metric.unlimited}</span>
        ) : (
          <span className="text-sm font-semibold tabular-nums text-foreground">{p}%</span>
        )}
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all duration-500 ${isUnlimited ? 'bg-emerald-500' : percentColor(p)}`}
          style={{ width: `${p}%` }}
        />
      </div>
      {remainingText && (
        <div className="mt-1 text-xs text-muted-foreground tabular-nums">{remainingText}</div>
      )}
      <div className="mt-0.5">
        <ResetCountdown resetsAt={metric.resetsAt} />
      </div>
    </div>
  )
}

function BalanceMetric({ metric }: { metric: UsageMetric }) {
  const { locale } = useLocale()
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-foreground">{metric.label}</span>
        <span className="text-2xl font-bold tabular-nums text-foreground">
          {metric.remaining != null ? formatAmount(metric.remaining, locale) : '—'}
          {metric.unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{metric.unit}</span>}
        </span>
      </div>
      {metric.detail && metric.detail.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {metric.detail.map((d) => (
            <div key={d.label} className="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>{d.label}</span>
              <span>{formatAmount(d.value)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-0.5">
        <ResetCountdown resetsAt={metric.resetsAt} />
      </div>
    </div>
  )
}

function ExpiryMetric({ metric }: { metric: UsageMetric }) {
  const t = useT()
  const { locale } = useLocale()
  if (!metric.expiresAt) return null
  const fmt = formatDaysFromNow(metric.expiresAt, Date.now(), t)
  const toneClass =
    fmt.tone === 'danger' ? 'text-danger' : fmt.tone === 'warning' ? 'text-warning' : 'text-foreground'
  const dateStr = new Date(metric.expiresAt).toLocaleDateString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-sm text-foreground">{metric.label}</span>
      <div className="flex items-baseline gap-2 tabular-nums">
        <span className={`text-sm font-semibold ${toneClass}`}>{fmt.primary}</span>
        <span className="text-xs text-muted-foreground">{dateStr}</span>
      </div>
    </div>
  )
}

export function MetricList({ metrics }: { metrics: UsageMetric[] }) {
  return (
    <div className="space-y-4">
      {metrics.map((m) =>
        m.kind === 'percent' ? (
          <PercentMetric key={m.id} metric={m} />
        ) : m.kind === 'expiry' ? (
          <ExpiryMetric key={m.id} metric={m} />
        ) : (
          <BalanceMetric key={m.id} metric={m} />
        ),
      )}
    </div>
  )
}
