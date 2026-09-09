import { useEffect, useRef, useState } from 'react'
import { BellOff, CircleAlert, Info, Lock, X } from 'lucide-react'
import type { AlertItem, AlertKind } from '@/lib/alerts'
import { alertDetail, alertTitle } from '@/lib/alert-text'
import { useData } from '@/lib/data-context'
import { useT } from '@/i18n/useT'
import { useView } from '@/lib/router'
import { cn } from '@/lib/cn'
import { DynamicIsland, DynamicIslandView } from '@/components/beui/dynamic-island'

/**
 * Dynamic-island alert surface: when genuinely NEW alerts appear (unknown id,
 * or a resolved-history row flipping back to live on re-fire), the island
 * blooms at the top of the window with the latest alert and a "+N" count. It
 * auto-dismisses after a few seconds; clicking the body jumps to the alerts
 * page, the X just dismisses. Purely in-app: unlike the webhook channels it
 * has no cooldown — every new alert deserves one popup while the user is at
 * the desk.
 */

const AUTO_DISMISS_MS = 8_000

const KIND_ICON: Record<AlertKind, typeof Info> = {
  'window-reset': CircleAlert,
  'high-usage': Lock,
  'low-balance': Info,
}

const LEVEL_DOT: Record<AlertItem['level'], string> = {
  danger: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-accent',
}

/** Expanded island body shared by the in-app island and the desktop overlay */
export function AlertIslandBody({
  latest,
  rest,
  onOpen,
  onDismiss,
  dismissLabel,
  openLabel,
}: {
  latest: AlertItem
  rest: number
  onOpen: () => void
  onDismiss: () => void
  dismissLabel: string
  openLabel: string
}) {
  const t = useT()
  const Icon = KIND_ICON[latest.kind]
  return (
    <div className="flex w-full items-center gap-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left"
        aria-label={openLabel}
      >
        <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-background/10" aria-hidden>
          <Icon className="h-3 w-3" />
          <span className={cn('absolute right-0 top-0 h-1.5 w-1.5 rounded-full ring-2 ring-foreground', LEVEL_DOT[latest.level])} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-xs font-medium">{alertTitle(latest, t)}</span>
            {rest > 0 && (
              <span className="shrink-0 rounded-full bg-background/10 px-1.5 py-px text-[10px] tabular-nums">
                {t.island.more(rest)}
              </span>
            )}
          </span>
          {alertDetail(latest, t) && (
            <span className="mt-0.5 block truncate text-[11px] text-background/60">{alertDetail(latest, t)}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className="shrink-0 rounded-md p-1 text-background/60 transition-colors hover:bg-background/10 hover:text-background"
      >
        {rest > 0 ? <BellOff className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

export function AlertIsland() {
  const t = useT()
  const { alerts, settings } = useData()
  const [, navigate] = useView()
  const [batch, setBatch] = useState<AlertItem[]>([])
  // Desktop overlay mode: popups leave the window entirely (the in-app island
  // stays as the browser/fallback surface). Preview is also overlay-driven.
  const overlayOn = settings.desktopIsland && !!window.desktopBridge
  // Diff baseline: the alerts set from the previous render (id → resolved).
  // A re-firing condition pops again: its id is known, but it flipped from
  // resolved history back to live — that transition is a new event.
  const prevRef = useRef<Map<string, boolean>>(new Map(alerts.map((a) => [a.id, a.resolved === true])))

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = new Map(alerts.map((a) => [a.id, a.resolved === true]))
    const fresh = alerts.filter((a) => {
      const was = prev.get(a.id)
      if (was === undefined) return true
      return was === true && a.resolved !== true
    })
    if (fresh.length === 0) return
    if (overlayOn) {
      void window.desktopBridge?.islandShow(fresh)
      return
    }
    // Append (dedup by id) so an island that is already up absorbs new
    // arrivals instead of restarting
    setBatch((current) => {
      const seen = new Set(current.map((a) => a.id))
      return [...current, ...fresh.filter((a) => !seen.has(a.id))]
    })
  }, [alerts, overlayOn])

  // Auto-dismiss; the timer restarts whenever the batch changes
  useEffect(() => {
    if (batch.length === 0) return
    const timer = setTimeout(() => setBatch([]), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [batch])

  // Two-phase bloom: hold the bare pill for one frame, then expand — the
  // shell springs out from the pill like the iOS island instead of popping
  // at full size.
  const [bloom, setBloom] = useState(false)
  useEffect(() => {
    if (batch.length === 0) {
      setBloom(false)
      return
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setBloom(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [batch])

  if (batch.length === 0) return null

  const latest = batch[batch.length - 1]

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center">
      <div className="pointer-events-auto">
        <DynamicIsland view={bloom ? 'alert' : null} compact={<span className="h-2 w-2 rounded-full bg-background/25" aria-hidden />}>
          <DynamicIslandView id="alert" className="min-w-[320px] max-w-[460px] py-2.5">
            <AlertIslandBody
              latest={latest}
              rest={batch.length - 1}
              onOpen={() => {
                setBatch([])
                navigate('alerts')
              }}
              onDismiss={() => setBatch([])}
              dismissLabel={t.island.dismiss}
              openLabel={t.nav.alerts}
            />
          </DynamicIslandView>
        </DynamicIsland>
      </div>
    </div>
  )
}
