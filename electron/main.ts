import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  Tray,
} from 'electron'
import { autoUpdater } from 'electron-updater'

// Tray icon: 16x16 solid indigo (#6366F1) RGBA PNG. Generated offline with a
// small Node script (hand-built PNG chunks + zlib deflate) and inlined as base64
// to avoid shipping a separate asset file for a single-color glyph.
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGNITvv4nxLMMGrAqAGjBgwXAwDvarkfnHQDVQAAAABJRU5ErkJggg=='

// Must stay in sync with ENC_PREFIX in src/lib/storage.ts (renderer side)
const ENC_PREFIX = 'enc:v3:'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// Gate for close-to-tray: only a real quit (tray menu / app.quit) may pass the
// window close event through instead of hiding the window.
let isQuitting = false

function showMainWindow(): void {
  const win = mainWindow
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b12',
    show: false,
    autoHideMenuBar: true,
    // Integrated title bar: hide the native chrome but keep the Windows
    // caption buttons pinned to the top-right as an overlay, so the bar
    // follows the app theme (VS Code style) instead of the system one.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0b12',
      symbolColor: '#f4f4f8',
      height: 40,
    },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  mainWindow = win

  // Dark background + delayed show prevents the white flash on startup
  win.once('ready-to-show', () => win.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    // Dev mode: served by the electron-vite renderer dev server (HMR enabled)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    // Packaged: main.cjs sits in dist-electron/, renderer bundle in dist/
    void win.loadFile(join(__dirname, '../dist/index.html'))
  }

  // Closing the window hides it to the tray; the tray menu's Quit is the only
  // way out (Windows-first behavior).
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

