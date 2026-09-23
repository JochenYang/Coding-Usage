import { useEffect, useState } from 'react'
import { Antigravity } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'
import { formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import {
  summarizeAntigravityQuota,
  type AntigravityGroupId,
  type AntigravityQuotaVM,
  type AntigravityWindowId,
} from '@/lib/antigravity-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { cn } from '@/lib/cn'

/**
 * Label accessors keyed by the summarizer's stable ids, never by string
 * concatenation: a new id then fails the build here instead of rendering a raw
 * i18n key. Both maps are exhaustive over their union by type.
 */
const GROUP_LABELS: Record<AntigravityGroupId, (t: Dict) => string> = {
  gemini: (t) => t.antigravityQuota.groupGemini,
  thirdParty: (t) => t.antigravityQuota.groupThirdParty,
  other: (t) => t.antigravityQuota.groupOther,
}

const WINDOW_LABELS: Record<AntigravityWindowId, (t: Dict) => string> = {
  weekly: (t) => t.antigravityQuota.windowWeekly,
  fiveHour: (t) => t.antigravityQuota.windowFiveHour,
  other: (t) => t.antigravityQuota.windowOther,
}

/**
 * Race budget for the main-process probe: it walks the language server's ports
 * and tries two RPCs per port with an 8s timeout each, so a worst case
 * legitimately runs longer than a single request.
 */
const PROBE_RACE_TIMEOUT_MS = 40_000

/** Failure reason → the sentence the card shows */
function unavailableMessage(reason: string | null | undefined, t: Dict): string {
  if (reason === 'no-credentials') return t.antigravityQuota.needsIde
  if (reason === 'refresh-failed' || reason === 'http-401' || reason === 'http-403') {
    return t.antigravityQuota.staleHandshake
  }
  return t.antigravityQuota.unavailable
}

/**
 * Antigravity subscription quota card. Read through the official Cloud Code API
 * using the credentials Antigravity itself stores (see
 * electron/antigravity-quota.ts), with the IDE's local service as a fallback —
 * so unlike a purely local probe this keeps refreshing with the IDE closed.
 *
 * These are REMAINING percentages, matching Antigravity's own "…Limit Remaining"
 * panel, so the rows are labelled as remaining rather than reusing the
 * used-percentage wording of the neighbouring cards.
 */
export function AntigravityQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<AntigravityQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Follows the refresh cycle like the other subscription cards; the tick moves
  // when a cycle finishes, whatever the provider fetches did.
  const { refreshTick } = useData()
  // Wrapper catches the brand mark's own <title> before it can pop a native
  // hover tooltip (see useStripSvgTitle)
  const brandRef = useStripSvgTitle<HTMLSpanElement>()

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setLoading(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), PROBE_RACE_TIMEOUT_MS)
    })
    Promise.race([bridge.antigravityUsage(), timeout])
      .then((raw) => setVm(summarizeAntigravityQuota(raw)))
      .catch(() => setVm(summarizeAntigravityQuota({ available: false, reason: 'timeout' })))
      .finally(() => setLoading(false))
    return () => clearTimeout(timer)
  }, [refreshTick])

  // Minute-resolution clock so the reset countdowns stay live on this card alone
  const now = useNowTick()

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center gap-2.5">
        <span
          ref={brandRef}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5"
          aria-hidden
        >
          <Antigravity.Color />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Antigravity</h2>
          <p className="truncate text-[11px] text-subtle">{t.antigravityQuota.subtitle}</p>
        </div>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {unavailableMessage(vm?.reason, t)}
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {vm.groups.map((group) => (
            <div key={`${group.id}-${group.serverName}`}>
              <p className="text-[11px] font-medium text-muted-foreground">
                {GROUP_LABELS[group.id](t)}
              </p>
              <div className="mt-2 space-y-3">
                {group.buckets.map((bucket) => (
                  <div key={bucket.id}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{WINDOW_LABELS[bucket.window](t)}</span>
                      <span
                        className={cn(
                          'tabular-nums',
                          // Remaining: a low number is the alarming one
                          bucket.remainingPct <= 0
                            ? 'text-danger'
                            : bucket.remainingPct <= 30
                              ? 'text-warning'
                              : 'text-foreground',
                        )}
                      >
                        {`${Math.round(bucket.remainingPct)}%`}
                      </span>
                    </div>
                    <ProgressBar
                      percent={bucket.remainingPct}
                      size="sm"
                      metric="remaining"
                      className="mt-1.5"
                    />
                    {bucket.resetsAt != null && (
                      <p className="mt-1 text-[11px] text-subtle">
                        {formatCountdown(bucket.resetsAt, now, t)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[11px] leading-relaxed text-subtle">{t.antigravityQuota.remainingNote}</p>
        </div>
      )}
    </section>
  )
}
