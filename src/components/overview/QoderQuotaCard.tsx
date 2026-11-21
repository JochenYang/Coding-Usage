import { useEffect, useState } from 'react'
import { Qoder } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatAgo, formatAmount } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useInView } from '@/lib/hooks/use-in-view'
import { useData } from '@/lib/data-context'
import { summarizeQoderQuota, type QoderQuotaVM } from '@/lib/qoder-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Qoder (global build) account quota card.
 *
 * Reads the credits pool the IDE itself displays, through the `qoder:quota`
 * IPC: the main process decrypts the IDE's local login, asks the vendor's usage
 * endpoint and returns numbers only — the token never leaves the machine and
 * never crosses IPC. Browser dev mode, a missing IDE and an unsupported
 * platform all degrade to an honest empty state.
 *
 * The unit is credits, not tokens: Qoder's global build bills in credits and
 * reports no token counters at all, so the card never renders a token figure or
 * a converted price.
 */

/**
 * Decode one stored `qoder` snapshot entry into a paintable view-model.
 *
 * The main process persists the probe's numeric outcome through quota-store,
 * whose entries carry the payload as a JSON `body` string; that write lands in
 * a separate main-process change, so the entry may simply be absent. Every
 * field is narrowed here and re-validated by summarizeQoderQuota (values cross
 * IPC). Anything that is not a plain object carrying at least one usable
 * number — a missing entry, unparsable JSON, a body without figures — returns
 * null: the card keeps waiting for the live probe instead of painting a wrong
 * 0%.
 */
function storedQoderOutcome(body: unknown, at: number): QoderQuotaVM | null {
  if (typeof body !== 'string' || body === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const hasNumber = ['percent', 'used', 'total', 'remaining'].some(
    (key) => num(record[key]) != null,
  )
  if (!hasNumber) return null
  // The store persists the numeric part only: availability comes from the
  // entry itself and the paint time from its `at` stamp.
  return summarizeQoderQuota({
    available: true,
    used: num(record.used),
    total: num(record.total),
    remaining: num(record.remaining),
    percent: num(record.percent),
    isQuotaExceeded: record.isQuotaExceeded === true,
    userType: typeof record.userType === 'string' && record.userType !== '' ? record.userType : undefined,
    unit: typeof record.unit === 'string' && record.unit !== '' ? record.unit : undefined,
    fetchedAt: at,
  })
}
export function QoderQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<QoderQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Official quota hits the vendor's own endpoint, so it follows the refresh
  // cycle instead of fetching on mount only.
  const { refreshTick } = useData()
  const { ref: sectionRef, inView } = useInView<HTMLElement>()
  const brandRef = useStripSvgTitle<HTMLSpanElement>()

  useEffect(() => {
    if (!inView) return
    const bridge = window.desktopBridge
    if (!bridge) return
    let cancelled = false
    /** Set once the live probe has produced a verdict for this run. */
    let refreshed = false
    // Paint the last good reading first (persisted in the main process), then
    // refresh without a visible loading state. Only a card with nothing stored
    // shows a spinner.
    void bridge
      .quotaSnapshot()
      .then((snapshot) => {
        // A snapshot that arrives after the probe must not rewind the card to
        // older numbers.
        if (cancelled || refreshed) return
        const stored = snapshot['qoder']
        if (!stored) return
        const vm = storedQoderOutcome(stored.result?.body, stored.at)
        if (vm) setVm(vm)
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    // The main-process fetch is best-effort on its own; a hung IPC must not
    // leave the card spinning forever.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), 15_000)
    })
    Promise.race([bridge.qoderQuota(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeQoderQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeQoderQuota({ available: false, reason: 'timeout' }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }
  }, [refreshTick, inView])

  // Minute-resolution clock so the painted reading's age stays live
  const now = useNowTick()
  const staleLogin = vm != null && ['http-401', 'http-403'].includes(vm.reason ?? '')

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<Qoder />} />
      <div className="flex items-center gap-2.5">
        <span
          ref={brandRef}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5"
          aria-hidden
        >
          <Qoder.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Qoder</h2>
          <p className="truncate text-[11px] text-subtle">{vm?.userType ?? t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {/* Three honest states: the login expired, there is no login, or the
              login cannot be read here (other OS, blocked PowerShell, network). */}
          {staleLogin
            ? t.manage.qoderReauth
            : vm?.reason === 'no-login'
              ? t.manage.qoderNoAuth
              : t.manage.qoderUnavailable}
        </p>
      ) : (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t.manage.qoderCredits}</span>
            <span
              className={cn(
                'tabular-nums',
                vm.exhausted || vm.percent >= 100
                  ? 'text-danger'
                  : vm.percent >= 70
                    ? 'text-warning'
                    : 'text-foreground',
              )}
            >
              {Math.round(vm.percent)}%
            </span>
          </div>
          <ProgressBar percent={vm.percent} size="sm" className="mt-1.5" />
          {/* The absolute figures are what a user acts on: percent alone cannot
              tell "100 of 200" from "2 of 4". */}
          {vm.used != null && vm.total != null && (
            <p className="mt-1.5 text-[11px] tabular-nums text-subtle">
              {`${formatAmount(vm.used)} / ${formatAmount(vm.total)} ${vm.unit}`}
              {vm.remaining != null && ` · ${t.manage.qoderRemaining(formatAmount(vm.remaining))}`}
            </p>
          )}
          {/* How old the numbers are: a snapshot-painted reading shows the age
              of the stored entry until the fresh probe replaces it */}
          {vm.fetchedAt != null && (
            <p className="mt-1 text-[11px] text-subtle">{formatAgo(vm.fetchedAt, now, t)}</p>
          )}
        </div>
      )}
    </section>
  )
}
