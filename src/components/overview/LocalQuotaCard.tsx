import { useEffect, useState } from 'react'
import { Cursor, GithubCopilot } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import {
  summarizeCopilotQuota,
  summarizeCursorQuota,
  type LocalPlanQuotaVM,
  type LocalPlanRaw,
} from '@/lib/local-plan-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Plan-quota card for a client whose allowance is read from its own local
 * login (Cursor, GitHub Copilot). Same contract as the Codex/Claude cards: the
 * credential stays in the main process, only usage numbers arrive here.
 *
 * The source is chosen by `kind` rather than by props so the fetch function
 * identity is stable across renders — an inline callback would restart the
 * request on every render.
 */

export type LocalQuotaKind = 'cursor' | 'copilot'

const SOURCES = {
  cursor: {
    name: 'Cursor',
    logo: <Cursor.Avatar size={16} />,
    // Monochrome glyph for the decorative watermark (see CardWatermark)
    watermark: <Cursor />,
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.cursorUsage(),
    summarize: summarizeCursorQuota,
  },
  copilot: {
    name: 'GitHub Copilot',
    logo: <GithubCopilot.Avatar size={16} />,
    watermark: <GithubCopilot />,
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.copilotUsage(),
    summarize: summarizeCopilotQuota,
  },
} as const

export function LocalQuotaCard({ kind, className }: { kind: LocalQuotaKind; className?: string }) {
  const t = useT()
  const source = SOURCES[kind]
  const [vm, setVm] = useState<LocalPlanQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Follows the shared refresh cycle like every other subscription card
  const { refreshTick } = useData()
  const brandRef = useStripSvgTitle<HTMLSpanElement>()

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setLoading(true)
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('timeout')), 12_000),
    )
    Promise.race([source.load(), timeout])
      .then((raw) => setVm(source.summarize(raw)))
      .catch(() => setVm(source.summarize({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
  }, [refreshTick, source])

  const now = useNowTick()
  const emptyText =
    kind === 'cursor' ? t.manage.cursorNoAuth : t.manage.copilotNoAuth
  // A sealed Cursor token cannot be read by this app at all: point at the
  // manual path instead of telling the user to log in again (which would not help).
  const sealed = vm?.reason === 'sealed-token' && kind === 'cursor'

  return (
    <section className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}>
      {/* Monogram-free: the mono glyph needs no sizing or tint override */}
      <CardWatermark icon={source.watermark} />
      <div className="flex items-center gap-2.5">
        <span
          ref={brandRef}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5"
          aria-hidden
        >
          {source.logo}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-foreground">{source.name}</h2>
            {vm?.available && vm.plan && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-subtle">
                {vm.plan}
              </span>
            )}
          </div>
          <p className="text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {sealed ? t.manage.cursorSealed : emptyText}
          {vm?.reason && /^http-|probe-failed|timeout/.test(vm.reason) ? ` (${vm.reason})` : null}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {vm.windows.map((win) => (
            <div key={win.id}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t.windows[win.id]}</span>
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
              {win.resetsAt != null && (
                <p className="mt-1 text-[11px] text-subtle">{formatCountdown(win.resetsAt, now, t)}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
