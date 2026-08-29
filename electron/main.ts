import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
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
  session,
  Tray,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { fetchClaudeUsage, fetchGeminiUsage, type QuotaOutcome } from './subscription-quotas'

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
// window close event through instead of routing it to the renderer dialog.
let isQuitting = false
// Close arrived before the renderer had a chance to load its listeners —
// replayed on did-finish-load so an early Alt+F4 isn't silently swallowed.
let pendingCloseRequest = false
// Same replay idea for the update toast: if the download completes while the
// window is still loading, the renderer subscribes too late and misses it.
let lastUpdateVersion: string | null = null

function showMainWindow(): void {
  const win = mainWindow
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Renderer CSP. Everything (icons, fonts, scripts) ships inside the bundle, so
 * the packaged policy can pin every directive to 'self'. The dev server needs
 * two extra doors: the Vite HMR websocket and the inline react-refresh
 * preamble that @vitejs/plugin-react injects into index.html.
 */
function applyCsp(): void {
  const dev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
  const csp = [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // React writes element style attributes; Tailwind emits a plain stylesheet
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'" +
      (dev ? ' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*' : ''),
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
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
    // Frameless-style integrated title bar (VS Code style): the native chrome
    // is hidden and the DOM draws its own caption buttons (TopBar), which get
    // real hover states and can intercept close for the tray-or-quit dialog.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Preload only touches contextBridge/ipcRenderer, so it stays compatible
      // with the Chromium sandbox; keep the renderer's Node access off.
      sandbox: true,
      spellcheck: false,
    },
  })
  mainWindow = win

  // Custom caption buttons render their own hover states in the DOM, so the
  // native Window Controls Overlay stays off; report maximize transitions so
  // the restore glyph can swap live.
  const pushMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send('desktop:window-maximized', win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)

  // Close interception routes to the renderer's styled confirm dialog; if the
  // event lands before the page loaded, replay once it did.
  win.on('close', (e) => {
    if (isQuitting || !win.webContents.isLoading()) {
      if (!isQuitting && !win.isDestroyed()) {
        e.preventDefault()
        win.webContents.send('desktop:close-requested')
      }
      return
    }
    e.preventDefault()
    pendingCloseRequest = true
  })
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return
    if (pendingCloseRequest) {
      pendingCloseRequest = false
      win.webContents.send('desktop:close-requested')
    }
    // Replay a download that finished before the toast could subscribe
    if (lastUpdateVersion) {
      win.webContents.send('desktop:update-downloaded', lastUpdateVersion)
    }
  })

  // Dark background + delayed show prevents the white flash on startup
  win.once('ready-to-show', () => win.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    // Dev mode: served by the electron-vite renderer dev server (HMR enabled)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    // Packaged: main.cjs sits in dist-electron/, renderer bundle in dist/
    void win.loadFile(join(__dirname, '../dist/index.html'))
  }
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

// Must stay in sync with AGENT_CLIENTS in src/lib/agent-usage.ts (same ids,
// which also drive the renderer's labels/icons). tokscale accepts each id via
// `graph --client`; clients without local session dirs are skipped by the CLI.
const TOKSCALE_CLIENTS = [
  'codex',
  'claude',
  'kimi',
  'opencode',
  'gemini',
  'cursor',
  'copilot',
  'qwen',
  'trae',
  'cline',
  'roocode',
  'kilocode',
  'goose',
  'zed',
  'kiro',
  'augment',
  'droid',
  'amp',
  'grok',
  'dsh',
]
const TOKSCALE_CACHE_MS = 5 * 60_000

interface TokScanResult {
  /** Daily contributions from `tokscale graph` (per-day totals + client/model detail) */
  daily?: unknown
  error?: string
}

let tokScanCache: { at: number; result: TokScanResult } | null = null

// Subscription probes cost upstream API calls (Gemini up to three round-trips),
// so successful outcomes are cached briefly to survive Plans-page revisits.
// Failures stay uncached: a fresh login must show up on the very next visit.
const QUOTA_CACHE_MS = 2 * 60_000
const quotaCache = new Map<string, { at: number; result: QuotaOutcome }>()

