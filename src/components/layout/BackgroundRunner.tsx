import { useEffect, useRef, useState } from 'react'
import { DataProvider, useData } from '@/lib/data-context'
import { newAlertsFor } from '@/lib/alerts'

/** True while this page runs as the shell's hidden background cycle window */
export function useBackgroundMode(): boolean {
  const [mode, setMode] = useState(() => window.location.hash.startsWith('#/background'))
  useEffect(() => {
    const onHash = () => setMode(window.location.hash.startsWith('#/background'))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return mode
}

/**
 * The hidden window the shell opens for one refresh cycle while the main window
 * is closed.
 *
 * It mounts the app's own data layer, so the accounts, alerts, pushes, trend
 * snapshots and read state all come from the one localStorage the visible window
 * uses — nothing is reimplemented in the main process and nothing can drift.
 * Once the first cycle has settled it tells the shell to close the window; the
 * shell also closes it on a timeout, and waits for in-flight webhook sends.
 */
export function BackgroundRunner() {
  return (
    <DataProvider background>
      <IslandRelay />
      <CycleSignal />
    </DataProvider>
  )
}

/** How long to let pushes and snapshot writes finish after the fetch cycle. */
const SETTLE_MS = 3_000

function CycleSignal() {
  // refreshTick counts finished cycles whether or not the accounts answered:
  // a run where every key is rejected still ends, and the window must close.
  const { refreshTick, refreshingAll } = useData()
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current || refreshTick === 0 || refreshingAll) return
    sent.current = true
    const timer = setTimeout(() => void window.desktopBridge?.backgroundDone(), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [refreshTick, refreshingAll])

  return null
}

/**
 * The desktop island while no window is open. The overlay lives in its own
 * window, so it still works — but only if something relays batches to it, which
 * the in-app island (mounted by the shell) cannot do here.
 */
function IslandRelay() {
  const { alerts, settings } = useData()
  const previous = useRef(new Map(alerts.map((alert) => [alert.id, alert.resolved === true])))

  useEffect(() => {
    const prev = previous.current
    previous.current = new Map(alerts.map((alert) => [alert.id, alert.resolved === true]))
    const bridge = window.desktopBridge
    if (!bridge || !settings.desktopIsland) return
    const fresh = newAlertsFor(prev, alerts)
    if (fresh.length > 0) void bridge.islandShow(fresh)
  }, [alerts, settings.desktopIsland])

  return null
}
