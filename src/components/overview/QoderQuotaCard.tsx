import { useEffect, useState } from 'react'
import { Qoder } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatAmount } from '@/lib/format'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
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
export function QoderQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<QoderQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Official quota hits the vendor's own endpoint, so it follows the refresh
  // cycle instead of fetching on mount only.
  const { refreshTick } = useData()
  const brandRef = useStripSvgTitle<HTMLSpanElement>()

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setLoading(true)
    // The main-process fetch is best-effort on its own; a hung IPC must not
    // leave the card spinning forever.
    const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 15_000))
    Promise.race([bridge.qoderQuota(), timeout])
      .then((raw) => setVm(summarizeQoderQuota(raw)))
      .catch(() => setVm(summarizeQoderQuota({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
  }, [refreshTick])

  const staleLogin = vm != null && ['http-401', 'http-403'].includes(vm.reason ?? '')

  return (
    <section className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}>
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

      {loading ? (
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
        </div>
      )}
    </section>
  )
}
