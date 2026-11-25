import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  safeStorage,
  session,
  shell,
  screen,
  Tray,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { readSettingsMirror, writeSettingsMirror } from './settings-mirror'
import { Background } from './background'
import { guessLocale, mergeTrayPrefs, TRAY_LABELS, type TrayPrefs } from './tray-prefs'
import { fetchClaudeUsage, fetchGeminiUsage, type QuotaOutcome } from './subscription-quotas'
import { fetchGrokUsage } from './grok-usage'
import { qoderStoreBody, readQoderQuota, type QoderQuotaOutcome } from './qoder-quota'
import { fetchTraeIntlUsage, fetchTraeUsage } from './trae-usage'
import { fetchKimiUsage } from './kimi-usage'
import { fetchAntigravityUsage } from './antigravity-quota'
import { fetchCopilotUsage, fetchCursorUsage } from './local-plan-quota'
import { fetchClineQuota } from './cline-quota'
import { fetchJetBrainsQuota } from './jetbrains-quota'
import { fetchWindsurfQuota } from './windsurf-quota'
import { fetchKiroQuota } from './kiro-quota'
import { fetchKiloQuota } from './kilo-quota'
import { fetchFactoryQuota } from './factory-quota'
import { fetchDevinQuota } from './devin-quota'
import { fetchAmpUsage } from './amp-quota'
import { fetchCodexResetCredits, mergeCodexResetCredits } from './codex-reset-credits'
import { fetchAlibabaCodingPlanQuota, fetchAlibabaTokenPlanQuota, fetchPastedQuota, fetchQwenCloudQuota } from './aliyun-quota'
import { clearConsoleSession, connectAlibabaConsole, hasConsoleSession, readConsoleCookieHeader } from './alibaba-connect'
import {
  clearPastedRequest,
  initPastedRequests,
  parseCurl,
  readPastedRequest,
  savePastedRequest,
  type PastedTarget,
} from './pasted-requests'
import { flushQuotaStoreSync, initQuotaStore, readQuotaSnapshot, saveQuotaOutcome } from './quota-store'
import {
  clearOpendesignCredential,
  dropOpendesignLogin,
  fetchOpendesignQuota,
  initOpendesignStore,
  pollOpendesignLogin,
  readOpendesignCredential,
  saveOpendesignCredential,
  startOpendesignLogin,
  type OpendesignLoginStartIpcResult,
  type OpendesignPollResult,
} from './opendesign-quota'
import { objOf, pickMembers } from './json-shape'
import { isTimeoutError } from './fetch-errors'
import { getPricingMeta, getPricingTable, priceTokens, type PricingMeta } from './model-pricing'
import { hasClientEntries, mergeGraphPayloads } from './tokscale-merge'
import {
  closeUsageStore,
  extractContributions,
  getUsageStoreStats,
  getUsageStoreUpdatedAt,
  initUsageStore,
  mergeScanIntoStore,
  purgeUsageBefore,
  readStoredContributions,
  type UsagePurgeResult,
  type UsageStoreStats,
} from './usage-store'
import { readMiniMaxCodeUsage } from './minimax-code-usage'
import { readAntigravityUsage } from './antigravity-usage'
import { readCodeBuddyUsage } from './codebuddy-usage'
import { readCindyUsage } from './cindy-usage'
import { readQoderUsage } from './qoder-usage'
import { readTraeLocalUsage } from './trae-local-usage'
import { reconcileProviderAttribution } from './provider-reconcile'
import { readDshUsage } from './dsh-usage'
import { ensureWorkbuddyAliases } from './workbuddy-aliases'
import { decodeNonAsciiIds, ensureScannableModelIds } from './model-id-sanitize'
import { ilinkBeginLogin, ilinkPollActivation, ilinkPollLogin } from './weixin-ilink'
import {
  initIlinkSession,
  startIlinkSession,
  stopIlinkSession,
} from './weixin-session'
import { initIslandWindow, islandHide, islandRendererReady, islandSetClickThrough, islandShow } from './island-window'
import { sendWebhook } from './webhook-send'
import {
  listAgentProviderModels,
  readAgentConfig,
  removeAgentProvider,
  revealAgentKey,
  saveAgentProvider,
  testAgentModel,
} from './agent-config-service'
import { parseProviderInput, toAgentId } from '../src/lib/agent-config'
import { ANTIGRAVITY_FLAVOURS, isAntigravityFlavour } from '../src/lib/antigravity-quota'
import type {
  AgentConfigPayload,
  AgentKeyReveal,
  AgentModelListResult,
  AgentModelTestResult,
  AgentWriteResult,
} from '../src/lib/agent-config'

// Tray icon: 16x16 solid indigo (#6366F1) RGBA PNG. Generated offline with a
// small Node script (hand-built PNG chunks + zlib deflate) and inlined as base64
// to avoid shipping a separate asset file for a single-color glyph.
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGNITvv4nxLMMGrAqAGjBgwXAwDvarkfnHQDVQAAAABJRU5ErkJggg=='

// Must stay in sync with ENC_PREFIX in src/lib/storage.ts (renderer side)
const ENC_PREFIX = 'enc:v3:'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// Refreshes accounts, derives alerts and pushes them while no window is open:
// closing to the tray destroys the window and its renderer process.
let background: Background | null = null
// Webhook sends in flight, so a background cycle window is not closed while one
// is still running (the message would arrive with its cooldown record lost).
let pendingWebhookSends = 0
// Last window rectangle, so closing to the tray and coming back lands where the
// user left it, and so a relaunch does too.
let lastBounds: Electron.Rectangle | null = null
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
  // Closed to the tray: the window was destroyed, so bring a fresh one up. The
  // page reloads and reads its state back from disk.
  if (!win || win.isDestroyed()) {
    // A background cycle may be running: its page would fetch and push the same
    // accounts a second time, and its settings snapshot is older than the one
    // about to be edited. End it before the real window appears.
    background?.cancelCycle()
    createWindow()
    // A visible window refreshes on its own: stand the background cycles down.
    void background?.reschedule()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Closing to the tray, not hiding: a hidden Chromium renderer keeps about
 * 115 MB resident whether or not anyone can see it, and the background engine
 * keeps refreshes and alerts flowing meanwhile.
 */
function closeToTray(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  rememberBounds(win)
  mainWindow = null
  win.destroy()
  // Nothing refreshes while the window is gone: hand the work to the hidden
  // cycle window until a window exists again.
  void background?.reschedule()
}

/** Saves the rectangle a restored window should take. */
function rememberBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMaximized() || win.isMinimized() || win.isFullScreen()) return
  lastBounds = win.getBounds()
  void writeFile(join(app.getPath('userData'), 'window-state.json'), JSON.stringify(lastBounds), 'utf8').catch(
    () => {},
  )
}

/** Reads back the rectangle the last session left the window in. */
async function loadWindowState(): Promise<void> {
  try {
    const parsed = JSON.parse(
      await readFile(join(app.getPath('userData'), 'window-state.json'), 'utf8'),
    ) as Electron.Rectangle
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number' && typeof parsed?.width === 'number') {
      lastBounds = parsed
    }
  } catch {
    // First run, or an unreadable file: the window opens centred
  }
}

/**
 * The saved rectangle, unless no display reaches it any more: a window restored
 * onto an unplugged monitor would never be found again.
 */
function usableBounds(): Electron.Rectangle | null {
  const bounds = lastBounds
  if (!bounds) return null
  const onScreen = screen.getAllDisplays().some(({ workArea }) =>
    bounds.x < workArea.x + workArea.width &&
    bounds.x + bounds.width > workArea.x &&
    bounds.y < workArea.y + workArea.height &&
    bounds.y + bounds.height > workArea.y,
  )
  return onScreen ? bounds : null
}

