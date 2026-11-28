import { useEffect, useRef, useState } from 'react'
import { Antigravity } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'
import { formatAgo, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import {
  ANTIGRAVITY_FLAVOURS,
  ANTIGRAVITY_GROUP_LABELS,
  ANTIGRAVITY_WINDOW_LABELS,
  summarizeAntigravityQuota,
  type AntigravityFlavour,
  type AntigravityQuotaVM,
} from '@/lib/antigravity-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { Badge } from '@/components/common/Badge'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

// The label maps live in @/lib/antigravity-quota so the alert engine names a
// group and a window exactly as the card does. The local names keep the JSX
// unchanged.
const GROUP_LABELS = ANTIGRAVITY_GROUP_LABELS
const WINDOW_LABELS = ANTIGRAVITY_WINDOW_LABELS

/**
 * Race budget for the main-process probe: it may read the updater manifest,
 * spawn a helper for the keyring or the uninstall registry, try two service
 * hosts for the project lookup, the quota summary and the per-model fallback,
 * each with a 6s timeout, so a worst case legitimately runs longer than a
 * single request.
 */
const PROBE_RACE_TIMEOUT_MS = 60_000

/**
 * Failure reason → the sentence the card shows.
 *
 * "Could not read the login" comes in three shapes that all mean the same to
 * the user — no OAuth client found for the refresh, the system keyring itself
 * unreadable, or a keyring value this build cannot parse — so they share the
 * "the sign-in may still be valid" advice rather than telling a signed-in user
 * to sign in again.
 */
function unavailableMessage(reason: string | null | undefined, client: string, t: Dict): string {
  if (reason === 'no-credentials') return t.antigravityQuota.needsLogin(client)
  if (
    reason === 'refresh-unavailable' ||
    reason === 'keyring-unavailable' ||
    reason === 'unreadable-credentials'
  ) {
    return t.antigravityQuota.refreshUnavailable
  }
  if (reason === 'refresh-failed' || reason === 'http-401' || reason === 'http-403') {
    return t.antigravityQuota.staleHandshake
  }
  return t.antigravityQuota.unavailable
}

/**
 * Antigravity subscription quota card, one instance per client. Read through
 * the official Cloud Code API with the login that client keeps (see
 * electron/antigravity-quota.ts) — the IDE's own store, or the system keyring
 * entry the app and the CLI share — with the IDE's local service as a fallback.
 * No client has to be running for the card to keep refreshing.
 *
 * The three cards show one allowance: an account's quota is not split by
 * client, so a machine signed into one account reads the same on all of them.
 *
 * These are REMAINING percentages, matching Antigravity's own "…Limit
 * Remaining" panel, so the rows are labelled as remaining rather than reusing
 * the used-percentage wording of the neighbouring cards.
 *
 * `onWideChange` reports whether the card wants two grid tracks: it asks only
 * when there really are two model groups to lay out side by side. Whether it
 * gets them is the page's decision, passed back as `expanded` — with sibling
 * Antigravity cards on the page the groups stack in a single track instead.
 */
export function AntigravityQuotaCard({
  flavour,
  expanded,
  className,
  onWideChange,
}: {
  /** Which client's login this card reads; also its title and snapshot slot */
  flavour: AntigravityFlavour
  /**
   * Whether the grid gives this card two tracks. Stacking the two model groups
   * in one cell makes the card about twice as tall as a neighbour, which is why
   * it asks for the room — but a two-track card that does not fit the rest of
   * its row drops to a row of its own and leaves a column empty.
   */
  expanded: boolean
  className?: string
  onWideChange?: (wide: boolean) => void
}) {
  const client = ANTIGRAVITY_FLAVOURS[flavour]
  const t = useT()
  const [vm, setVm] = useState<AntigravityQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Follows the refresh cycle like the other subscription cards; the tick moves
  // when a cycle finishes, whatever the provider fetches did.
  const { refreshTick } = useData()
  const { ref: sectionRef, inView } = useInView<HTMLElement>()
  // Wrapper catches the brand mark's own <title> before it can pop a native
  // hover tooltip (see useStripSvgTitle)
  const brandRef = useStripSvgTitle<HTMLSpanElement>()
  // The page passes a fresh closure for every card on each render; through a
  // ref only a real change in `wide` re-reports, not a parent re-render.
  const onWideChangeRef = useRef(onWideChange)
  useEffect(() => {
    onWideChangeRef.current = onWideChange
  })

  useEffect(() => {
    if (!inView) return
    const bridge = window.desktopBridge
    if (!bridge) return
    let cancelled = false
    /** Set once the live probe has produced a verdict for this run. */
    let refreshed = false
    // Paint the last good reading first (persisted in the main process), then
    // refresh without a visible loading state. Only a card with nothing stored
    // shows a spinner.
    void bridge
      .quotaSnapshot()
      .then((snapshot) => {
        // A snapshot that arrives after the probe must not rewind the card to
        // older numbers.
        if (cancelled || refreshed) return
        const stored = snapshot[client.key]
        if (!stored?.result?.available) return
        const vm = summarizeAntigravityQuota(stored.result)
        // A stored body this build can no longer decode is not a reading.
        if (!vm.available) return
        setVm({ ...vm, fetchedAt: stored.at })
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), PROBE_RACE_TIMEOUT_MS)
    })
    Promise.race([bridge.antigravityUsage(flavour), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeAntigravityQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeAntigravityQuota({ available: false, reason: 'timeout' }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }
  }, [refreshTick, inView, flavour, client.key])

  // Minute-resolution clock so the reset countdowns stay live on this card alone
  const now = useNowTick()

  // Two model groups are two blocks of rows. With the room the page grants
  // they go side by side; stacked in one cell they make the card twice as tall
  // as its neighbours. Only the grid item — not the card — can claim a second
  // column, so the wish is reported upward and `expanded` is the answer.
  const twoGroups = vm?.available === true && vm.groups.length >= 2
  useEffect(() => {
    onWideChangeRef.current?.(twoGroups)
  }, [twoGroups])
  const wide = expanded && twoGroups

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<Antigravity />} />
      <div className="flex items-center gap-2.5">
        <span
          ref={brandRef}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5"
          aria-hidden
        >
          <Antigravity.Color />
        </span>
        <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{client.name}</h2>
            <p className="truncate text-[11px] text-subtle">{t.antigravityQuota.subtitle}</p>
          </div>
          {/* Said only when the main process established it: the figures are
              then read from the login the uninstall left behind, and the badge
              is what keeps that from looking like a live client. Transparent
              with an outline rather than the badge's own tinted background:
              `warning-text` clears 4.5:1 on the card itself, but not on top of
              the 10% warning wash (4.0:1 in the light theme). */}
          {vm?.installed === false && (
            <Badge
              tone="warning"
              className="shrink-0 bg-transparent text-warning-text ring-1 ring-inset ring-warning-text/40"
            >
              {t.antigravityQuota.notInstalled}
            </Badge>
          )}
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {unavailableMessage(vm?.reason, client.name, t)}
        </p>
      ) : (
        <div className={wide ? 'mt-3 md:grid md:grid-cols-2 md:items-start md:gap-x-6 md:gap-y-4' : 'mt-3 space-y-4'}>
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
          <p className={cn('text-[11px] leading-relaxed text-subtle', wide && 'md:col-span-2')}>
            {t.antigravityQuota.remainingNote}
          </p>
          {/* How old the numbers are: a snapshot-painted reading shows the age
              of the stored entry until the fresh probe replaces it */}
          <p className={cn('text-[11px] text-subtle', wide && 'md:col-span-2')}>
            {formatAgo(vm.fetchedAt, now, t)}
          </p>
        </div>
      )}
    </section>
  )
}
