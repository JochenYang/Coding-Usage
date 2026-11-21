import { useEffect, useState } from 'react'
import { Amp } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'
import { formatAgo, formatAmount, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Amp balance card. Runs the official CLI's own `amp usage` reading through
 * the `amp:usage` IPC (the CLI resolves its own login; no credential crosses
 * IPC) and shows the pay-as-you-go credit balances plus the usage meters
 * (Amp Free daily allowance, subscription other/orb pools). Amp has no fixed
 * plan window, so unlike the window cards the USD balances lead and the
 * percentage meters sit in a compact secondary block. Browser dev mode and a
 * missing CLI degrade to an honest empty state.
 */

/**
 * Meter ids `electron/amp-quota.ts` emits (bodyFromAmpMeters), plus `other`
 * for an id this build does not know yet: a drifted CLI output still carries
 * real usage, so an unknown meter renders under the generic label instead of
 * being silently dropped.
 */
type AmpMeterId = 'ampFree' | 'ampSubscriptionOther' | 'ampSubscriptionOrb' | 'other'

/** Known ids exactly; anything else parses as `other`. */
const KNOWN_METER_IDS: readonly Exclude<AmpMeterId, 'other'>[] = [
  'ampFree',
  'ampSubscriptionOther',
  'ampSubscriptionOrb',
]

/**
 * Meter label resolved through an explicit id -> i18n accessor map, never by
 * string concatenation: a new meter id then fails the build here instead of
 * silently rendering a raw key (same contract as KimiQuotaCard).
 */
const METER_LABELS: Record<AmpMeterId, (t: Dict) => string> = {
  ampFree: (t) => t.ampQuota.meterFree,
  ampSubscriptionOther: (t) => t.ampQuota.meterSubscriptionOther,
  ampSubscriptionOrb: (t) => t.ampQuota.meterSubscriptionOrb,
  other: (t) => t.ampQuota.meterOther,
}

interface AmpMeterVM {
  id: AmpMeterId
  /** Consumed percentage 0-100 (the probe inverts the remaining share) */
  percent: number
  resetsAt: number | null
}

interface AmpQuotaVM {
  available: boolean
  /** Reason the probe failed (no CLI / timeout / unparsable sheet) */
  reason: string | null
  /** Subscription plan label from the CLI sheet; null when absent */
  plan: string | null
  meters: AmpMeterVM[]
  /** Individual credits balance in USD; null when the sheet carries none */
  individualCredits: number | null
  /** Workspace credits balance in USD; null when the sheet carries none */
  workspaceCredits: number | null
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/**
 * Decode the probe's normalized body, every field read by name. Ill-typed
 * members degrade individually; a sheet with neither a usable meter nor a
 * credit balance is not a reading (a drifted output never paints zeros).
 */
function parseAmpBody(
  body: string,
): {
  plan: string | null
  meters: AmpMeterVM[]
  individualCredits: number | null
  workspaceCredits: number | null
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const meters: AmpMeterVM[] = []
  for (const raw of Array.isArray(record.windows) ? record.windows : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const w = raw as { id?: unknown; percent?: unknown; resetsAt?: unknown }
    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue
    const known = KNOWN_METER_IDS.find((id) => id === w.id)
    const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null
    meters.push({ id: known ?? 'other', percent: w.percent, resetsAt })
  }
  // A money figure must be a non-negative USD amount; anything else stays absent.
  const usd = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const individualCredits = usd(record.topUpCredits)
  const workspaceCredits = usd(record.workspaceCredits)
  if (meters.length === 0 && individualCredits == null && workspaceCredits == null) return null
  const plan = typeof record.plan === 'string' && record.plan !== '' ? record.plan : null
  return { plan, meters, individualCredits, workspaceCredits }
}

/** Never throws: a failure or malformed body yields an unavailable view. */
function summarizeAmpQuota(raw: { available: boolean; body?: string; reason?: string }): AmpQuotaVM {
  if (raw.available && raw.body) {
    const parsed = parseAmpBody(raw.body)
    if (parsed) return { available: true, reason: null, ...parsed, fetchedAt: Date.now() }
    return {
      available: false,
      reason: 'malformed-body',
      plan: null,
      meters: [],
      individualCredits: null,
      workspaceCredits: null,
      fetchedAt: null,
    }
  }
  return {
    available: false,
    reason: raw.reason ?? null,
    plan: null,
    meters: [],
    individualCredits: null,
    workspaceCredits: null,
    fetchedAt: null,
  }
}

/**
 * Race budget for the main-process probe. `electron/amp-quota.ts` bounds the
 * `amp usage` child at 10s (CLI_TIMEOUT_MS), so 15s covers a full run with
 * IPC overhead. The effect cleanup clears the timer, so a settled race leaves
 * nothing behind.
 */
const PROBE_RACE_TIMEOUT_MS = 15_000

export function AmpQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<AmpQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // The balance hits the CLI's own reading, so it follows the refresh cycle
  // instead of fetching on mount only. The tick moves when a cycle finishes,
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
    // Paint the last good reading first (persisted in the main process under
    // the `amp` key), then refresh without a visible loading state. Only a
    // card with nothing stored shows a spinner.
    void bridge
      .quotaSnapshot()
      .then((snapshot) => {
        // A snapshot that arrives after the probe must not rewind the card to
        // older numbers.
        if (cancelled || refreshed) return
        const stored = snapshot['amp']
        if (!stored?.result?.available) return
        const vm = summarizeAmpQuota(stored.result)
        // A stored body this build can no longer decode is not a reading.
        if (!vm.available) return
        setVm({ ...vm, fetchedAt: stored.at })
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    // Race against a hard timeout: a hung IPC must not leave the card loading.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), PROBE_RACE_TIMEOUT_MS)
    })
    Promise.race([bridge.ampUsage(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeAmpQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeAmpQuota({ available: false, reason: 'timeout' }))
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
  // The balances are display garnish: hide the whole block when no amount
  // survived parsing instead of rendering an empty frame.
  const hasCredits = vm?.individualCredits != null || vm?.workspaceCredits != null

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<Amp />} />
      <div className="flex items-center gap-2.5">
        <span ref={brandRef} className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          <Amp.Color />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-foreground">Amp</h2>
            {vm?.available && vm.plan && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-subtle">{vm.plan}</span>
            )}
          </div>
          <p className="text-[11px] text-subtle">{t.ampQuota.subtitle}</p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {vm?.reason === 'no-auth' ? t.ampQuota.noAuth : t.ampQuota.unavailable}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {/* Balance first: Amp bills pay-as-you-go, so the USD balances are the
              figures a user acts on. Money, not plan allowance — same compact
              panel the Kimi card uses for its booster wallet. */}
          {hasCredits && (
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <div className="space-y-0.5 text-[11px]">
                {vm.individualCredits != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-subtle">{t.ampQuota.individualCredits}</span>
                    <span className="tabular-nums text-foreground">${formatAmount(vm.individualCredits)}</span>
                  </div>
                )}
                {vm.workspaceCredits != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-subtle">{t.ampQuota.workspaceCredits}</span>
                    <span className="tabular-nums text-foreground">${formatAmount(vm.workspaceCredits)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Usage meters sit compactly below the balances: Amp has no fixed
              plan window, so these rows read as meter readings, not the plan
              windows the other cards lead with. */}
          {vm.meters.length > 0 && (
            <div className="space-y-2.5">
              {vm.meters.map((meter, i) => (
                <div key={`${meter.id}-${i}`}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{METER_LABELS[meter.id](t)}</span>
                    <span
                      className={cn(
                        'tabular-nums',
                        meter.percent >= 100 ? 'text-danger' : meter.percent >= 70 ? 'text-warning' : 'text-foreground',
                      )}
                    >
                      {Math.round(meter.percent)}%
                    </span>
                  </div>
                  <ProgressBar percent={meter.percent} size="sm" className="mt-1.5" />
                  {meter.resetsAt && (
                    <p className="mt-1 text-[11px] text-subtle">{formatCountdown(meter.resetsAt, now, t)}</p>
                  )}
                </div>
              ))}
              <p className="text-[11px] leading-relaxed text-subtle">{t.ampQuota.note}</p>
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