/** Brings the window up and asks its page for the alerts center. */
function openAlertsCenter(): void {
  const had = !!mainWindow && !mainWindow.isDestroyed()
  showMainWindow()
  const win = mainWindow
  if (!win) return
  // A window that is still loading would drop the message, so wait it out.
  if (had) win.webContents.send('island:open-alerts')
  else win.webContents.once('did-finish-load', () => win.webContents.send('island:open-alerts'))
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
  const restored = usableBounds()
  const win = new BrowserWindow({
    x: restored?.x,
    y: restored?.y,
    width: restored?.width ?? 1280,
    height: restored?.height ?? 800,
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
  // The window can go away without the user quitting (close to tray destroys
  // it); the reference must not outlive it, or showMainWindow would act on a
  // destroyed object instead of rebuilding.
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Renderer-initiated window.open / target="_blank" links (provider docs,
  // key pages) must open in the system browser: Electron's default is a new
  // in-app window. Only https leaves the app; everything else is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

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

// Tray-menu prefs converge on the renderer's first `prefs:tray-sync` push.
// The theme default mirrors ThemeProvider's no-record fallback (dark).
let trayPrefs: TrayPrefs = { locale: guessLocale(app.getLocale()), theme: 'dark' }

/** Rebuild the tray context menu from the current prefs (labels follow locale). */
function rebuildTrayMenu(): void {
  if (!tray) return
  const labels = TRAY_LABELS[trayPrefs.locale]
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: labels.quit,
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
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
  rebuildTrayMenu()
  // Left click also brings the window up (typical Windows tray behavior)
  tray.on('click', () => showMainWindow())
}

// ===== tokscale local agent scanner =====

// Scanned through `graph --client`. Mostly mirrors AGENT_CLIENTS in
// src/lib/agent-usage.ts (which also drives the renderer's labels/icons), with
// deliberate differences: `mcode` (MiniMax Code), the three Antigravity
// flavours (`antigravity-ide`, `antigravity`, `antigravity-cli`), `qoder` and
// `cindy` are absent because tokscale has no reader for them (or
// its reader covers a different store) — the main process collects those
// itself (electron/minimax-code-usage.ts, electron/antigravity-usage.ts,
// electron/qoder-usage.ts, plus Cindy's Pi sessions via
// electron/cindy-usage.ts, which reads Cindy's own agent home instead of the
// `~/.pi` that tokscale's `pi` client scans) and merges the results, so asking
// the CLI for those ids would only add an empty payload. `codebuddy` is the
// hybrid: the CLI scans the CodeBuddy CLI transcripts (~/.codebuddy/projects)
// while the CN IDE's own store is read by electron/codebuddy-usage.ts. The two
// stores are disjoint by origin, so the IDE payload is merged unconditionally —
// a user running both the CLI and the IDE gets both halves. `trae` stays listed
// for the international build's cloud sync; the CN builds' encrypted local
// store is read by electron/trae-local-usage.ts and merged unconditionally as
// well. `dsh` is read by electron/dsh-usage.ts for a different reason: tokscale
// has a DSH reader but drops an entire transcript on one unparsable event
// (silently), so it is no longer asked for that client at all.
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
  'codebuddy',
  'workbuddy',
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
  'zcode',
  'micode',
  'pi',
]
const TOKSCALE_CACHE_MS = 5 * 60_000

/** One locally read agent whose payload the main process merges into the scan */
interface LocalAgentPayload {
  /** tokscale client id this payload accounts for */
  client: string
  payload: unknown
  /**
   * Merge even when tokscale already reports this client. Only for stores that
   * can never overlap tokscale's own source for the id — Trae: tokscale syncs
   * the international build's cloud account, we read the CN builds' local
   * encrypted store; both may exist side by side and are disjoint by origin.
   */
  mergeAlways?: boolean
  /**
   * Run after the payload was persisted. Antigravity's reader advances its
   * per-conversation marks this way: committing them first would drop the
   * usage of a scan whose merge never landed.
   */
  commit?: () => void
}

interface TokScanResult {
  /** Daily contributions from `tokscale graph` (per-day totals + client/model detail) */
  daily?: unknown
  error?: string
  /** Client ids whose per-client scan failed in the degraded fallback path */
  skippedClients?: string[]
  /** Per-client failure reason, keyed by client id (mirrors skippedClients) */
  skippedDetails?: Record<string, string>
  /** Which price table priced this scan and when it was fetched */
  pricing?: PricingMeta
  /** Epoch ms when the scan was requested — kept stable across cache hits so
   *  the renderer can show an honest as-of time instead of re-stamping "now" */
  scannedAt?: number
  /** Deferred bookkeeping of locally read agents, run once the merge landed */
  commits?: Array<() => void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let tokScanCache: { at: number; result: TokScanResult } | null = null
/** In-flight scan shared by overlapping requests (tick + manual click) */
let tokScanInflight: Promise<TokScanResult> | null = null

// Subscription probes cost upstream API calls (Gemini up to three round-trips),
// so successful outcomes are cached briefly to survive Plans-page revisits.
//
// A failure is cached too, for a shorter window. Some probes cost a PowerShell
// child plus a DPAPI unwrap (browser cookies) or a 4 MB log tail; re-running
// them on every refresh tick is what made the plans page stop scrolling. A
// failure still expires quickly, so a fresh login shows up on the next visit.
const QUOTA_CACHE_MS = 2 * 60_000
const QUOTA_FAIL_CACHE_MS = 45_000
/** Bounded fan-out: the cards all request at once, and each miss can spawn a child. */
const QUOTA_CONCURRENCY = 2
const quotaCache = new Map<string, { at: number; ttl: number; result: QuotaOutcome }>()
const quotaInflight = new Map<string, Promise<QuotaOutcome>>()
let quotaActive = 0
let quotaGeneration = 0
const quotaQueue: Array<() => void> = []

async function acquireQuotaSlot(): Promise<void> {
  if (quotaActive < QUOTA_CONCURRENCY) {
    quotaActive += 1
    return
  }
  await new Promise<void>((resolve) => quotaQueue.push(resolve))
  quotaActive += 1
}

function releaseQuotaSlot(): void {
  quotaActive -= 1
  quotaQueue.shift()?.()
}

async function cachedQuotaOutcome(
  key: string,
  probe: () => Promise<QuotaOutcome>,
): Promise<QuotaOutcome> {
  const now = Date.now()
  const hit = quotaCache.get(key)
  if (hit && now - hit.at < hit.ttl) return hit.result
  // Two cards asking for the same provider on one tick share one probe run.
  const running = quotaInflight.get(key)
  if (running) return running
  const generation = quotaGeneration
  const run = (async (): Promise<QuotaOutcome> => {
    await acquireQuotaSlot()
    try {
      const result = await probe()
      if (generation === quotaGeneration) {
        quotaCache.set(key, {
          at: Date.now(),
          ttl: result.available ? QUOTA_CACHE_MS : QUOTA_FAIL_CACHE_MS,
          result,
        })
        // Only a success is persisted: the cards paint the last good reading on
        // the next visit instead of waiting for this probe again.
        saveQuotaOutcome(key, result)
      }
      return result
    } finally {
      releaseQuotaSlot()
      quotaInflight.delete(key)
    }
  })()
  quotaInflight.set(key, run)
  return run
}

/**
 * The codex wham response reduced to what src/lib/codex-quota.ts parses: plan
 * id, credits, spend cap, the two rate-limit windows and the reset-credit
 * count. Everything else (account metadata) never reaches IPC or disk.
 */
function narrowCodexUsage(raw: unknown): Record<string, unknown> {
  const root = objOf(raw)
  if (!root) return {}
  const out: Record<string, unknown> = {}
  if (typeof root.plan_type === 'string') out.plan_type = root.plan_type
  const credits = objOf(root.credits)
  if (credits) out.credits = pickMembers(credits, ['unlimited', 'balance'])
  const spend = objOf(root.spend_control)
  if (spend) {
    const picked = pickMembers(spend, ['reached'])
    const limit = objOf(spend.individual_limit)
    if (limit) picked.individual_limit = pickMembers(limit, ['used_percent', 'percent', 'reached'])
    out.spend_control = picked
  }
  const rateLimit = objOf(root.rate_limit)
  if (rateLimit) {
    const picked: Record<string, unknown> = {}
    for (const key of ['primary_window', 'secondary_window']) {
      const window = objOf(rateLimit[key])
      if (window) {
        picked[key] = pickMembers(window, [
          'used_percent',
          'usedPercent',
          'limit_window_seconds',
          'limitWindowSeconds',
          'reset_at',
          'resetAt',
          'resets_at',
        ])
      }
    }
    out.rate_limit = picked
  }
  const resetCredits = objOf(root.rate_limit_reset_credits)
  if (resetCredits) out.rate_limit_reset_credits = pickMembers(resetCredits, ['available_count'])
  return out
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

/**
 * Distill tokscale stderr for the UI error line. Spinner frames pollute the
 * capture with ANSI escapes and CR overwrites (text after \r replaces the
 * line prefix), and when the process panics the "panicked at …" line is the
 * only part that identifies the failure — surface it first, then a bounded
 * slice of the cleaned log for context.
 */
function summarizeTokscaleStderr(err: string): string {
  const clean = err
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1))
    .join('\n')
  const panic = clean.split('\n').find((l) => l.includes('panicked at'))
  const body = panic ? `${panic.trim()} | ${clean.trim()}` : clean.trim()
  return body.slice(0, 1200)
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
      if (code !== 0) {
        // tokscale occasionally exits non-zero AFTER printing complete JSON
        // (e.g. a panic in its pricing refresh). Valid output beats no output:
        // accept it, otherwise fail with enough stderr to diagnose (the old
        // 160-char slice hid the real panic behind the first warning line).
        try {
          const parsed = JSON.parse(out)
          if (parsed && typeof parsed === 'object') return resolve(parsed)
        } catch {
          // fall through to the rejection
        }
        return reject(new Error(`tokscale exited ${code}: ${summarizeTokscaleStderr(err)}`))
      }
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

// ===== tokscale resilience helpers =====

/**
 * tokscale's pricing cache lives at `<config_dir>/cache/pricing-litellm.json`
 * (older layouts fall back to `~/.cache/tokscale/` and `<cache_dir>/tokscale/`;
 * the loader probes canonical first, then legacy). The file format is
 * `{ "timestamp": <secs>, "data": { <model-prices map> } }` with a 1h TTL.
 *
 * raw.githubusercontent.com is often unreachable from mainland China — the
 * "LiteLLM pricing failed (network error)" warning users see. tokscale merely
 * degrades (costs fall back to our own override), but the failing network probe
 * also delays every scan by retry timeouts. Pre-seeding the cache through the
 * same gh-proxy mirror used for update feeds removes the probe entirely.
 */
const PRICING_CACHE_FILENAME = 'pricing-litellm.json'
const PRICING_CACHE_TTL_SECS = 60 * 60
const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PRICING_MIRROR_URL = `https://gh-proxy.com/${PRICING_URL}`

/** Cache dir candidates in tokscale's loader order (canonical first) */
function pricingCacheCandidates(): string[] {
  const home = homedir()
  const dirs: string[] = []
  // TOKSCALE_CONFIG_DIR redirects the whole config root; the canonical cache
  // dir then sits under `<override>/cache` and legacy probing is disabled.
  const override = process.env.TOKSCALE_CONFIG_DIR
  if (override && override.trim()) {
    dirs.push(join(override.trim(), 'cache'))
    return dirs
  }
  // Canonical: <config_dir>/cache. Windows config root is %APPDATA%\tokscale;
  // macOS/Linux unify on ~/.config/tokscale (paths.rs keeps platform default
  // on Windows, unifies the rest).
  if (process.platform === 'win32') {
    const ap = process.env.APPDATA
    if (ap) dirs.push(join(ap, 'tokscale', 'cache'))
    const lap = process.env.LOCALAPPDATA
    if (lap) dirs.push(join(lap, 'tokscale'))
    dirs.push(join(home, '.cache', 'tokscale'))
  } else {
    dirs.push(join(home, '.config', 'tokscale', 'cache'), join(home, '.cache', 'tokscale'))
  }
  return dirs
}

async function readPricingCache(): Promise<{ timestamp: number; data: unknown } | null> {
  for (const dir of pricingCacheCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, PRICING_CACHE_FILENAME), 'utf8')) as {
        timestamp?: unknown
        data?: unknown
      }
      if (typeof parsed.timestamp === 'number' && parsed.data != null) return parsed as { timestamp: number; data: unknown }
    } catch {
      // miss or corrupt — try the next location
    }
  }
  return null
}

