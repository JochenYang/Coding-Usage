import { useEffect, useState } from 'react'
import { Devin } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'
import { formatAgo, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Devin subscription quota card. Reads the Devin CLI's own credentials.toml
 * through the `devin:quota` IPC — the windsurf_api_key stays in the main
 * process, only the daily/weekly window numbers cross IPC — and shows the
 * quota windows as consumed percentages of the plan. Browser dev mode and a
 * missing CLI login degrade to an honest empty state.
 */

/**
 * Window ids `electron/devin-quota.ts` emits (its DevinWindow union), plus
 * `other` for an id this build does not know yet: a drifted endpoint still
 * carries real usage, so an unknown pool renders under the generic label
 * instead of being silently dropped.
 */
type DevinWindowId = 'devinDaily' | 'devinWeekly' | 'other'

/** Known ids exactly; anything else parses as `other`. */
const KNOWN_WINDOW_IDS: readonly Exclude<DevinWindowId, 'other'>[] = ['devinDaily', 'devinWeekly']

/**
 * Window label resolved through an explicit id -> i18n accessor map, never by
 * string concatenation: a new window id then fails the build here instead of
 * silently rendering a raw key (same contract as KimiQuotaCard).
 */
const WINDOW_LABELS: Record<DevinWindowId, (t: Dict) => string> = {
  devinDaily: (t) => t.devinQuota.windowDaily,
  devinWeekly: (t) => t.devinQuota.windowWeekly,
  other: (t) => t.devinQuota.windowOther,
}

interface DevinWindowVM {
  id: DevinWindowId
  /** Consumed percentage 0-100 (the probe inverts the remaining share) */
  percent: number
  resetsAt: number | null
}

interface DevinQuotaVM {
  available: boolean
  /** Reason the probe failed (no login / rejected / http / parse) */
  reason: string | null
  /** Plan label from planStatus.planInfo; null when absent */
  plan: string | null
  windows: DevinWindowVM[]
  /** Epoch ms of this fetch */
  fetchedAt: number | null
}

/**
 * Decode the probe's normalized body, every field read by name. Ill-typed
 * members degrade individually; a body without a single usable window is not
 * a reading (a drifted payload never becomes a painted 0%).
 */
function parseDevinBody(body: string): { plan: string | null; windows: DevinWindowVM[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const windows: DevinWindowVM[] = []
  for (const raw of Array.isArray(record.windows) ? record.windows : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const w = raw as { id?: unknown; percent?: unknown; resetsAt?: unknown }
    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)) continue
    const known = KNOWN_WINDOW_IDS.find((id) => id === w.id)
    const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null
    windows.push({ id: known ?? 'other', percent: w.percent, resetsAt })
  }
  if (windows.length === 0) return null
  const plan = typeof record.plan === 'string' && record.plan !== '' ? record.plan : null
  return { plan, windows }
}

/** Never throws: a failure or malformed body yields an unavailable view. */
function summarizeDevinQuota(raw: { available: boolean; body?: string; reason?: string }): DevinQuotaVM {
  if (raw.available && raw.body) {
    const parsed = parseDevinBody(raw.body)
    if (parsed) return { available: true, reason: null, ...parsed, fetchedAt: Date.now() }
    return { available: false, reason: 'malformed-body', plan: null, windows: [], fetchedAt: null }
  }
  return { available: false, reason: raw.reason ?? null, plan: null, windows: [], fetchedAt: null }
}

/**
 * Race budget for the main-process probe. `electron/devin-quota.ts` bounds
 * its single Connect-RPC call at 10s (AbortSignal.timeout), so 15s covers a
 * full round-trip with IPC overhead. The effect cleanup clears the timer, so
 * a settled race leaves nothing behind.
 */
const PROBE_RACE_TIMEOUT_MS = 15_000

export function DevinQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<DevinQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Official quota hits the vendor's own endpoint, so it follows the refresh
  // cycle instead of fetching on mount only. The tick moves when a cycle
  // finishes, whatever the provider fetches did.
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
    // the `devin` key), then refresh without a visible loading state. Only a
    // card with nothing stored shows a spinner.
    void bridge
      .quotaSnapshot()
      .then((snapshot) => {
        // A snapshot that arrives after the probe must not rewind the card to
        // older numbers.
        if (cancelled || refreshed) return
        const stored = snapshot['devin']
        if (!stored?.result?.available) return
        const vm = summarizeDevinQuota(stored.result)
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
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), PROBE_RACE_TIMEOUT_MS)
    })
    Promise.race([bridge.devinQuota(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeDevinQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeDevinQuota({ available: false, reason: 'timeout' }))
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
  // 401/403 means a login exists but its key was rejected, which is a
  // different remedy from "no CLI login at all"
  const staleLogin = vm != null && ['reauth', 'http-401', 'http-403'].includes(vm.reason ?? '')

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<Devin />} />
      <div className="flex items-center gap-2.5">
        <span ref={brandRef} className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
          <Devin.Color />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-foreground">Devin</h2>
            {vm?.available && vm.plan && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-subtle">{vm.plan}</span>
            )}
          </div>
          <p className="text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {staleLogin
            ? t.devinQuota.staleLogin
            : vm?.reason === 'no-auth'
              ? t.devinQuota.noAuth
              : t.devinQuota.unavailable}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {vm.windows.map((win, i) => (
            <div key={`${win.id}-${i}`}>
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

          {/* The endpoint reports percentages only (see the probe's protobuf-JSON
              notes): say so, so a bar is never read as an absolute count. */}
          <p className="text-[11px] leading-relaxed text-subtle">{t.devinQuota.percentNote}</p>

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
