import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

/**
 * System-level dynamic island: a transparent, frameless, always-on-top,
 * non-focusable window pinned to the top-center of the primary display's
 * work area. It renders the same DynamicIsland component through a bare
 * `#/island` route; the main window relays freshly derived alerts here via
 * IPC (`island:show`), and the surface hides itself through `island:hide`
 * when the batch is dismissed or times out.
 *
 * Platform notes:
 * - `focusable: false` keeps the overlay from ever stealing keyboard focus.
 * - The whole surface is click-through by default (`setIgnoreMouseEvents`).
 *   The renderer flips it off while the pointer hovers the island so the
 *   buttons stay clickable, then back on — `forward: true` keeps hover
 *   tracking alive while pass-through.
 * - Windows cannot resize transparent windows (irrelevant here), and an
 *   exclusive-fullscreen app may still cover the overlay — a known limit of
 *   every top-level floating window.
 */

const ISLAND_WIDTH = 520
const ISLAND_HEIGHT = 170
const TOP_OFFSET = 6

let islandWindow: BrowserWindow | null = null
let devRendererUrl: string | null = null
// Batches that arrived before the surface was listening — replayed once it
// says so (`island:ready`), otherwise the first alert of a session is lost to
// the load race: the window exists long before React registers the listener.
let pendingAlerts: unknown[] | null = null
// The surface's listener is live; reset whenever its window goes away
let rendererReady = false
// Pending release of the overlay renderer after the surface has hidden itself
let idleDestroyTimer: NodeJS.Timeout | null = null

/**
 * How long the hidden overlay window is kept before its process is released.
 *
 * A renderer process costs about 40 MB of private memory and 100 MB of working
 * set whether or not its window is visible: measured on this app, the 520x170
 * overlay with ten DOM nodes holds the same Chromium baseline as the main
 * window, and its own JS heap is under 10 MB. Alerts arrive in bursts seconds
 * apart, so the window is parked for a grace period and then destroyed — an
 * idle app pays nothing for an overlay it is not showing.
 */
const IDLE_DESTROY_MS = 30_000

function cancelIdleDestroy(): void {
  if (idleDestroyTimer) {
    clearTimeout(idleDestroyTimer)
    idleDestroyTimer = null
  }
}

function scheduleIdleDestroy(win: BrowserWindow): void {
  cancelIdleDestroy()
  idleDestroyTimer = setTimeout(() => {
    idleDestroyTimer = null
    // Shown again in the meantime: the surface still needs this renderer
    if (win.isDestroyed() || win.isVisible()) return
    win.destroy()
  }, IDLE_DESTROY_MS)
  idleDestroyTimer.unref()
}

/** Wire the dev/prod renderer entry; call once from app.whenReady */
export function initIslandWindow(devUrl: string | null): void {
  devRendererUrl = devUrl
}

function createIslandWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: ISLAND_WIDTH,
    height: ISLAND_HEIGHT,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      // Same trust boundary as the main renderer: our own bundle only
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  })
  // Beat every normal window (but not necessarily exclusive-fullscreen apps)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  if (devRendererUrl) {
    void win.loadURL(`${devRendererUrl}/#/island`)
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'), { hash: '/island' })
  }
  win.on('closed', () => {
    cancelIdleDestroy()
    pendingAlerts = null
    rendererReady = false
    islandWindow = null
  })
  return win
}

/**
 * The overlay's listener is registered and it can receive alerts.
 *
 * Called from the surface after it subscribes. Sending as soon as the page
 * finished loading is not enough: `did-finish-load` fires before React runs its
 * effects, so a batch relayed at that moment was dropped — and since the window
 * is destroyed when idle, that race would hit the first alert after every idle
 * period, not just the first one of the session.
 */
export function islandRendererReady(): void {
  rendererReady = true
  if (!pendingAlerts) return
  const win = islandWindow
  const batch = pendingAlerts
  pendingAlerts = null
  if (win && !win.isDestroyed()) win.webContents.send('island:alert', batch)
}

function positionTopCenter(win: BrowserWindow): void {
  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + Math.round((workArea.width - ISLAND_WIDTH) / 2)
  win.setPosition(x, workArea.y + TOP_OFFSET)
}

/** Relay a fresh alert batch to the surface and raise the window */
export function islandShow(alerts: unknown[]): void {
  if (alerts.length === 0) return
  cancelIdleDestroy()
  const win = islandWindow && !islandWindow.isDestroyed() ? islandWindow : createIslandWindow()
  islandWindow = win
  positionTopCenter(win)
  if (!win.isVisible()) win.showInactive()
  // Relay only when the surface can hear it; until then the batch waits for
  // `islandRendererReady`, which also covers a freshly created window.
  if (rendererReady && !win.webContents.isLoading()) {
    win.webContents.send('island:alert', alerts)
  } else {
    pendingAlerts = alerts
  }
}

export function islandHide(): void {
  if (islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible()) {
    islandWindow.hide()
    scheduleIdleDestroy(islandWindow)
  }
}

/** Toggle pass-through; the renderer calls this from hover enter/leave */
export function islandSetClickThrough(clickThrough: boolean): void {
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.setIgnoreMouseEvents(clickThrough, { forward: true })
}