/** Best-effort fetch of the LiteLLM pricing catalog, direct then gh-proxy mirror */
async function fetchLiteLlmPricing(): Promise<unknown | null> {
  for (const url of [PRICING_URL, PRICING_MIRROR_URL]) {
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) continue
      const data: unknown = await res.json()
      if (data != null && typeof data === 'object') return data
    } catch {
      // try the next source
    }
  }
  return null
}

/**
 * Make tokscale's pricing probe a no-op before every full scan: rewrite the
 * cache when it's missing or stale, through the same mirror the update feed
 * uses. Never throws; a failed fetch leaves whatever cache exists in place.
 */
async function ensurePricingCache(): Promise<void> {
  try {
    const cached = await readPricingCache()
    const nowSecs = Math.floor(Date.now() / 1000)
    if (cached && nowSecs - cached.timestamp < PRICING_CACHE_TTL_SECS) return
    const data = await fetchLiteLlmPricing()
    if (data == null) return
    const content = JSON.stringify({ timestamp: nowSecs, data })
    const dir = pricingCacheCandidates()[0]
    // Atomic-ish write: direct write is fine here (tokscale tolerates a
    // corrupt cache by re-fetching), but temp+rename avoids half-written JSON.
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${PRICING_CACHE_FILENAME}.${process.pid}.tmp`)
    await writeFile(tmp, content, 'utf8')
    // rename() replaces atomically on POSIX; on Windows fs.rename overwrites
    // the destination too (libuv uses MoveFileEx REPLACE_EXISTING).
    await rename(tmp, join(dir, PRICING_CACHE_FILENAME))
  } catch {
    // best-effort: tokscale's own degrade path still applies
  }
}

/**
 * Full scan: one `graph` invocation returns per-day contributions for every
 * configured client (token/cost/message totals + client/model detail), which
 * the renderer aggregates into today / month / all-time / daily series.
 *
 * Resilience (tokscale is an upstream binary we cannot patch):
 * 1. The LiteLLM pricing probe is pre-seeded (gh-proxy mirror) so blocked
 *    raw.githubusercontent.com never delays or degrades the run.
 * 2. One silent retry covers transient failures (AV scans, spawn hiccups).
 * 3. If the combined scan still dies — the known exit-101 panic class on
 *    non-ASCII model/provider ids — retry per client and merge the healthy
 *    ones, so one bad session set never blanks the whole local-usage view.
 */
async function scanTokscaleUsage(): Promise<TokScanResult> {
  // WorkBuddy AI (international) keeps its transcripts in a home tokscale
  // never scans — mirror them into the scanned one (see workbuddy-aliases.ts).
  await ensureWorkbuddyAliases(
    join(homedir(), '.workbuddy'),
    join(homedir(), '.workbuddy-ai'),
    join(app.getPath('userData'), 'workbuddy-aliases.json'),
  )
  // Neutralize non-ASCII model/provider ids before tokscale reads them: its
  // kimi reader slices an alias at a raw byte index and panics on any
  // multi-byte character, dropping the whole client from the dashboard (see
  // model-id-sanitize.ts). Best-effort — a failed sweep must not stop the scan.
  await ensureScannableModelIds(
    [join(homedir(), '.kimi-code', 'sessions'), join(homedir(), '.kimi', 'sessions')],
    join(app.getPath('userData'), 'model-id-sanitize.json'),
  )
  // Several agents keep their usage where tokscale never looks (or looks at a
  // different store), so the main process reads them here and merges the
  // result: MiniMax Code (tokscale covers it through headless capture only),
  // Antigravity on an IDE install (tokscale reads the terminal agent's
  // databases), CodeBuddy CN IDE (tokscale reads the CLI's transcripts only),
  // Cindy (no tokscale reader at all — its Pi agent uses its own home,
  // `pi-agent-home`, instead of `~/.pi`), Qoder (no tokscale reader at all)
  // and Trae CN / SOLO CN (tokscale syncs the international build's cloud
  // account; the CN builds' encrypted local store is read by
  // trae-local-usage.ts and merged unconditionally — its data can never
  // overlap the cloud sync). Apart from Trae, each is skipped when tokscale
  // already reports that client, which it would once upstream
  // support lands — merging both would double count the same generations.
  const reads: Array<Promise<LocalAgentPayload | null>> = [
    // DSH is read natively (see dsh-usage.ts): tokscale's DSH reader drops a
    // whole transcript on one bad event, silently — on this machine that hid a
    // 1.26 B-token session, a third of the agent's usage. `dsh` is therefore no
    // longer in TOKSCALE_CLIENTS, which is why this payload is merged even when
    // a scan does report the client (a stale tokscale would double count).
    readDshUsage(homedir()).then((payload) =>
      payload == null ? null : { client: 'dsh', payload, mergeAlways: true },
    ),
    readMiniMaxCodeUsage(homedir()).then((payload) => (payload == null ? null : { client: 'mcode', payload })),
    // One read covers all three Antigravity flavours; the payload carries its
    // own `antigravity-ide` / `antigravity` / `antigravity-cli` client rows. The
    // `client` here is only the "does tokscale already report this?" key, and
    // none of the three ids is in TOKSCALE_CLIENTS, so the payload merges whole.
    readAntigravityUsage(homedir()).then((scan) =>
      scan.payload == null ? null : { client: 'antigravity', payload: scan.payload, commit: scan.commit },
    ),
    readCodeBuddyUsage(homedir()).then((payload) =>
      // Merged unconditionally: tokscale's CodeBuddy reader scans the CLI
      // transcripts under `~/.codebuddy/projects`, while this reader covers the
      // CN IDE's own store under `%LOCALAPPDATA%/CodeBuddyExtension` — two
      // disjoint origins, so a user running both the CLI and the IDE was losing
      // the IDE half entirely under the old "skip when tokscale reports it" rule.
      payload == null ? null : { client: 'codebuddy', payload, mergeAlways: true },
    ),
    // Cindy runs Pi on its own agent home (`%APPDATA%/Cindy/pi-agent-home` on
    // Windows, `%APPDATA%/CindyGlobal/pi-agent-home` for the international
    // build), which tokscale's `pi` client never scans (~/.pi only) — a
    // disjoint store by construction, hence merged unconditionally. The root is
    // the platform appData directory, not ours: `app.getPath('userData')` would
    // point at this app and find no sessions at all. `cindyBuilds` owns the rest
    // of the path and finds every installed build; the payload already names its
    // own client per build (`cindy` / `cindy-global`), so the `client` here is
    // only the id the skip rule would look for.
    readCindyUsage(app.getPath('appData')).then((payload) =>
      payload == null ? null : { client: 'cindy', payload, mergeAlways: true },
    ),
    // Qoder's two builds are two rows and two separate stores, so each is a
    // payload of its own: the skip-when-tokscale-covers-it rule then applies to
    // one build at a time (upstream would most likely add `qoder` for the CN
    // store only, and a shared payload would take the global row down with it).
    readQoderUsage(homedir(), { client: 'qoder' }).then((payload) =>
      payload == null ? null : { client: 'qoder', payload },
    ),
    readQoderUsage(homedir(), { client: 'qoder-global' }).then((payload) =>
      payload == null ? null : { client: 'qoder-global', payload },
    ),
    readTraeLocalUsage(homedir(), app.getPath('userData')).then((payload) =>
      payload == null ? null : { client: 'trae', payload, mergeAlways: true },
    ),
  ]
  const localAgents = (await Promise.all(reads)).filter(
    (entry): entry is LocalAgentPayload => entry !== null,
  )
  const withLocalAgents = (payload: unknown): unknown => {
    const missing = localAgents.filter((entry) => entry.mergeAlways || !hasClientEntries(payload, entry.client))
    return missing.length === 0 ? payload : mergeGraphPayloads([payload, ...missing.map((e) => e.payload)])
  }
  // Deferred bookkeeping (Antigravity's marks): run only once the merge landed.
  // None of its client ids is requested from tokscale, so its payload always
  // merges and committing it is always the right end state.
  const localCommits = (): Array<() => void> =>
    localAgents.flatMap((entry) => (entry.commit ? [entry.commit] : []))
  await ensurePricingCache()
  // --no-spinner: the interactive progress renderer is both the source of
  // ANSI/CR garbage in captured stderr and the prime suspect for the
  // intermittent exit-101 panics on CJK provider ids (unicode-width string
  // slicing). JSON output is unaffected.
  const baseArgs = ['graph', '--client', TOKSCALE_CLIENTS.join(','), '--since', '2020-01-01', '--no-spinner']
  // Trae usage lives behind an account sync (tokscale trae sync), not local
  // session files. Best-effort: silently skipped when unauthenticated, and a
  // no-op for variants whose API returns nothing.
  await runTokscale(['trae', 'sync', '--since', '30']).catch(() => {})
  let daily: unknown
  try {
    daily = await runTokscale(baseArgs)
  } catch {
    try {
      daily = await runTokscale(baseArgs)
    } catch {
      daily = null
    }
  }
  if (daily != null) {
    const costs = await overrideCosts(withLocalAgents(daily))
    // Decode last: the cost override and the provider attribution read the
    // encoded ids, whose router prefix is ASCII either way.
    return {
      daily: decodeNonAsciiIds(reconcileProviderAttribution(costs)),
      pricing: getPricingMeta(),
      commits: localCommits(),
    }
  }

  const merged = await scanPerClientWithFallback(baseArgs)
  // Throw (not return `{error}`): the IPC handler surfaces failures without
  // caching them, so a manual refresh always re-attempts the scan instead of
  // replaying a stale error for the cache window.
  if (merged == null) {
    // Every tokscale client failed; the locally read agents still beat a blank
    // card, so serve those rather than surfacing nothing at all.
    if (localAgents.length > 0) {
      const costs = await overrideCosts(mergeGraphPayloads(localAgents.map((entry) => entry.payload)))
      return {
        daily: decodeNonAsciiIds(reconcileProviderAttribution(costs)),
        pricing: getPricingMeta(),
        commits: localCommits(),
      }
    }
    throw new Error('tokscale scan failed for every client')
  }
  const costs = await overrideCosts(withLocalAgents(merged.daily))
  return {
    daily: decodeNonAsciiIds(reconcileProviderAttribution(costs)),
    pricing: getPricingMeta(),
    skippedClients: merged.skippedClients,
    skippedDetails: merged.skippedDetails,
  }
}

/**
 * Run `graph --client <one>` per configured client, collecting the payloads
 * that export cleanly. Clients whose scan panics (exit 101) are skipped and
 * reported by id — the merged payload covers every healthy client. Returns
 * null only when no client exported anything.
 *
 * Each client gets one retry after a short pause: the common transient cause
 * is a torn read of a session file being appended by a running agent (e.g.
 * Kimi Code writing wire.jsonl while the 30s auto-refresh scans), which heals
 * on the next attempt. The failure reason is kept alongside the id — the old
 * bare-id list forced the UI into a static (and often wrong) guess.
 */
async function scanPerClientWithFallback(
  baseArgs: string[],
): Promise<{ daily: unknown; skippedClients: string[]; skippedDetails: Record<string, string> } | null> {
  const payloads: unknown[] = []
  const skippedClients: string[] = []
  const skippedDetails: Record<string, string> = {}
  for (const client of TOKSCALE_CLIENTS) {
    // Per-client runs are much lighter than the combined one: each exports
    // only its own session dirs, so a bad file panics alone and never touches
    // the other clients' data.
    // baseArgs = ['graph', '--client', <combined list>, '--since', <date>];
    // drop the first three entries (incl. the combined client list) so the
    // single-client form stays a valid invocation.
    const args = ['graph', '--client', client, ...baseArgs.slice(3)]
    try {
      payloads.push(await runTokscale(args))
    } catch (e) {
      // Transient write race — wait out the appending writer, then retry once
      await sleep(2000)
      try {
        payloads.push(await runTokscale(args))
      } catch (retryErr) {
        skippedClients.push(client)
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        skippedDetails[client] = msg.slice(0, 300)
      }
    }
  }
  if (payloads.length === 0) return null
  return { daily: mergeGraphPayloads(payloads), skippedClients, skippedDetails }
}

/**
 * Replace tokscale's per-entry cost with our own price table wherever the model
 * is known, then fold the delta back into the day total so the renderer's
 * "other" derivation (totals minus clients) stays balanced. Unknown models keep
 * tokscale's cost untouched. Repriced entries are marked `priced: true` so the
 * renderer can tell "catalog-priced at 0" apart from "no catalog price" when
 * labeling unpriced models.
 */
async function overrideCosts(daily: unknown): Promise<unknown> {
  try {
    const table = await getPricingTable()
    const root = daily as {
      contributions?: Array<{
        totals?: { cost?: number }
        clients?: Array<{
          cost?: number
          modelId?: unknown
          messages?: number
          tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
          /** Set when this entry was repriced from the shared price table */
          priced?: boolean
        }>
      }>
    }
    if (!Array.isArray(root?.contributions)) return daily
    for (const c of root.contributions) {
      if (!Array.isArray(c.clients)) continue
      let dayDelta = 0
      for (const e of c.clients) {
        if (typeof e.modelId !== 'string' || e.tokens == null) continue
        const computed = priceTokens(
          table,
          e.modelId,
          e.tokens,
          typeof e.messages === 'number' ? e.messages : undefined,
        )
        // A re-scan may see a model the new table no longer prices: clear the
        // old flag rather than presenting a stale catalogue match as current.
        e.priced = computed != null
        if (computed == null) continue
        dayDelta += computed - (typeof e.cost === 'number' ? e.cost : 0)
        e.cost = Math.round(computed * 1e6) / 1e6
        // Mark catalog-priced entries so the renderer can tell "priced at 0"
        // (e.g. free-tier models) apart from "no catalog price" downstream.
      }
      if (dayDelta !== 0 && typeof c.totals?.cost === 'number') {
        c.totals.cost = Math.round((c.totals.cost + dayDelta) * 1e6) / 1e6
      }
    }
  } catch {
    // Pricing is cosmetic: a failure here must never break the scan
  }
  return daily
}

function registerIpc(): void {
  // Route renderer HTTP through the main process: net.fetch is not subject to
  // CORS, so provider APIs are called directly with no third-party proxy.
  // Trust premise: the renderer is our own bundle (contextIsolation on, no
  // remote content), so url/headers are checked for shape and scheme only, not
  // against a per-provider allowlist. The checks below harden against accident
  // and a non-HTTP target, not against a fully compromised renderer — a
  // renderer that can run arbitrary code is outside this handler's threat model.
  ipcMain.handle(
    'net:fetch',
    async (_event, url: unknown, headers: unknown, init: unknown): Promise<DesktopFetchResult> => {
      if (typeof url !== 'string' || url === '') return { status: 0, body: 'invalid url' }
      // Only http/https: this handler is the renderer's one outbound path, so
      // file://, ftp:// or custom schemes must not be reachable through it.
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { status: 0, body: 'invalid url' }
        }
      } catch {
        return { status: 0, body: 'invalid url' }
      }
      // Keep the trust boundary explicit even though the renderer is our own bundle
      const cleanHeaders: Record<string, string> = {}
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
          if (typeof v === 'string') cleanHeaders[k] = v
        }
      }
      // Optional POST override for GraphQL-style adapters (see ParseContext.fetch).
      // Shape-checked like everything else over this boundary: anything but an
      // explicit POST with a string body degrades to the default GET, so the
      // trust premise is unchanged — the renderer was already trusted to name
      // the URL and the headers, and a JSON body carries nothing new.
      let method = 'GET'
      let body: string | undefined
      if (init && typeof init === 'object') {
        const requested = init as { method?: unknown; body?: unknown }
        if (requested.method === 'POST') {
          method = 'POST'
          if (typeof requested.body === 'string') body = requested.body
        }
      }
      try {
        // Bounded: a hung provider connection must not keep refreshAll's
        // Promise.all (and the manual-refresh spinner) pending forever
        const res = await net.fetch(url, {
          method,
          body,
          headers: cleanHeaders,
          signal: AbortSignal.timeout(30_000),
          // Redirects are refused: every bridge consumer is a direct JSON API
          // endpoint (src/providers/* adapters, the FX rate feed in
          // data-context.tsx), and following a 3xx would replay the renderer's
          // Authorization/Cookie headers to a host the URL never named.
          redirect: 'error',
        })
        return { status: res.status, body: await res.text() }
      } catch (error) {
        return { status: 0, body: String(error) }
      }
    },
  )

  // Alert-push webhook send. The renderer supplies only the channel id, its
  // credential pieces and the message text; the payload shape, the per-platform
  // success semantics and iLink's session recovery live in webhook-send.ts.
  ipcMain.handle(
    'webhook:send',
    async (_event, channel: unknown, cred: unknown, title: unknown, text: unknown) => {
      // The background cycle window may be closed as soon as it reports its
      // refresh is done; a send already in flight must finish (and record its
      // cooldown) before that window goes away.
      pendingWebhookSends++
      try {
        return await sendWebhook(channel, cred, title, text)
      } finally {
        pendingWebhookSends--
      }
    },
  )

  // The hidden cycle window finished a background refresh: close it.
  ipcMain.handle('background:done', (event): void => {
    background?.done(event.sender)
  })

  // WeChat iLink bot login/activation flow (desktop-only interactive setup).
  // Only the QR image, status and the resulting token/user id cross the
  // boundary; the QR image is re-encoded as a data: URL so the renderer CSP
  // never opens a third-party img-src origin.
  ipcMain.handle('ilink:begin', async (): Promise<IlinkBeginResult> => {
    try {
      const session = await ilinkBeginLogin(net.fetch)
      return { dataUrl: session.dataUrl, qrCode: session.qrCode, expiresAt: session.expiresAt }
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e) }
    }
  })

  ipcMain.handle('ilink:poll', async (_event, qrCode: unknown): Promise<IlinkPollResult> => {
    if (typeof qrCode !== 'string' || !qrCode) return { status: 'error', message: 'invalid-request' }
    try {
      return await ilinkPollLogin(net.fetch, qrCode)
    } catch (e) {
      return { status: 'error', message: String(e instanceof Error ? e.message : e) }
    }
  })

  ipcMain.handle('ilink:activate', async (_event, token: unknown): Promise<IlinkActivateResult> => {
    if (typeof token !== 'string' || !token) return { error: 'invalid-request' }
    try {
      return await ilinkPollActivation(net.fetch, token)
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e) }
    }
  })

  // Keep-alive: the renderer hands over the decrypted bot token once the
  // weixin channel is configured (hydration done). Main then owns the
  // getupdates long-poll so sendmessage has a prepared session even though
  // this app is not a 24/7 daemon — the loop only lives for the current run.
  ipcMain.handle('ilink:session-start', async (_event, token: unknown): Promise<void> => {
    if (typeof token !== 'string' || !token) return
    await startIlinkSession(token)
  })
  ipcMain.handle('ilink:session-stop', async (): Promise<void> => {
    await stopIlinkSession()
  })

  // System-level dynamic island: the main renderer relays fresh alert
  // batches; the overlay surface (its own tiny window) hides itself and
  // asks us to focus the main window when its body is clicked.
  ipcMain.handle('island:show', (_event, alerts: unknown): void => {
    if (Array.isArray(alerts)) islandShow(alerts)
  })
  ipcMain.handle('island:hide', (): void => islandHide())
  // The overlay says its listener is live; batches held back during load are
  // delivered then (see island-window.ts: the window may be created fresh on
  // any alert once the idle one has been released)
  ipcMain.handle('island:ready', (): void => islandRendererReady())
  ipcMain.handle('island:clickthrough', (_event, clickThrough: unknown): void => {
    islandSetClickThrough(clickThrough === true)
  })
  ipcMain.handle('island:open-main', (): void => {
    openAlertsCenter()
  })

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
    // Fire-and-forget mirror; the catch reports async rejections the outer
    // (synchronous) handler could never see. The background cycle reads that
    // mirror for the interval, so a settings change also re-arms it.
    void writeSettingsMirror(app.getPath('userData'), payload)
      .then(() => void background?.reschedule())
      .catch((error: unknown) => {
        console.error(
          `[settings] could not write the backup mirror: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  })

  ipcMain.handle('settings:backup-read', async (): Promise<string | null> =>
    readSettingsMirror(app.getPath('userData')),
  )

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
    closeToTray()
  })

  ipcMain.handle('app:quit', (): void => {
    isQuitting = true
    app.quit()
  })

  // Renderer pushes its locale / theme so the tray menu speaks the same
  // language and follows the same dark-light mode. 'system' passes through
  // untouched, so the renderer's matchMedia-based system detection keeps
  // reading the real OS preference instead of an overridden one.
  ipcMain.handle('prefs:tray-sync', (_event, patch: unknown): void => {
    trayPrefs = mergeTrayPrefs(trayPrefs, patch)
    nativeTheme.themeSource = trayPrefs.theme
    rebuildTrayMenu()
  })

  // Open an external URL in the system browser. The URL must be https —
  // the only in-app caller passes a constant repo link, but the main-side
  // check keeps the channel from ever becoming an open-URL gadget.
  ipcMain.handle('shell:open-external', async (_event, url: unknown): Promise<boolean> => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return false
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
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

  // Manual check from the settings page: resolves with the current snapshot,
  // then pushes status changes over desktop:update-status
  ipcMain.handle('app:check-updates', (): typeof updateState => {
    void checkForUpdates()
    return updateState
  })

  /** Read-only snapshot for late subscribers (top bar badge, update toast) */
  ipcMain.handle('app:update-state', (): typeof updateState => updateState)

  // Last known-good quota per provider, so a subscription card can paint the
  // previous reading immediately and then refresh behind the user's back.
  ipcMain.handle('quota:snapshot', (): ReturnType<typeof readQuotaSnapshot> => readQuotaSnapshot())

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
          // The banked-reset companion read rides along in parallel (same
          // headers, same 10s bound): it only ever adds the expiry date /
          // fallback count to the narrowed body, so its failure costs the
          // extra field and never the windows (see codex-reset-credits.ts).
          const [res, resetCredits] = await Promise.all([
            net.fetch('https://chatgpt.com/backend-api/wham/usage', {
              headers,
              redirect: 'error',
              signal: AbortSignal.timeout(10_000),
            }),
            fetchCodexResetCredits(net.fetch, headers),
          ])
          if (!res.ok) return { available: false, reason: `http-${res.status}` }
          // Narrowed before returning: quota-cache.json persists this body
          // verbatim (see narrowCodexUsage). An unparsable response maps to the
          // same state the card's parser would reach on the raw text.
          let parsed: unknown
          try {
            parsed = JSON.parse(await res.text())
          } catch {
            return { available: false, reason: 'bad-response' }
          }
          return { available: true, body: JSON.stringify(mergeCodexResetCredits(narrowCodexUsage(parsed), resetCredits)) }
        } catch (e) {
          // Distinguish "never logged in" from "the request failed" — the
          // card copy differs (no-auth-file reads as an honest empty state)
          return { available: false, reason: isTimeoutError(e) ? 'timeout' : 'network' }
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

  // Grok Build (SuperGrok) subscription quota via the local `grok login`
  // state (~/.grok/auth.json); the CLI refreshes its own token, we never do.
  ipcMain.handle(
    'grok:usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('grok', () => fetchGrokUsage(net.fetch, homedir())),
  )

  // Qoder global build: the credits pool the IDE shows in its own account
  // panel. The probe decrypts the IDE's stored login on Windows (see
  // qoder-quota.ts) and returns numbers only — the token never crosses this
  // boundary. It caches internally, so it does not use the shared in-memory
  // quota cache; the numeric outcome is still persisted through the shared
  // store so a cold start can paint the last reading before the probe (a
  // PowerShell DPAPI unwrap) answers.
  ipcMain.handle(
    'qoder:quota',
    async (): Promise<QoderQuotaOutcome> => {
      const outcome = await readQoderQuota(net.fetch, app.getPath('appData'))
      const body = qoderStoreBody(outcome)
      if (body != null) saveQuotaOutcome('qoder', { available: true, body })
      return outcome
    },
  )

  // Cursor and GitHub Copilot plan quota, both read from the client's own
  // on-disk login (see local-plan-quota.ts). Cursor's token may be sealed by
  // its own safeStorage key, in which case the probe reports `sealed-token`
  // rather than guessing; a pasted token on the providers page still works.
  ipcMain.handle(
    'cursor:usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('cursor', () => fetchCursorUsage(net.fetch, homedir(), process.env)),
  )
  ipcMain.handle(
    'copilot:usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('copilot', () => fetchCopilotUsage(net.fetch, homedir(), process.env)),
  )
  // Cline Pass: read the CLI's own providers.json and query the plan endpoint.
  // The bearer token never leaves this process and is never logged.
  ipcMain.handle(
    'cline:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('cline', () => fetchClineQuota(net.fetch, homedir(), process.env)),
  )
  // JetBrains AI and Windsurf read local files only. Windsurf's cache can be
  // stale; the card says so. Neither probe copies the IDE database.
  ipcMain.handle(
    'jetbrains:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('jetbrains', () => fetchJetBrainsQuota(homedir(), process.env)),
  )
  ipcMain.handle(
    'windsurf:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('windsurf', () => fetchWindsurfQuota(homedir(), process.env)),
  )
  // Kiro and Kilo reuse the CLI's own login. Kiro never starts a chat session.
  ipcMain.handle(
    'kiro:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('kiro', () => fetchKiroQuota(net.fetch, homedir(), process.env)),
  )
  ipcMain.handle(
    'kilo:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('kilo', () => fetchKiloQuota(net.fetch, homedir(), process.env)),
  )
  // Factory (Droid) subscription quota via the user's own Factory API key
  // (FACTORY_API_KEY or ~/.factory/.env). The droid CLI's keyring login is not
  // readable on Windows without a native module, so the API key is the
  // supported credential; the token never leaves this process.
  ipcMain.handle(
    'factory:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('factory', () => fetchFactoryQuota(net.fetch, homedir(), process.env)),
  )
  // Devin subscription quota via the Devin CLI's own credentials.toml, posted
  // as the Connect-RPC metadata apiKey. The key is read in memory and never
  // returned — only the daily/weekly window numbers cross IPC.
  ipcMain.handle(
    'devin:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('devin', () => fetchDevinQuota(net.fetch, homedir(), process.env)),
  )
  // Amp balance via the official CLI's own `amp usage` sheet: Amp Free daily
  // meter, subscription pools, individual and workspace credits. The CLI
  // resolves its own login; the probe spawns it and parses the printed sheet,
  // so a missing CLI is the honest no-auth state and a sheet no meter can be
  // read from fails closed (see amp-quota.ts).
  ipcMain.handle(
    'amp:usage',
    async (): Promise<QuotaOutcome> => cachedQuotaOutcome('amp', () => fetchAmpUsage()),
  )
  // Alibaba Cloud consoles reuse an in-app console session: Chrome's v20
  // cookies cannot be read on Windows, but Electron's own jar can.
  const clearAlibabaQuotaCache = (): void => {
    // A probe that was already running would write its stale failure back a
    // moment after sign-in, leaving the card on "not signed in" for the whole
    // failure TTL. Bump the generation so that run is not stored.
    quotaGeneration += 1
    for (const key of ['alibaba', 'qwen', 'alitoken']) {
      quotaCache.delete(key)
      quotaInflight.delete(key)
    }
  }
  ipcMain.handle(
    'alibaba:connect',
    async (
      _event,
      target?: unknown,
    ): Promise<{ ok: boolean; reason?: string; detail?: string }> => {
      const console = target === 'qwen' || target === 'token' ? target : 'coding'
      const result = await connectAlibabaConsole(mainWindow, console)
      if (result.ok) clearAlibabaQuotaCache()
      return result
    },
  )
  ipcMain.handle(
    'alibaba:disconnect',
    async (): Promise<void> => {
      await clearConsoleSession()
      clearAlibabaQuotaCache()
    },
  )
  ipcMain.handle('alibaba:session', async (): Promise<boolean> => hasConsoleSession())
  // A pasted console request wins over any reconstructed one: it is the only
  // variant the gateway accepts. See pasted-requests.ts.
  const probe = (target: PastedTarget, build: () => Promise<QuotaOutcome>): Promise<QuotaOutcome> =>
    cachedQuotaOutcome(target, async () => {
      const pasted = await readPastedRequest(target)
      return pasted ? fetchPastedQuota(net.fetch, pasted) : build()
    })
  ipcMain.handle(
    'alibaba:quota',
    async (): Promise<QuotaOutcome> =>
      probe('alibaba', () => fetchAlibabaCodingPlanQuota(net.fetch, { cookieSource: readConsoleCookieHeader })),
  )
  ipcMain.handle(
    'qwen:quota',
    async (): Promise<QuotaOutcome> =>
      probe('qwen', () => fetchQwenCloudQuota(net.fetch, { cookieSource: readConsoleCookieHeader })),
  )
  ipcMain.handle(
    'alitoken:quota',
    async (): Promise<QuotaOutcome> =>
      probe('alitoken', () => fetchAlibabaTokenPlanQuota(net.fetch, { cookieSource: readConsoleCookieHeader })),
  )
  ipcMain.handle(
    'pasted:set',
    async (
      _event,
      target: unknown,
      text: unknown,
    ): Promise<{ ok: boolean; reason?: string }> => {
      if (target !== 'alibaba' && target !== 'alitoken' && target !== 'qwen') {
        return { ok: false, reason: 'unknown-target' }
      }
      if (typeof text !== 'string' || text.length > 40_000) return { ok: false, reason: 'too-large' }
      const parsed = parseCurl(text)
      if (!parsed.ok) return { ok: false, reason: parsed.reason }
      // A pasted request must belong to the card it was pasted into, or the two
      // would send each other's bodies to each other's console.
      if (parsed.target !== target) return { ok: false, reason: 'wrong-console' }
      const saved = await savePastedRequest(target, parsed.request)
      if (!saved.ok) return { ok: false, reason: saved.reason }
      quotaCache.delete(target)
      quotaInflight.delete(target)
      quotaGeneration += 1
      return { ok: true }
    },
  )
  ipcMain.handle(
    'pasted:clear',
    async (_event, target: unknown): Promise<void> => {
      if (target !== 'alibaba' && target !== 'alitoken' && target !== 'qwen') return
      await clearPastedRequest(target)
      quotaCache.delete(target)
      quotaInflight.delete(target)
      quotaGeneration += 1
    },
  )

  // OpenDesign Go subscription quota. Primary credential: the control key from
  // the official device-code flow (the card drives start/poll, the key itself
  // is stored encrypted here and never crosses IPC); manual fallback: a pasted
  // Cloud console Cookie. The inference API key cannot read quota — see
  // opendesign-quota.ts for the endpoint contract.
  ipcMain.handle(
    'opendesign:quota',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('opendesign', async () => fetchOpendesignQuota(net.fetch, await readOpendesignCredential())),
  )
  ipcMain.handle('opendesign:login-start', async (): Promise<OpendesignLoginStartIpcResult> => {
    const started = await startOpendesignLogin(net.fetch, 'coding-usage')
    if (!started.ok) return started
    // Open the locally assembled approval page; the URL prefix is validated by
    // the probe module before it gets here. The URL itself stays behind this
    // boundary — the renderer only needs the approval code and cadence.
    void shell.openExternal(started.session.url).catch(() => {})
    const { loginId, userCode, intervalMs, expiresAtMs } = started.session
    return { ok: true, loginId, userCode, intervalMs, expiresAtMs }
  })
  ipcMain.handle('opendesign:login-poll', async (_event, loginId: unknown): Promise<OpendesignPollResult> => {
    if (typeof loginId !== 'number' || !Number.isSafeInteger(loginId)) return { status: 'failed', reason: 'expired' }
    const result = await pollOpendesignLogin(net.fetch, loginId)
    if (result.status === 'approved') {
      // The saved control key must be used immediately: drop any cached or
      // in-flight answer that still reflects the pre-login state.
      quotaCache.delete('opendesign')
      quotaInflight.delete('opendesign')
      quotaGeneration += 1
    }
    return result
  })
  ipcMain.handle('opendesign:login-cancel', async (_event, loginId: unknown): Promise<void> => {
    if (typeof loginId !== 'number' || !Number.isSafeInteger(loginId)) return
    dropOpendesignLogin(loginId)
  })
  ipcMain.handle(
    'opendesign:set-cookie',
    async (_event, text: unknown): Promise<{ ok: boolean; reason?: string }> => {
      if (typeof text !== 'string' || text.length > 40_000) return { ok: false, reason: 'too-large' }
      const saved = await saveOpendesignCredential(text)
      if (!saved.ok) return { ok: false, reason: saved.reason }
      quotaCache.delete('opendesign')
      quotaInflight.delete('opendesign')
      quotaGeneration += 1
      return { ok: true }
    },
  )
  ipcMain.handle('opendesign:clear-credential', async (): Promise<void> => {
    await clearOpendesignCredential()
    quotaCache.delete('opendesign')
    quotaInflight.delete('opendesign')
    quotaGeneration += 1
  })

  // Trae CN credits usage. The login state is an encrypted "tc" blob in the
  // IDE's storage.json (decrypted in-memory, see trae-usage.ts); the JWT never
  // leaves the main process and is never logged. An expired token maps to the
  // card's "reopen Trae" hint — the IDE refreshes it on launch, we never do.
  ipcMain.handle(
    'trae:usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('trae', () => fetchTraeUsage(net.fetch, homedir())),
  )

  // Trae international (SG/US deployment) entitlement usage. The international
  // IDE keeps the same storage key — plaintext JSON or the same "tc" blob — in
  // its own app-data dirs; the token is decrypted in-memory (see trae-usage.ts)
  // and never crosses IPC. An explicit US region hint in the storage routes to
  // the us-east host; everything else stays on SG.
  ipcMain.handle(
    'trae:intl-usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('trae-intl', () => fetchTraeIntlUsage(net.fetch, homedir())),
  )

  // Kimi Code subscription quota. Two distinct billing surfaces exist and the
  // probe keeps them apart: a Moonshot platform API key only ever yields a
  // money balance, while the 5-hour / weekly quota windows live behind the
  // Kimi Code subscription (local loopback server, or the remote usages
  // endpoint). The login is the CLI's own — the probe resolves it locally, so
  // this channel has exactly one identity per install and no credential ever
  // crosses IPC.
  ipcMain.handle('kimi:usage', async (): Promise<QuotaOutcome> =>
    cachedQuotaOutcome('kimi', () => fetchKimiUsage(net.fetch, homedir())),
  )

  // Antigravity subscription quota, one card per client (IDE / app / CLI).
  // The probe reads each client's own login — the IDE's store, or the keyring
  // entry the app and the CLI share — and asks the Cloud Code API with it, so
  // no client needs to be running (only the IDE's loopback fallback does; see
  // antigravity-quota.ts). The flavour is validated before it selects a
  // probe, and the cache key is the card's, which is also its snapshot slot.
  ipcMain.handle('antigravity:usage', (_event, flavour: unknown): Promise<QuotaOutcome> => {
    const which = isAntigravityFlavour(flavour) ? flavour : 'ide'
    return cachedQuotaOutcome(ANTIGRAVITY_FLAVOURS[which].key, () => fetchAntigravityUsage(which))
  })

  /**
   * Fold a finished scan into the persistent history and return the merged set.
   *
   * The store, not the disk, is what the renderer aggregates: a day the scan no
   * longer reports — its transcript was deleted or rotated away — is served from
   * history, so today / month / all-time survive the source disappearing. An
   * empty scan therefore still returns stored history instead of nothing.
   *
   * History is repriced with the current table before it is returned: a stored
   * row keeps the cost from the scan that wrote it, and a later price-source
   * switch would otherwise mix old OpenRouter and new models.dev numbers in one
   * total.
   */
  async function persistScanHistory(daily: unknown): Promise<unknown> {
    const merged = mergeScanIntoStore(extractContributions(daily))
    if (merged.length === 0) return daily
    const repriced = (await overrideCosts({ contributions: merged })) as {
      contributions?: unknown
    }
    // Recompute summary/years so the payload cannot contradict the rows it now
    // carries. The renderer only reads `contributions`, but a stale summary is
    // a trap for the next reader.
    return mergeGraphPayloads([
      { contributions: Array.isArray(repriced.contributions) ? repriced.contributions : merged },
    ])
  }

  /** Upper bound on a purge range: ~100 years, far past any real history */
  const MAX_PURGE_DAYS = 36500

  /** Local calendar day key (YYYY-MM-DD) for `daysBack` days before today */
  function usageCutoffDay(daysBack: number): string {
    const boundary = new Date()
    boundary.setDate(boundary.getDate() - daysBack)
    const month = `${boundary.getMonth() + 1}`.padStart(2, '0')
    const day = `${boundary.getDate()}`.padStart(2, '0')
    return `${boundary.getFullYear()}-${month}-${day}`
  }

  // Local agent usage scan. Cached in the main process: a full three-period
  // scan takes tens of seconds, so repeated renderer refreshes are cheap. Each
  // result carries the epoch ms of its scan request (`scannedAt`) — cache hits
  // return the original stamp, so the renderer's as-of time stays honest — and
  // overlapping calls share one in-flight round-trip instead of spawning the
  // binary twice. Every result is folded into the history store first (see
  // usage-store.ts), so a deleted session file cannot erase its usage.
  ipcMain.handle('tokscale:scan', async (): Promise<TokScanResult> => {
    const now = Date.now()
    if (tokScanCache && now - tokScanCache.at < TOKSCALE_CACHE_MS) return tokScanCache.result
    if (tokScanInflight) return tokScanInflight
    const pending = (async (): Promise<TokScanResult> => {
      try {
        const result = await scanTokscaleUsage()
        // Stamp the request time, not the completion time: the data is read
        // during the scan, and the label must never claim fresher than we
        // asked. Same anchor as the cache window (`at`) above.
        const { commits = [], ...rest } = result
        const daily = await persistScanHistory(result.daily)
        // Only now that the payload is in the store may the readers advance
        // their marks; a failure above leaves them where they were.
        for (const commit of commits) commit()
        const stamped: TokScanResult = { ...rest, daily, scannedAt: now }
        tokScanCache = { at: now, result: stamped }
        return stamped
      } catch (e) {
        // A failed scan must not blank the dashboard: the store may already hold
        // real history. Serve it, stamped with the last successful write so the
        // as-of label cannot claim the data is fresh.
        const stored = readStoredContributions()
        if (stored.length > 0) {
          const repriced = (await overrideCosts({ contributions: stored })) as { contributions?: unknown }
          return {
            daily: mergeGraphPayloads([
              { contributions: Array.isArray(repriced.contributions) ? repriced.contributions : stored },
            ]),
            pricing: getPricingMeta(),
            scannedAt: getUsageStoreUpdatedAt() ?? now,
          }
        }
        return { error: String(e instanceof Error ? e.message : e) }
      } finally {
        tokScanInflight = null
      }
    })()
    tokScanInflight = pending
    return pending
  })

  // Stored usage history: how far back it reaches (settings page) and how to
  // trim it. `null` wipes everything; a whole number of days keeps the last N.
  // This is the one destructive path into the app's own storage, so the
  // argument is bounded rather than coerced: a fractional value would truncate
  // to 0 (deleting everything before today) and a huge one would push the cutoff
  // past the representable date range, where the string comparison in the DELETE
  // would match every row.
  ipcMain.handle('usage:stats', async (): Promise<UsageStoreStats> => getUsageStoreStats())

  ipcMain.handle('usage:purge', async (_event, beforeDays: unknown): Promise<UsagePurgeResult> => {
    if (beforeDays === null) {
      // The cached scan result still carries the deleted days; dropping it makes
      // the renderer's follow-up refresh re-merge from what actually remains.
      tokScanCache = null
      return purgeUsageBefore(null)
    }
    if (
      typeof beforeDays !== 'number' ||
      !Number.isInteger(beforeDays) ||
      beforeDays < 1 ||
      beforeDays > MAX_PURGE_DAYS
    ) {
      return { removed: 0, stats: getUsageStoreStats() }
    }
    tokScanCache = null
    return purgeUsageBefore(usageCutoffDay(beforeDays))
  })

  // ===== Agent configuration (kimicode / mcode) =====
  //
  // Every handler is a thin wrapper. Parsing, credential masking and the
  // compare-and-swap live in agent-config-service.ts, which returns masked
  // previews only — the plaintext of a credential leaves the main process sole
  // through `agentConfig:reveal`, and only for the one provider the user asked
  // to see.
  ipcMain.handle('agentConfig:read', async (_event, agent: unknown): Promise<AgentConfigPayload> => {
    return readAgentConfig(toAgentId(agent))
  })

  ipcMain.handle(
    'agentConfig:reveal',
    async (_event, agent: unknown, providerId: unknown): Promise<AgentKeyReveal> => {
      if (typeof providerId !== 'string' || providerId.length === 0) {
        return { ok: false, message: 'invalid-provider' }
      }
      return revealAgentKey(toAgentId(agent), providerId)
    },
  )

  ipcMain.handle(
    'agentConfig:save',
    async (_event, agent: unknown, revision: unknown, input: unknown): Promise<AgentWriteResult> => {
      const parsed = parseProviderInput(input)
      if (!parsed) return { ok: false, reason: 'invalid', message: 'invalid provider payload' }
      return saveAgentProvider(toAgentId(agent), typeof revision === 'string' ? revision : '', parsed)
    },
  )

  ipcMain.handle(
    'agentConfig:remove',
    async (_event, agent: unknown, revision: unknown, providerId: unknown): Promise<AgentWriteResult> => {
      if (typeof providerId !== 'string' || providerId.length === 0) {
        return { ok: false, reason: 'invalid', message: 'invalid provider id' }
      }
      return removeAgentProvider(toAgentId(agent), typeof revision === 'string' ? revision : '', providerId)
    },
  )

  // Ask a configured provider which models it serves. The request runs here, so
  // there is no CORS preflight and the credential never leaves this machine.
  ipcMain.handle(
    'agentConfig:listModels',
    async (
      _event,
      agent: unknown,
      providerId: unknown,
      override: unknown,
    ): Promise<AgentModelListResult> => {
      if (typeof providerId !== 'string') return { ok: false, message: 'invalid provider id' }
      const patch: { baseUrl?: string; apiKey?: string; protocol?: string } = {}
      if (typeof override === 'object' && override !== null) {
        const raw = override as Record<string, unknown>
        if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) patch.baseUrl = raw.baseUrl.trim()
        if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) patch.apiKey = raw.apiKey.trim()
        if (typeof raw.protocol === 'string' && raw.protocol.trim()) patch.protocol = raw.protocol.trim()
      }
      return listAgentProviderModels(toAgentId(agent), providerId, patch)
    },
  )

  // One minimal live request through a configured model. Deliberately a
  // separate channel from the read path: it costs tokens, so it only ever runs
  // when the user clicks test.
  ipcMain.handle(
    'agentConfig:testModel',
    async (
      _event,
      agent: unknown,
      providerId: unknown,
      modelId: unknown,
    ): Promise<AgentModelTestResult> => {
      if (typeof providerId !== 'string' || providerId.length === 0) {
        return { ok: false, message: 'invalid provider id' }
      }
      if (typeof modelId !== 'string' || modelId.length === 0) {
        return { ok: false, message: 'invalid model id' }
      }
      return testAgentModel(toAgentId(agent), providerId, modelId)
    },
  )
}

