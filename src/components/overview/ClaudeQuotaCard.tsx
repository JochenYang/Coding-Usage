import { useEffect, useState } from 'react'
import { Claude } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatAgo, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import { summarizeClaudeQuota, type ClaudeQuotaVM } from '@/lib/claude-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Claude subscription quota card. Reads the local Claude Code OAuth login via
 * the `claude:usage` IPC (credential never leaves the machine) and shows the
 * official usage windows. Browser dev mode and missing logins degrade to an
 * honest empty state.
 */
export function ClaudeQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<ClaudeQuotaVM | null>(null)
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
        const stored = snapshot['claude']
        if (!stored?.result?.available) return
        const vm = summarizeClaudeQuota(stored.result)
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
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), 12_000)
    })
    Promise.race([bridge.claudeUsage(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeClaudeQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeClaudeQuota({ available: false, reason: 'timeout' }))
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
  // 401/403 or a failed token refresh means the login exists but is stale
  const staleLogin = vm != null && ['http-401', 'http-403', 'refresh-failed'].includes(vm.reason ?? '')

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<Claude />} />
      <div className="flex items-center gap-2.5">
        <span ref={brandRef} className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          <Claude.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Claude</h2>
          <p className="text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin ? t.manage.claudeReauth : t.manage.claudeNoAuth}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {vm.windows.map((win) => (
            <div key={win.id}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t.manage.claudeWindows[win.id]}</span>
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

          {/* Model-scoped allowances from `limits[]`: a per-model weekly cap can
              be exhausted while every global window above still reads healthy. */}
          {vm.scoped.map((win) => (
            <div key={`scoped-${win.label}`}>
              <div className="flex items-center justify-between text-xs">
                <span className="truncate text-muted-foreground">{win.label}</span>
                <span
                  className={cn(
                    'shrink-0 tabular-nums',
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
