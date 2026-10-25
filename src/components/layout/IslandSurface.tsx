import { useCallback, useEffect, useState } from 'react'
import type { AlertItem } from '@/lib/alerts'
import { DynamicIsland, DynamicIslandView, ISLAND_COLLAPSE_MS } from '@/components/beui/dynamic-island'
import { AlertIslandBody } from './AlertIsland'

/**
 * Bare renderer surface for the system-level island window (`#/island`):
 * no shell chrome, transparent body, driven entirely by relayed IPC events.
 * The window is click-through everywhere except while the pointer hovers the
 * island itself, so desktop content beneath stays fully interactive.
 */

const AUTO_DISMISS_MS = 8_000
// Generous margin over the collapse: the fallback only exists for a window that
// will never deliver the exit callback (throttled or occluded renderer), and
// hiding a millisecond early would cut the animation off at full size.
const EXIT_FALLBACK_MS = ISLAND_COLLAPSE_MS * 3

/** Runtime shape guard for items relayed over IPC (our own payload, still validate) */
function isValidAlert(v: unknown): v is AlertItem {
  if (v == null || typeof v !== 'object') return false
  const a = v as AlertItem
  return (
    typeof a.id === 'string' &&
    typeof a.agentName === 'string' &&
    (a.kind === 'window-reset' || a.kind === 'high-usage' || a.kind === 'low-balance')
  )
}

export function IslandSurface() {
  const [batch, setBatch] = useState<AlertItem[]>([])
  // The body the island renders; it outlives the batch so the collapse has
  // something to shrink around. Same retained pair as the in-app island.
  const [shown, setShown] = useState<{ latest: AlertItem; rest: number } | null>(null)
  const open = batch.length > 0

  // The transparent window must not paint a page background
  useEffect(() => {
    const prev = document.body.style.background
    document.body.style.background = 'transparent'
    return () => {
      document.body.style.background = prev
    }
  }, [])

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    // Start pass-through; the island container toggles it on hover
    void bridge.islandClickThrough(true)
    // Append (dedup by id) so an island that is already up absorbs new
    // arrivals instead of restarting — same rule as the in-app island.
    return bridge.onIslandAlert((alerts) => {
      const fresh = alerts.filter(isValidAlert)
      setBatch((current) => {
        const seen = new Set(current.map((a) => a.id))
        return [...current, ...fresh.filter((a) => !seen.has(a.id))]
      })
    })
  }, [])

  // Mirror the newest arrival and open; a new batch during a collapse reopens
  // the same shell instead of restarting the window.
  useEffect(() => {
    if (batch.length === 0) return
    setShown({ latest: batch[batch.length - 1], rest: batch.length - 1 })
  }, [batch])

  // Closing: collapse the island first and hide the window only once the
  // collapse has finished — hiding the window on the click would cut the
  // animation off at full size, which is exactly the "it just disappears"
  // behaviour this surface had.
  const dismiss = useCallback(() => setBatch([]), [])

  // Auto-hide; the timer restarts whenever the batch changes
  useEffect(() => {
    if (batch.length === 0) return
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [batch, dismiss])

  // Fallback teardown: the collapse reports completion from an animation frame,
  // and a throttled or occluded overlay window may never deliver one. An
  // always-on-top transparent window left behind would swallow desktop input,
  // so hide it on a timer if the callback has not arrived.
  useEffect(() => {
    if (open || !shown) return
    const timer = setTimeout(() => {
      setShown(null)
      void window.desktopBridge?.islandClickThrough(true)
      void window.desktopBridge?.islandHide()
    }, EXIT_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [open, shown])

  if (!shown) return null

  return (
    <div className="fixed inset-x-0 top-1.5 flex justify-center">
      <div
        onMouseEnter={() => void window.desktopBridge?.islandClickThrough(false)}
        onMouseLeave={() => void window.desktopBridge?.islandClickThrough(true)}
        className="pointer-events-auto"
      >
        <DynamicIsland
          view={open ? 'alert' : null}
          open={open}
          onExitComplete={() => {
            setShown(null)
            // Restore pass-through before hiding: dismissing with the pointer
            // over the island unmounts it without a mouseleave, and a window
            // that reappears still capturing clicks would swallow desktop
            // input across its whole transparent area.
            void window.desktopBridge?.islandClickThrough(true)
            void window.desktopBridge?.islandHide()
          }}
          compact={<span className="h-2 w-2 rounded-full bg-background/25" aria-hidden />}
        >
          <DynamicIslandView id="alert" className="min-w-[320px] max-w-[460px] py-2.5">
            <AlertIslandBody
              latest={shown.latest}
              rest={shown.rest}
              // Focusing the main window does not hide the overlay, so the
              // collapse keeps running while the app comes forward.
              onOpen={() => {
                void window.desktopBridge?.islandOpenMain()
                dismiss()
              }}
              onDismiss={() => dismiss()}
              dismissLabel="Dismiss"
              openLabel="Alerts"
            />
          </DynamicIslandView>
        </DynamicIsland>
      </div>
    </div>
  )
}

/** True while the renderer runs inside the dedicated island window */
export function useIslandMode(): boolean {
  const [islandMode, setIslandMode] = useState(() => window.location.hash.startsWith('#/island'))
  useEffect(() => {
    const onHash = () => setIslandMode(window.location.hash.startsWith('#/island'))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return islandMode
}