// ===== auto-update =====

// Feed failover: GitHub direct first; when unreachable (common in mainland
// China) the same feed through the gh-proxy.com mirror. The choice lives for
// the session only — every launch retries GitHub first.
//
// The mirror is a mitigation, not a verified channel: the app is unsigned
// (electron-builder.yml), and latest.yml plus the installer arrive through the
// same third-party host, so the sha512 comparison cannot distinguish a
// mirrored feed from a tampered one. While the mirror is in play an update is
// never applied without an explicit user action (install-on-quit is disabled
// for the session) and the settings row labels the source as unverified; a
// signing certificate is the real fix.
const GH_PROXY_FEED =
  'https://gh-proxy.com/https://github.com/JochenYang/Coding-Usage/releases/latest/download'

/** Feed options shared by both channels; a short timeout keeps the China
 * mirror failover from hanging on a black-holed GitHub link */
const FEED_TIMEOUT_MS = 10_000
const GH_FEED = { provider: 'github' as const, owner: 'JochenYang', repo: 'Coding-Usage', timeout: FEED_TIMEOUT_MS }
const PROXY_FEED = { provider: 'generic' as const, url: GH_PROXY_FEED, timeout: FEED_TIMEOUT_MS }

type UpdateStatus = 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error'
let updateState: {
  status: UpdateStatus
  version?: string
  percent?: number
  mirror?: string
  message?: string
} = { status: 'idle' }
let usingProxy = false

