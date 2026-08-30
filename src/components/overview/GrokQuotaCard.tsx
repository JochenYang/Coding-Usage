import { useEffect, useState } from 'react'
import { Grok } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { summarizeGrokQuota, type GrokQuotaVM } from '@/lib/grok-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { cn } from '@/lib/cn'

/**
 * Grok (SuperGrok) subscription quota card. Reads the local `grok login`
 * state via the `grok:usage` IPC (token never leaves the machine) and shows
 * the official billing percentage. Browser dev mode and missing logins
 * degrade to an honest empty state.
 */
export function GrokQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<GrokQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setLoading(true)
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('timeout')), 12_000),
    )
    Promise.race([bridge.grokUsage(), timeout])
      .then((raw) => setVm(summarizeGrokQuota(raw)))
      .catch(() => setVm(summarizeGrokQuota({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
  }, [])

  const now = useNowTick()
  const staleLogin = vm != null && ['http-401', 'http-403'].includes(vm.reason ?? '')

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
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

      {loading ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin ? t.manage.grokReauth : t.manage.grokNoAuth}
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
        </div>
      )}
    </section>
  )
}
