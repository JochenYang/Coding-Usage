import { useEffect, useState } from 'react'
import { Codex } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatCountdown } from '@/lib/format'
import { summarizeCodexQuota, type CodexQuotaVM } from '@/lib/codex-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { cn } from '@/lib/cn'

/**
 * Codex subscription quota card. Reads the local ChatGPT login via the
 * `codex:quota` IPC (credential never leaves the machine) and shows the
 * official usage windows. Browser dev mode and missing logins degrade to an
 * honest empty state.
 */
export function CodexQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<CodexQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setLoading(true)
    // Race against a hard timeout: the main-process abort is best-effort on
    // Electron's net.fetch, and a hung IPC must not leave the card loading.
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('timeout')), 12_000),
    )
    Promise.race([bridge.codexQuota(), timeout])
      .then((raw) => setVm(summarizeCodexQuota(raw)))
      .catch(() => setVm(summarizeCodexQuota({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
  }, [])

  const now = Date.now()

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          <Codex.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Codex</h2>
          <p className="text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">{t.manage.codexNoAuth}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {[vm.primary, vm.secondary].map(
            (win, i) =>
              win && (
                <div key={`${win.label}-${i}`}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{win.label}</span>
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
                    <p className="mt-1 text-[11px] text-subtle">
                      {formatCountdown(win.resetsAt, now, t)}
                    </p>
                  )}
                </div>
              ),
          )}
        </div>
      )}
    </section>
  )
}