function setUpdateState(patch: Partial<typeof updateState>): void {
  updateState = { ...updateState, ...patch }
  mainWindow?.webContents.send('desktop:update-status', updateState)
}

async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    setUpdateState({ status: 'error', message: 'dev' })
    return
  }
  setUpdateState({ status: 'checking', mirror: usingProxy ? 'gh-proxy.com' : undefined })
  try {
    await autoUpdater.setFeedURL(GH_FEED)
    await autoUpdater.checkForUpdates()
  } catch (e) {
    if (usingProxy) {
      setUpdateState({ status: 'error', message: String(e instanceof Error ? e.message : e).slice(0, 200) })
      return
    }
    // GitHub unreachable → mirror through gh-proxy.com and try once more
    usingProxy = true
    autoUpdater.setFeedURL(PROXY_FEED)
    // Unsigned app behind a third-party mirror: the only integrity check left
    // is the sha512 in the mirrored latest.yml, which the mirror can rewrite
    // too. Nothing may install without the user's explicit confirmation, so
    // the silent install-on-quit path stays off for the rest of the session.
    autoUpdater.autoInstallOnAppQuit = false
    setUpdateState({ status: 'checking', mirror: 'gh-proxy.com' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (e2) {
      setUpdateState({ status: 'error', message: String(e2 instanceof Error ? e2.message : e2).slice(0, 200) })
    }
  }
}

function setupAutoUpdater(): void {
  // Auto-update only makes sense for the packaged install; dev builds skip it
  if (!app.isPackaged) return
  autoUpdater.on('update-available', (info) => setUpdateState({ status: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'not-available' }))
  autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    lastUpdateVersion = info.version
    setUpdateState({ status: 'downloaded', version: info.version, percent: 100 })
    mainWindow?.webContents.send('desktop:update-downloaded', info.version)
  })
  autoUpdater.on('error', (e) => {
    // Surfaces download-phase failures (check-phase errors land in the
    // checkForUpdates catch); keep the last meaningful state visible
    setUpdateState({ status: 'error', message: String(e instanceof Error ? e.message : e).slice(0, 200) })
  })
  void checkForUpdates()
}

