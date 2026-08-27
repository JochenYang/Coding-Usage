import { useEffect, useState } from 'react'
import { Gemini } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatCountdown } from '@/lib/format'
import { summarizeGeminiQuota, type GeminiQuotaVM } from '@/lib/gemini-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { cn } from '@/lib/cn'

/**
 * Gemini Code Assist subscription quota card. Reads the local Gemini CLI
 * OAuth login via the `gemini:usage` IPC (token refresh happens in the main
 * process) and shows per-model-class usage. Browser dev mode and missing
 * logins degrade to an honest empty state.
 */
export function GeminiQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<GeminiQuotaVM | null>(null)
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
    Promise.race([bridge.geminiUsage(), timeout])
      .then((raw) => setVm(summarizeGeminiQuota(raw)))
      .catch(() => setVm(summarizeGeminiQuota({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
  }, [])

  const now = Date.now()
  // 401/403 or a failed token refresh means the login exists but is stale
  const staleLogin = vm != null && ['http-401', 'http-403', 'refresh-failed'].includes(vm.reason ?? '')

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          <Gemini.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Gemini</h2>
          <p className="text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin ? t.manage.geminiReauth : t.manage.geminiNoAuth}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {vm.groups.map((group) => (
            <div key={group.id}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t.manage.geminiGroups[group.id]}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    group.percent >= 100 ? 'text-danger' : group.percent >= 70 ? 'text-warning' : 'text-foreground',
                  )}
                >
                  {Math.round(group.percent)}%
                </span>
              </div>
              <ProgressBar percent={group.percent} size="sm" className="mt-1.5" />
              {group.resetsAt && (
                <p className="mt-1 text-[11px] text-subtle">{formatCountdown(group.resetsAt, now, t)}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