async function cachedQuotaOutcome(
  key: string,
  probe: () => Promise<QuotaOutcome>,
): Promise<QuotaOutcome> {
  const hit = quotaCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < QUOTA_CACHE_MS) return hit.result
  const result = await probe()
  if (result.available) quotaCache.set(key, { at: now, result })
  return result
}

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
        ? process.arch === 'arm64'
          ? '@tokscale/cli-darwin-arm64'
          : '@tokscale/cli-darwin-x64'
        : process.platform === 'linux'
          ? process.arch === 'x64'
            ? '@tokscale/cli-linux-x64-gnu'
            : '@tokscale/cli-linux-arm64-gnu'
          : null
  if (!pkgName) return null
  try {
    const nodeRequire = createRequire(join(app.getAppPath(), 'noop.js'))
    const pkgJson = nodeRequire.resolve(`${pkgName}/package.json`)
    // require.resolve answers with the VIRTUAL in-asar path; the real binary
    // lives in app.asar.unpacked (asarUnpack), so spawn needs that directory
    const binPath = join(dirname(pkgJson), 'bin', process.platform === 'win32' ? 'tokscale.exe' : 'tokscale')
    return binPath.includes('app.asar')
      ? binPath.replace('app.asar', 'app.asar.unpacked')
      : binPath
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
        // Bounded: a hung provider connection must not keep refreshAll's
        // Promise.all (and the manual-refresh spinner) pending forever
        const res = await net.fetch(url, {
          headers: cleanHeaders,
          signal: AbortSignal.timeout(30_000),
        })
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

  // Settings mirror: the renderer writes the encrypted v3 document to a file
  // in userData so a corrupted/lost localStorage leveldb can be restored.
  ipcMain.handle('settings:backup-write', (_event, payload: unknown): void => {
    if (typeof payload !== 'string' || payload.length === 0) return
    // Fire-and-forget mirror; the catch swallows async rejections the outer
    // (synchronous) handler could never see
    void writeFile(join(app.getPath('userData'), 'settings-backup.json'), payload, 'utf8').catch(
      () => {},
    )
  })

  ipcMain.handle('settings:backup-read', async (): Promise<string | null> => {
    try {
      return await readFile(join(app.getPath('userData'), 'settings-backup.json'), 'utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle('app:set-login-item', (_event, open: unknown): void => {
    app.setLoginItemSettings({ openAtLogin: open === true })
  })

  // Custom caption buttons (DOM-drawn replacements for the native overlay).
  ipcMain.handle('window:minimize', (): void => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize-toggle', (): void => {
    const win = mainWindow
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  // Styled in-app confirm dialog owns the tray-vs-quit decision; the main
  // process only executes the renderer's final choice.
  ipcMain.handle('window:hide', (): void => {
    mainWindow?.hide()
  })

  ipcMain.handle('app:quit', (): void => {
    isQuitting = true
    app.quit()
  })

  /** Renderer subscription channel for maximize-state changes */
  ipcMain.handle('window:get-maximized', (): boolean => mainWindow?.isMaximized() ?? false)

  // Applied from the update-ready toast: quitAndInstall without a downloaded
  // update throws, so the failure is swallowed (the toast only renders after
  // 'update-downloaded' anyway).
  ipcMain.handle('app:install-update', (): void => {
    try {
      autoUpdater.quitAndInstall()
    } catch {
      // No staged update — nothing to install
    }
  })

  // Codex subscription quota: reads the local ChatGPT OAuth login and queries
  // the official wham endpoint. The credential stays on this machine; only the
  // request to chatgpt.com is made. Returns {available:false, reason} when
  // there is no ChatGPT-authenticated Codex login (e.g. API-key mode).
  ipcMain.handle(
    'codex:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('codex', async () => {
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
          const res = await net.fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers,
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) return { available: false, reason: `http-${res.status}` }
          return { available: true, body: await res.text() }
        } catch (e) {
          // Distinguish "never logged in" from "the request failed" — the
          // card copy differs (no-auth-file reads as an honest empty state)
          return { available: false, reason: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network' }
        }
      }),
  )

  // Claude Code subscription quota: reads the local ~/.claude OAuth login and
  // queries the official usage endpoint. Credential handling lives in
  // subscription-quotas.ts; only usage numbers cross the IPC boundary.
  ipcMain.handle(
    'claude:usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('claude', () =>
        fetchClaudeUsage(net.fetch, homedir(), process.env.CLAUDE_CONFIG_DIR || undefined),
      ),
  )

  // Gemini Code Assist subscription quota via the local Gemini CLI login
  // (~/.gemini/oauth_creds.json), including in-memory token refresh.
  ipcMain.handle(
    'gemini:usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('gemini', () => fetchGeminiUsage(net.fetch, homedir())),
  )

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
    // Consumed by the renderer's UpdateToast ("update ready, restart to apply")
    lastUpdateVersion = info.version
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
    applyCsp()
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
