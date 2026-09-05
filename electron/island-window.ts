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
// Batches that arrived while the surface was still loading — replayed on
// did-finish-load, otherwise the very first alert of a session is lost to
// the load race.
let pendingAlerts: unknown[] | null = null

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
  win.webContents.on('did-finish-load', () => {
    if (pendingAlerts) {
      win.webContents.send('island:alert', pendingAlerts)
      pendingAlerts = null
    }
  })
  if (devRendererUrl) {
    void win.loadURL(`${devRendererUrl}/#/island`)
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'), { hash: '/island' })
  }
  win.on('closed', () => {
    islandWindow = null
  })
  return win
}

function positionTopCenter(win: BrowserWindow): void {
  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + Math.round((workArea.width - ISLAND_WIDTH) / 2)
  win.setPosition(x, workArea.y + TOP_OFFSET)
}

/** Relay a fresh alert batch to the surface and raise the window */
export function islandShow(alerts: unknown[]): void {
  if (alerts.length === 0) return
  const win = islandWindow && !islandWindow.isDestroyed() ? islandWindow : createIslandWindow()
  islandWindow = win
  positionTopCenter(win)
  if (!win.isVisible()) win.showInactive()
  if (win.webContents.isLoading()) {
    pendingAlerts = alerts
  } else {
    win.webContents.send('island:alert', alerts)
  }
}

export function islandHide(): void {
  if (islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible()) {
    islandWindow.hide()
  }
}

/** Toggle pass-through; the renderer calls this from hover enter/leave */
export function islandSetClickThrough(clickThrough: boolean): void {
  if (!islandWindow || islandWindow.isDestroyed()) return
  islandWindow.setIgnoreMouseEvents(clickThrough, { forward: true })
}
