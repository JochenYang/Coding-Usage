import { useEffect, useState } from 'react'
import type { AlertItem } from '@/lib/alerts'
import { useIslandBloom } from '@/lib/hooks/use-island-bloom'
import { DynamicIsland, DynamicIslandView } from '@/components/beui/dynamic-island'
import { AlertIslandBody } from './AlertIsland'

/**
 * Bare renderer surface for the system-level island window (`#/island`):
 * no shell chrome, transparent body, driven entirely by relayed IPC events.
 * The window is click-through everywhere except while the pointer hovers the
 * island itself, so desktop content beneath stays fully interactive.
 */

const AUTO_DISMISS_MS = 8_000

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
    return bridge.onIslandAlert((alerts) => {
      setBatch(alerts.filter(isValidAlert))
    })
  }, [])

  // Auto-hide: the surface dismisses itself, the main process hides the window
  useEffect(() => {
    if (batch.length === 0) return
    const timer = setTimeout(() => {
      setBatch([])
      void window.desktopBridge?.islandHide()
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [batch])

  const bloom = useIslandBloom(batch.length > 0)
  if (batch.length === 0) return null

  const latest = batch[batch.length - 1]

  return (
    <div className="fixed inset-x-0 top-1.5 flex justify-center">
      <div
        onMouseEnter={() => void window.desktopBridge?.islandClickThrough(false)}
        onMouseLeave={() => void window.desktopBridge?.islandClickThrough(true)}
        className="pointer-events-auto"
      >
        <DynamicIsland view={bloom ? 'alert' : null} compact={<span className="h-2 w-2 rounded-full bg-background/25" aria-hidden />}>
          <DynamicIslandView id="alert" className="min-w-[320px] max-w-[460px] py-2.5">
            <AlertIslandBody
              latest={latest}
              rest={batch.length - 1}
              onOpen={() => {
                setBatch([])
                void window.desktopBridge?.islandHide()
                void window.desktopBridge?.islandOpenMain()
              }}
              onDismiss={() => {
                setBatch([])
                void window.desktopBridge?.islandHide()
              }}
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
