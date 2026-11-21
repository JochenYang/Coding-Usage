import { useEffect, useState } from 'react'
import { Trae } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatAgo, formatAmount, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import { summarizeTraeQuota, type TraeQuotaVM } from '@/lib/trae-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Hard cap on the IPC round-trip. The probe is a local decrypt, but the IDE may
 * be mid-write, so the card gives up rather than spinning forever.
 */
const PROBE_RACE_TIMEOUT_MS = 12_000

/**
 * Trae international (SG/US deployment) entitlement card. The main process
 * decrypts the international IDE's local login via the `trae:intl-usage` IPC
 * (the token never leaves the main process) and shows the account's USD
 * entitlement consumption. Browser dev mode and missing/expired logins
 * degrade to an honest empty state.
 */
export function TraeIntlQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<TraeQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Follows the shared refresh cycle like every other official-quota card.
  const { refreshTick } = useData()
  const { ref: sectionRef, inView } = useInView<HTMLElement>()
  // Wrapper catches the brand mark's own <title> before it can pop a native
  // hover tooltip (see useStripSvgTitle)
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
        const stored = snapshot['trae-intl']
        if (!stored?.result?.available) return
        const vm = summarizeTraeQuota(stored.result)
        // A stored body this build can no longer decode is not a reading.
        if (!vm.available) return
        setVm({ ...vm, fetchedAt: stored.at })
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    // Race against a hard timeout: the main-process abort is best-effort, and a
    // hung IPC must not leave the card loading forever. The timer is cleared on
    // cleanup so each refresh cycle does not leave one pending behind.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), PROBE_RACE_TIMEOUT_MS)
    })
    Promise.race([bridge.traeIntlUsage(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeTraeQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeTraeQuota({ available: false, reason: 'timeout' }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }
  }, [refreshTick, inView])

  const now = useNowTick()
  const staleLogin =
    vm != null && ['http-401', 'http-403', 'token-expired', 'no-auth-token'].includes(vm.reason ?? '')

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<Trae />} />
      <div className="flex items-center gap-2.5">
        <span ref={brandRef} className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          <Trae.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Trae Intl</h2>
          <p className="truncate text-[11px] text-subtle">
            {vm?.plan ?? t.manage.traeIntlCreditsPlan}
          </p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin ? t.manage.traeIntlReauth : t.manage.traeIntlNoAuth}
        </p>
      ) : (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t.manage.traeIntlBilling}</span>
            <span
              className={cn(
                'tabular-nums',
                vm.percent >= 100 ? 'text-danger' : vm.percent >= 70 ? 'text-warning' : 'text-foreground',
              )}
            >
              {`$${formatAmount(vm.consumed)} / $${formatAmount(vm.total)}`}
            </span>
          </div>
          <ProgressBar percent={vm.percent} size="sm" className="mt-1.5" />
          {vm.packs.length > 0 && (
            <p className="mt-1.5 truncate text-[11px] text-subtle">
              {vm.packs
                .map((p) => (p.credits != null ? `${p.name} $${formatAmount(p.credits)}` : p.name))
                .join(' · ')}
            </p>
          )}
          {vm.resetsAt && (
            <p className="mt-1 text-[11px] text-subtle">{formatCountdown(vm.resetsAt, now, t)}</p>
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
