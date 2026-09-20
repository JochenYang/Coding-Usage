import { useEffect, useState } from 'react'
import { Kimi } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { useLocale } from '@/i18n/LocaleProvider'
import type { Dict } from '@/i18n/types'
import { currencySymbol, formatAmount, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { summarizeKimiQuota, type KimiQuotaVM, type KimiWindowId } from '@/lib/kimi-quota'
import { useTheme } from '@/components/ThemeProvider'
import { ProgressBar } from '@/components/common/ProgressBar'
import { cn } from '@/lib/cn'

/**
 * Window label resolved through an explicit id -> i18n accessor map, never by
 * string concatenation: a new KimiWindowId then fails the build here instead of
 * silently rendering a raw key. The ids are the display contract from
 * `summarizeKimiQuota` and stay stable across payloads.
 */
const WINDOW_LABELS: Record<KimiWindowId, (t: Dict) => string> = {
  fiveHour: (t) => t.kimiQuota.windowFiveHour,
  weekly: (t) => t.kimiQuota.windowWeekly,
  monthTotal: (t) => t.kimiQuota.windowMonthTotal,
  monthCode: (t) => t.kimiQuota.windowMonthCode,
  other: (t) => t.kimiQuota.windowOther,
}

/**
 * Wallet amount as money. A known currency code becomes its symbol (¥ / $),
 * an unknown one keeps its ISO code as a prefix; a null currency means the
 * payload carried no currency field at all, so the bare number is shown rather
 * than a guessed one.
 */
function formatMoney(
  amount: number,
  currency: string | null,
  locale: 'zh-CN' | 'en-US',
): string {
  const value = formatAmount(amount, locale)
  return currency ? `${currencySymbol(currency)}${value}` : value
}

/**
 * Kimi Code subscription quota card. Reads the local Kimi Code CLI login (or
 * loopback server) through the `kimi:usage` IPC — the bearer token never leaves
 * the main process — and shows the plan windows as PERCENTAGES of the plan
 * allowance, plus the pay-as-you-go booster wallet when the payload carries it.
 * Browser dev mode and missing logins degrade to an honest empty state.
 */
export function KimiQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const { locale } = useLocale()
  const [vm, setVm] = useState<KimiQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // lobehub's kimi-color.svg draws the "K" in white; on the light theme it would
  // vanish into the muted chip, so it gets the same invert-on-light treatment as
  // ProviderLogo does for this brand.
  const { resolved } = useTheme()
  // Wrapper catches the brand mark's own <title> before it can pop a native
  // hover tooltip (see useStripSvgTitle)
  const brandRef = useStripSvgTitle<HTMLSpanElement>()

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setLoading(true)
    // Race against a hard timeout: the main-process abort is best-effort, and a
    // hung IPC must not leave the card loading forever.
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('timeout')), 12_000),
    )
    // Called with no argument: the main process resolves the local login itself.
    Promise.race([bridge.kimiUsage(), timeout])
      .then((raw) => setVm(summarizeKimiQuota(raw)))
      .catch(() => setVm(summarizeKimiQuota({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
  }, [])

  // Minute-resolution clock so reset countdowns stay live on this card alone
  const now = useNowTick()
  // 401/403 means a login exists but its token was rejected, which is a
  // different remedy from "no local service at all"
  const staleLogin = vm != null && ['http-401', 'http-403'].includes(vm.reason ?? '')
  const wallet = vm?.wallet ?? null
  // The wallet is display garnish: hide the whole block when no amount survived
  // parsing instead of rendering an empty frame
  const walletHasAmount =
    wallet != null && (wallet.remaining != null || wallet.used != null || wallet.total != null)

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center gap-2.5">
        <span ref={brandRef} className={cn('flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5', resolved === 'light' && '[&>svg]:invert')} aria-hidden>
          <Kimi.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Kimi Code</h2>
          <p className="truncate text-[11px] text-subtle">{t.kimiQuota.title}</p>
        </div>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin
            ? t.kimiQuota.staleLogin
            : vm?.reason === 'no-auth-file'
              ? t.providerErrors.kimiQuotaNoServer
              : t.providerErrors.kimiQuotaUnavailable}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {vm.windows.map((win) => (
            <div key={win.id}>
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

          {/* Secondary, compact block: the booster wallet is money, not plan
              allowance, so it sits visually apart from the window rows above */}
          {walletHasAmount && wallet && (
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t.kimiQuota.walletTitle}</p>
              <div className="mt-1 space-y-0.5 text-[11px]">
                {wallet.remaining != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-subtle">{t.kimiQuota.walletRemaining}</span>
                    <span className="tabular-nums text-foreground">
                      {formatMoney(wallet.remaining, wallet.currency, locale)}
                    </span>
                  </div>
                )}
                {wallet.used != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-subtle">{t.kimiQuota.walletUsed}</span>
                    <span className="tabular-nums text-foreground">
                      {formatMoney(wallet.used, wallet.currency, locale)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-subtle">{t.kimiQuota.percentNote}</p>
        </div>
      )}
    </section>
  )
}
