import { useEffect, useState } from 'react'
import { Grok } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { useLocale } from '@/i18n/LocaleProvider'
import { formatAgo, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import { summarizeGrokQuota, type GrokQuotaVM } from '@/lib/grok-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Grok (SuperGrok) subscription quota card. Reads the local `grok login`
 * state via the `grok:usage` IPC (token never leaves the machine) and shows
 * the official billing percentage. Browser dev mode and missing logins
 * degrade to an honest empty state.
 */
export function GrokQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const { locale } = useLocale()
  const [vm, setVm] = useState<GrokQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Official quota hits the vendor's own usage endpoint, so it follows the
  // refresh cycle instead of fetching on mount only (which froze the progress
  // bars until the page was remounted). The tick moves when a cycle finishes,
  // whatever the provider fetches did.
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
        const stored = snapshot['grok']
        if (!stored?.result?.available) return
        const vm = summarizeGrokQuota(stored.result)
        // A stored body this build can no longer decode is not a reading.
        if (!vm.available) return
        setVm({ ...vm, fetchedAt: stored.at })
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    // Race against a hard timeout: a hung IPC must not leave the card loading.
    // The probe also queues behind the global concurrency-2 quota slot, so a
    // cold start where heavier probes run first can exceed this budget — the
    // timeout keeps whatever snapshot was painted instead of wiping it, and
    // the next refresh tick self-heals.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), 12_000)
    })
    Promise.race([bridge.grokUsage(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeGrokQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        // A watchdog timeout must not wipe the snapshot painted above: keep
        // the last reading on screen instead of flashing an unavailable state.
        setVm((prev) => prev ?? summarizeGrokQuota({ available: false, reason: 'timeout' }))
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
  const staleLogin = vm != null && ['http-401', 'http-403'].includes(vm.reason ?? '')

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<Grok />} />
      <div className="flex items-center gap-2.5">
        <span ref={brandRef} className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          {/* Grok ships no .Color variant; .Avatar is its colored brand tile */}
          <Grok.Avatar size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Grok</h2>
          <p className="truncate text-[11px] text-subtle">
            {vm?.plan ?? t.manage.subscriptionTitle}
          </p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin
            ? t.manage.grokReauth
            : vm?.reason === 'no-auth-file'
              ? t.manage.grokNoAuth
              : // network / timeout / server errors: pointing at the login
                // file would send the user hunting in the wrong place
                t.manage.grokUnavailable}
        </p>
      ) : (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t.manage.grokBilling}</span>
            <span
              className={cn(
                'tabular-nums',
                vm.percent >= 100 ? 'text-danger' : vm.percent >= 70 ? 'text-warning' : 'text-foreground',
              )}
            >
              {Math.round(vm.percent)}%
            </span>
          </div>
          <ProgressBar percent={vm.percent} size="sm" className="mt-1.5" />
          {vm.resetsAt && (
            <p className="mt-1 text-[11px] text-subtle">{formatCountdown(vm.resetsAt, now, t)}</p>
          )}
          {/* Banked reset tokens (the gRPC-Web enhancement): a failed read
              costs this line and nothing else — the billing numbers stand alone. */}
          {vm.remainingResets != null && (
            <p className="mt-1 text-[11px] text-subtle">
              {t.manage.grokResetsLeft(vm.remainingResets)}
              {vm.resetsExpireAt != null &&
                ` · ${t.manage.grokResetsExpire(new Date(vm.resetsExpireAt).toLocaleDateString(locale))}`}
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
