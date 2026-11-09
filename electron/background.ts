import { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** How long one background cycle may take before its window is closed anyway. */
const CYCLE_TIMEOUT_MS = 90_000

/**
 * Runs a refresh cycle — accounts, alerts, pushes, snapshots — while no window is
 * open, in a hidden window that exists only for that cycle.
 *
 * Closing to the tray destroys the main window because a hidden Chromium renderer
 * holds about 115 MB whether or not anyone is looking at it. The work it was
 * doing still has to happen, and the cheapest correct way to keep it is to let
 * the renderer do it: the shell opens a hidden window on the app's own bundle,
 * the page runs the same refresh/alert/push code it runs when visible, reports
 * `background:done`, and the window is destroyed.
 *
 * Reimplementing that work in the main process was tried and rejected: it means
 * a second alert store, a second push cooldown, a second push log and a second
 * copy of the read state, and those copies drift — an alert already marked read
 * gets pushed again, the integrations page stops seeing background failures, and
 * the trend snapshots simply stop while the window is closed. One window per
 * cycle keeps every piece of that state in one place (the same localStorage),
 * and the peak cost of about 115 MB lasts seconds instead of all day.
 */
export class Background {
  private win: BrowserWindow | null = null
  private timer: NodeJS.Timeout | null = null
  /** Last read interval, so scheduling never races on an await. */
  private minutes = 0
  private stopped = false

  constructor(
    private readonly options: {
      userData: string
      /** True while a real window exists: it refreshes on its own, so skip. */
      hasMainWindow: () => boolean
      /** True while a webhook send started by the cycle window is still running. */
      busy: () => boolean
      /** Loads the app's frontend on the cycle route, as the main window does. */
      load: (win: BrowserWindow) => void
      preload: string
    },
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    this.minutes = await refreshMinutes(this.options.userData)
    this.schedule()
  }

  /** Stops the timer and closes a cycle window that is still open. */
  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.cancelCycle()
  }

  /** Re-reads the interval (a settings write) and re-arms the cycle. */
  async reschedule(): Promise<void> {
    this.minutes = await refreshMinutes(this.options.userData)
    this.schedule()
  }

  /** A window came up: its page does the work, so end the cycle in flight. */
  cancelCycle(): void {
    this.closeWindow()
  }

  /** The cycle window finished: close it, then arm the next cycle. */
  done(sender: Electron.WebContents): void {
    const win = this.win
    if (!win || win.webContents !== sender) return
    // A webhook send outlives the page that asked for it. Closing now would let
    // the message arrive while the cooldown record is lost, and the next cycle
    // would send the same alert again.
    if (this.options.busy()) {
      const retry = setTimeout(() => this.done(sender), 250)
      retry.unref()
      return
    }
    this.closeWindow()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    this.clearTimer()
    if (this.stopped) return
    // A window of its own refreshes the data; when it closes, closeToTray calls
    // reschedule and the cycles start again.
    if (this.options.hasMainWindow()) return
    if (this.minutes <= 0) return
    this.timer = setTimeout(() => this.runCycle(), this.minutes * 60_000)
    this.timer.unref()
  }

  private runCycle(): void {
    if (this.stopped || this.win) return
    if (this.options.hasMainWindow()) {
      this.schedule()
      return
    }
    const win = new BrowserWindow({
      show: false,
      width: 480,
      height: 360,
      // The page has work to do while nobody watches: Chromium would otherwise
      // throttle its timers to once a minute.
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    })
    this.win = win
    // A page that never says it is done (a hung request, a broken build) must
    // not leave the window behind: the cycle is closed either way.
    const guard = setTimeout(() => this.closeWindow(), CYCLE_TIMEOUT_MS)
    guard.unref()
    win.on('closed', () => {
      clearTimeout(guard)
      if (this.win === win) this.win = null
      // Arm the next cycle even if this one ended in a timeout.
      this.schedule()
    })
    this.options.load(win)
  }

  private closeWindow(): void {
    const win = this.win
    if (!win) return
    this.win = null
    if (!win.isDestroyed()) win.destroy()
  }
}

/** The user's refresh interval, read from the settings mirror. */
async function refreshMinutes(userData: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(userData, 'settings-backup.json'), 'utf8'),
    )
    if (parsed == null || typeof parsed !== 'object') return 0
    const minutes = (parsed as { autoRefreshMin?: unknown }).autoRefreshMin
    return typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : 0
  } catch {
    // No mirror yet: nothing to refresh on a schedule
    return 0
  }
}