function createTray(): void {
  // Rounded transparent tray icon from the bundled asset; the inlined
  // base64 square stays as a fallback if the path is unavailable (e.g. a
  // hacked dev layout without the assets directory).
  let icon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'images', 'tray-16.png'))
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`)
  }
  tray = new Tray(icon)
  tray.setToolTip('Coding Usage')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  // Left click also brings the window up (typical Windows tray behavior)
  tray.on('click', () => showMainWindow())
}

// ===== tokscale local agent scanner =====

const TOKSCALE_CLIENTS = ['codex', 'kimi', 'opencode', 'dsh']
const TOKSCALE_CACHE_MS = 5 * 60_000

interface TokScanResult {
  /** Daily contributions from `tokscale graph` (per-day totals + client/model detail) */
  daily?: unknown
  error?: string
}

let tokScanCache: { at: number; result: TokScanResult } | null = null

/**
 * Resolve the tokscale binary shipped via the platform optional dependency
 * chain (`tokscale` → `@tokscale/cli-<platform>-<arch>`). Resolution anchors
 * at the app path so it works from both the dev tree and inside the asar.
 */
function resolveTokscaleBin(): string | null {
  const pkgName =
    process.platform === 'win32'
      ? process.arch === 'x64'
        ? '@tokscale/cli-win32-x64-msvc'
        : '@tokscale/cli-win32-arm64'
      : process.platform === 'darwin'
        ? '@tokscale/cli-darwin-arm64'
        : process.platform === 'linux'
          ? process.arch === 'x64'
            ? '@tokscale/cli-linux-x64-gnu'
            : '@tokscale/cli-linux-arm64-gnu'
          : null
  if (!pkgName) return null
  try {
    const nodeRequire = createRequire(join(app.getAppPath(), 'noop.js'))
    const pkgJson = nodeRequire.resolve(`${pkgName}/package.json`)
    return join(dirname(pkgJson), 'bin', process.platform === 'win32' ? 'tokscale.exe' : 'tokscale')
  } catch {
    return null
  }
}

/** Run one tokscale invocation (args after the binary); resolves with parsed JSON */
function runTokscale(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bin = resolveTokscaleBin()
    if (!bin) return reject(new Error('tokscale binary not found'))
    const child = spawn(bin, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('tokscale scan timed out'))
    }, 240_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`tokscale exited ${code}: ${err.slice(0, 160)}`))
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error('tokscale returned non-JSON output'))
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/**
 * Full scan: one `graph` invocation returns per-day contributions for every
 * configured client (token/cost/message totals + client/model detail), which
 * the renderer aggregates into today / month / all-time / daily series.
 */
async function scanTokscaleUsage(): Promise<TokScanResult> {
  const daily = await runTokscale([
    'graph',
    '--client',
    TOKSCALE_CLIENTS.join(','),
    '--since',
    '2020-01-01',
  ])
  return { daily }
}

function registerIpc(): void {
  // Route renderer HTTP through the main process: net.fetch is not subject to
  // CORS, so provider APIs are called directly with no third-party proxy.
  ipcMain.handle(
    'net:fetch',
    async (_event, url: unknown, headers: unknown): Promise<DesktopFetchResult> => {
      if (typeof url !== 'string' || url === '') return { status: 0, body: 'invalid url' }
      // Keep the trust boundary explicit even though the renderer is our own bundle
      const cleanHeaders: Record<string, string> = {}
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
          if (typeof v === 'string') cleanHeaders[k] = v
        }
      }
      try {
        const res = await net.fetch(url, { headers: cleanHeaders })
        return { status: res.status, body: await res.text() }
      } catch (error) {
        return { status: 0, body: String(error) }
      }
    },
  )

  // safeStorage wrappers. Returning null (instead of throwing) lets the
  // renderer fall back to plaintext storage on systems without a keyring.
  ipcMain.handle('safe:encrypt', (_event, plain: unknown): string | null => {
    if (typeof plain !== 'string' || plain === '') return null
    if (!safeStorage.isEncryptionAvailable()) return null
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  })

  ipcMain.handle('safe:decrypt', (_event, blob: unknown): string | null => {
    if (typeof blob !== 'string' || !blob.startsWith(ENC_PREFIX)) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      // Throws on tampered/garbage ciphertext — normalized to null for the renderer
      return safeStorage.decryptString(Buffer.from(blob.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return null
    }
  })

  ipcMain.handle('app:set-login-item', (_event, open: unknown): void => {
    app.setLoginItemSettings({ openAtLogin: open === true })
  })

  // Keep the integrated title-bar overlay in sync with the app theme so the
  // window chrome never shows a foreign (system-default) color band.
  ipcMain.handle('window:set-theme', (_event, mode: unknown): void => {
    const dark = mode === 'dark'
    mainWindow?.setTitleBarOverlay({
      color: dark ? '#0b0b12' : '#eef0f5',
      symbolColor: dark ? '#f4f4f8' : '#16161f',
      height: 40,
    })
  })

  // Codex subscription quota: reads the local ChatGPT OAuth login and queries
  // the official wham endpoint. The credential stays on this machine; only the
  // request to chatgpt.com is made. Returns {available:false, reason} when
  // there is no ChatGPT-authenticated Codex login (e.g. API-key mode).
  ipcMain.handle('codex:quota', async (): Promise<{ available: boolean; body?: string; reason?: string }> => {
    try {
      const home = process.env.CODEX_HOME ?? homedir()
      const authRaw = await readFile(join(home, '.codex', 'auth.json'), 'utf8')
      const auth = JSON.parse(authRaw) as {
        auth_mode?: string
        tokens?: { access_token?: string; account_id?: string }
      }
      if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token) {
        return { available: false, reason: 'no-chatgpt-auth' }
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        'User-Agent': 'codex-cli',
        Accept: 'application/json',
      }
      if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const res = await net.fetch('https://chatgpt.com/backend-api/wham/usage', {
          headers,
          redirect: 'error',
          signal: controller.signal,
        })
        if (!res.ok) return { available: false, reason: `http-${res.status}` }
        return { available: true, body: await res.text() }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return { available: false, reason: 'no-auth-file' }
    }
  })

  // Local agent usage scan. Cached in the main process: a full three-period
  // scan takes tens of seconds, so repeated renderer refreshes are cheap.
  ipcMain.handle('tokscale:scan', async (): Promise<TokScanResult> => {
    const now = Date.now()
    if (tokScanCache && now - tokScanCache.at < TOKSCALE_CACHE_MS) return tokScanCache.result
    try {
      const result = await scanTokscaleUsage()
      tokScanCache = { at: now, result }
      return result
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e) }
    }
  })
}

function setupAutoUpdater(): void {
  // Auto-update only makes sense for the packaged install; dev builds skip it
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch(() => {
    // Offline or GitHub unreachable — retried on next launch
  })
  autoUpdater.on('update-downloaded', (info) => {
    // TODO(renderer): subscribe to this channel and surface an
    // "update ready, restart to apply" toast in the UI.
    mainWindow?.webContents.send('desktop:update-downloaded', info.version)
  })
}

// Single instance: launching the app twice focuses the existing window instead
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  void app.whenReady().then(() => {
    registerIpc()
    createWindow()
    createTray()
    setupAutoUpdater()
  })

  // Keep running in the tray when every window is hidden/closed; real quits go
  // through the tray menu which flips isQuitting first.
  app.on('window-all-closed', () => {
    // Intentional no-op: the tray keeps the app alive
  })

  app.on('before-quit', () => {
    // Let pending close events pass through during the real quit sequence
    isQuitting = true
  })
}
