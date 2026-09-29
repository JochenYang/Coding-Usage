import { useEffect, useState } from 'react'
import { Trae } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import { summarizeTraeQuota, type TraeQuotaVM } from '@/lib/trae-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { cn } from '@/lib/cn'

/**
 * Trae CN credits usage card. The main process decrypts the IDE's local login
 * via the `trae:usage` IPC (the JWT never leaves the main process) and shows
 * the official credits consumption of the current period. Browser dev mode and
 * missing/expired logins degrade to an honest empty state.
 */
export function TraeQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<TraeQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Follows the shared refresh cycle like every other official-quota card.
  const { refreshTick } = useData()
  // Wrapper catches the brand mark's own <title> before it can pop a native
  // hover tooltip (see useStripSvgTitle)
  const brandRef = useStripSvgTitle<HTMLSpanElement>()

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setLoading(true)
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('timeout')), 12_000),
    )
    Promise.race([bridge.traeUsage(), timeout])
      .then((raw) => setVm(summarizeTraeQuota(raw)))
      .catch(() => setVm(summarizeTraeQuota({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
  }, [refreshTick])

  const now = useNowTick()
  const staleLogin =
    vm != null && ['http-401', 'http-403', 'token-expired', 'no-auth-token'].includes(vm.reason ?? '')

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center gap-2.5">
        <span ref={brandRef} className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          <Trae.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Trae CN</h2>
          <p className="truncate text-[11px] text-subtle">
            {vm?.plan ?? t.manage.traeCreditsPlan}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin ? t.manage.traeReauth : t.manage.traeNoAuth}
        </p>
      ) : (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t.manage.traeBilling}</span>
            <span
              className={cn(
                'tabular-nums',
                vm.percent >= 100 ? 'text-danger' : vm.percent >= 70 ? 'text-warning' : 'text-foreground',
              )}
            >
              {`${vm.consumed.toLocaleString()} / ${vm.total.toLocaleString()}`}
            </span>
          </div>
          <ProgressBar percent={vm.percent} size="sm" className="mt-1.5" />
          {vm.packs.length > 0 && (
            <p className="mt-1.5 truncate text-[11px] text-subtle">
              {vm.packs
                .map((p) => (p.credits != null ? `${p.name} ${p.credits.toLocaleString()}` : p.name))
                .join(' · ')}
            </p>
          )}
          {vm.resetsAt && (
            <p className="mt-1 text-[11px] text-subtle">{formatCountdown(vm.resetsAt, now, t)}</p>
          )}
        </div>
      )}
    </section>
  )
}
