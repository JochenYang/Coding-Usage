import { useEffect, useState } from 'react'
import { useT } from '@/i18n/useT'
import { formatAgo, formatAmount, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useData } from '@/lib/data-context'
import { FACTORY_WINDOW_LABELS, summarizeFactoryQuota, type FactoryQuotaVM } from '@/lib/factory-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Factory (Droid) subscription quota card. Reads the user's own Factory API
 * key (FACTORY_API_KEY / ~/.factory/.env) through the `factory:quota` IPC —
 * the key stays in the main process — and shows the official billing windows
 * plus the extra-usage balance. Browser dev mode and a missing key degrade to
 * an honest empty state.
 *
 * The lobehub icon set ships no Factory mark (verified in the installed
 * version), so the brand chip and watermark use the same letter fallback the
 * account drawer's ProviderLogo uses.
 */

// Body decoding and the window label map live in @/lib/factory-quota so the
// alert engine reads the same snapshot the card paints from. The local name
// keeps the JSX below unchanged.
const WINDOW_LABELS = FACTORY_WINDOW_LABELS

/**
 * Race budget for the main-process probe. `electron/factory-quota.ts` bounds
 * each request at 10s and may chain billing/limits -> legacy usage ->
 * auth/me, so a worst-case probe legitimately runs 30s; a shorter race would
 * declare `timeout` on a probe that was still working. On top of that the
 * probe queues behind the global concurrency-2 quota slot, so a cold start
 * where every card probes at once can push the total past this budget — the
 * race declares timeout once and the next refresh tick self-heals from the
 * persisted snapshot. The effect cleanup clears the timer, so a settled race
 * leaves nothing behind.
 */
const PROBE_RACE_TIMEOUT_MS = 35_000

export function FactoryQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<FactoryQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Official quota hits the vendor's own endpoint, so it follows the refresh
  // cycle instead of fetching on mount only. The tick moves when a cycle
  // finishes, whatever the provider fetches did.
  const { refreshTick } = useData()
  const { ref: sectionRef, inView } = useInView<HTMLElement>()

  useEffect(() => {
    if (!inView) return
    const bridge = window.desktopBridge
    if (!bridge) return
    let cancelled = false
    /** Set once the live probe has produced a verdict for this run. */
    let refreshed = false
    // Paint the last good reading first (persisted in the main process under
    // the `factory` key), then refresh without a visible loading state. Only a
    // card with nothing stored shows a spinner.
    void bridge
      .quotaSnapshot()
      .then((snapshot) => {
        // A snapshot that arrives after the probe must not rewind the card to
        // older numbers.
        if (cancelled || refreshed) return
        const stored = snapshot['factory']
        if (!stored?.result?.available) return
        const vm = summarizeFactoryQuota(stored.result)
        // A stored body this build can no longer decode is not a reading.
        if (!vm.available) return
        setVm({ ...vm, fetchedAt: stored.at })
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    // Race against a hard timeout: the main-process abort is best-effort on
    // Electron's net.fetch, and a hung IPC must not leave the card loading.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), PROBE_RACE_TIMEOUT_MS)
    })
    Promise.race([bridge.factoryQuota(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeFactoryQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeFactoryQuota({ available: false, reason: 'timeout' }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }
  }, [refreshTick, inView])

  // Minute-resolution clock so reset countdowns stay live on this card alone
  const now = useNowTick()
  // 401/403 means a key exists but was rejected, which is a different remedy
  // from "no key at all"
  const staleLogin = vm != null && ['reauth', 'http-401', 'http-403'].includes(vm.reason ?? '')

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<span className="text-[7rem] leading-none font-bold">F</span>} />
      <div className="flex items-center gap-2.5">
        {/* Letter chip: the icon set has no Factory mark; styling mirrors the
            ProviderLogo letter fallback so all brand chips read the same. */}
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground"
          aria-hidden
        >
          F
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-foreground">Factory Droid</h2>
            {vm?.available && vm.plan && (
              <span className="shrink-0 max-w-[10rem] truncate rounded-full bg-muted px-1.5 py-px text-[10px] text-subtle">{vm.plan}</span>
            )}
          </div>
          <p className="text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin
            ? t.factoryQuota.staleLogin
            : vm?.reason === 'no-auth'
              ? t.factoryQuota.noAuth
              : t.factoryQuota.unavailable}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {vm.windows.map((win, i) => (
            <div key={`${win.id}-${i}`}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{WINDOW_LABELS[win.id](t)}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    win.percent >= 100 ? 'text-danger' : win.percent >= 70 ? 'text-warning' : 'text-foreground',
                  )}
                >
                  {Math.round(win.percent)}%
                </span>
              </div>
              <ProgressBar percent={win.percent} size="sm" className="mt-1.5" />
              {win.resetsAt && (
                <p className="mt-1 text-[11px] text-subtle">{formatCountdown(win.resetsAt, now, t)}</p>
              )}
            </div>
          ))}

          {/* The extra-usage balance is money, not plan allowance: one compact
              row, USD exactly as the probe reports it (no conversion). */}
          {vm.topUpCredits != null && (
            <div className="border-t border-border/60 pt-2.5 text-[11px] text-subtle">
              <p>{t.factoryQuota.topUpCredits(`$${formatAmount(vm.topUpCredits)}`)}</p>
            </div>
          )}

          {/* How old the numbers are: a snapshot-painted reading shows the age
              of the stored entry until the fresh probe replaces it */}
          {vm.fetchedAt != null && (
            <p className="text-[11px] text-subtle">{formatAgo(vm.fetchedAt, now, t)}</p>
          )}
        </div>
      )}
    </section>
  )
}