// Single instance: launching the app twice focuses the existing window instead
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  void app.whenReady().then(async () => {
    applyCsp()
    initIlinkSession(net.fetch)
    // Point the usage history store at userData before any scan can run, so a
    // first refresh already merges into the persistent history.
    initUsageStore(app.getPath('userData'))
    // The quota snapshot must be loaded before the renderer asks for it, or the
    // cards would paint the empty state and then jump to the stored numbers.
    await initQuotaStore(app.getPath('userData'))
    initPastedRequests(app.getPath('userData'))
    initOpendesignStore(app.getPath('userData'))
    await loadWindowState()
    registerIpc()
    createWindow()
    createTray()
    setupAutoUpdater()
    initIslandWindow(!app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null)
    // Starts after the first window exists: while one exists it refreshes and
    // pushes on its own, and no cycle window is opened.
    background = new Background({
      userData: app.getPath('userData'),
      hasMainWindow: () => !!mainWindow && !mainWindow.isDestroyed(),
      busy: () => pendingWebhookSends > 0,
      preload: join(__dirname, 'preload.cjs'),
      load: (win) => {
        if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
          void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/background`)
        } else {
          void win.loadFile(join(__dirname, '../dist/index.html'), { hash: '/background' })
        }
      },
    })
    void background.start()
  })

  // Keep running in the tray when every window is hidden/closed; real quits go
  // through the tray menu which flips isQuitting first.
  app.on('window-all-closed', () => {
    // Intentional no-op: the tray keeps the app alive
  })

  app.on('before-quit', () => {
    // Let pending close events pass through during the real quit sequence
    isQuitting = true
    // A quit from the tray menu does not go through closeToTray: remember the
    // rectangle here too, so the next launch reopens where this one was.
    if (mainWindow && !mainWindow.isDestroyed()) rememberBounds(mainWindow)
    background?.stop()
    void stopIlinkSession()
    closeUsageStore()
    // The quota cache is written on a short delay, and Electron does not await
    // a promise here; write synchronously so a quit cannot drop the reading the
    // user just waited for.
    flushQuotaStoreSync()
  })
}
