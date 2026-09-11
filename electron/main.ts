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
  net,
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { fetchClaudeUsage, fetchGeminiUsage, type QuotaOutcome } from './subscription-quotas'
import { fetchGrokUsage } from './grok-usage'
import { getPricingTable, priceTokens } from './model-pricing'
import { mergeGraphPayloads } from './tokscale-merge'
import { reconcileProviderAttribution } from './provider-reconcile'
import { ensureDshSessionAliases } from './dsh-aliases'
import { ensureWorkbuddyAliases } from './workbuddy-aliases'
import {
  buildChannelRequest,
  channelErrorDetail,
  isChannelSuccess,
  type PushChannel,
} from './webhook-channels'
import { ilinkBeginLogin, ilinkPollActivation, ilinkPollLogin } from './weixin-ilink'
import {
  ensureIlinkSessionWarm,
  initIlinkSession,
  recoverIlinkSession,
  startIlinkSession,
  stopIlinkSession,
} from './weixin-session'
import { initIslandWindow, islandHide, islandSetClickThrough, islandShow } from './island-window'

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
  'dsh',
  'zcode',
  'micode',
]
const TOKSCALE_CACHE_MS = 5 * 60_000

interface TokScanResult {
  /** Daily contributions from `tokscale graph` (per-day totals + client/model detail) */
  daily?: unknown
  error?: string
  /** Client ids whose per-client scan failed in the degraded fallback path */
  skippedClients?: string[]
  /** Per-client failure reason, keyed by client id (mirrors skippedClients) */
  skippedDetails?: Record<string, string>
  /** Epoch ms when the scan was requested — kept stable across cache hits so
   *  the renderer can show an honest as-of time instead of re-stamping "now" */
  scannedAt?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let tokScanCache: { at: number; result: TokScanResult } | null = null
/** In-flight scan shared by overlapping requests (tick + manual click) */
let tokScanInflight: Promise<TokScanResult> | null = null

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
  // Alias DSH's versioned transcripts to the canonical names tokscale scans
  // for (see dsh-aliases.ts) — best-effort, a missing DSH root is a no-op.
  await ensureDshSessionAliases(
    process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'),
    join(app.getPath('userData'), 'dsh-aliases.json'),
  )
  // WorkBuddy AI (international) keeps its transcripts in a home tokscale
  // never scans — mirror them into the scanned one (see workbuddy-aliases.ts).
  await ensureWorkbuddyAliases(
    join(homedir(), '.workbuddy'),
    join(homedir(), '.workbuddy-ai'),
    join(app.getPath('userData'), 'workbuddy-aliases.json'),
  )
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
    const costs = await overrideCosts(daily)
    return { daily: reconcileProviderAttribution(costs) }
  }

  const merged = await scanPerClientWithFallback(baseArgs)
  // Throw (not return `{error}`): the IPC handler surfaces failures without
  // caching them, so a manual refresh always re-attempts the scan instead of
  // replaying a stale error for the cache window.
  if (merged == null) throw new Error('tokscale scan failed for every client')
  const costs = await overrideCosts(merged.daily)
  return {
    daily: reconcileProviderAttribution(costs),
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
 * Replace tokscale's per-entry cost with our own OpenRouter-catalog pricing
 * wherever the model is known, then fold the delta back into the day total so
 * the renderer's "other" derivation (totals minus clients) stays balanced.
 * Unknown models keep tokscale's cost untouched. Repriced entries are marked
 * `priced: true` so the renderer can tell "catalog-priced at 0" apart from
 * "no catalog price" when labeling unpriced models.
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
          tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
          /** Set when this entry was repriced from the OpenRouter catalog */
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
        const computed = priceTokens(table, e.modelId, e.tokens)
        if (computed == null) continue
        dayDelta += computed - (typeof e.cost === 'number' ? e.cost : 0)
        e.cost = Math.round(computed * 1e6) / 1e6
        // Mark catalog-priced entries so the renderer can tell "priced at 0"
        // (e.g. free-tier models) apart from "no catalog price" downstream.
        e.priced = true
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

  // Alert-push webhook send. The renderer supplies only the channel id, its
  // credential pieces and the message text; the payload shape and the
  // per-platform success semantics live in webhook-channels.ts, so the
  // renderer stays a narrow client of known integrations rather than an open
  // POST proxy.
  ipcMain.handle(
    'webhook:send',
    async (
      _event,
      channel: unknown,
      cred: unknown,
      title: unknown,
      text: unknown,
    ): Promise<WebhookSendResult> => {
      if (
        !['wecom', 'feishu', 'telegram', 'weixin'].includes(channel as string) ||
        !cred ||
        typeof cred !== 'object' ||
        typeof title !== 'string' ||
        !title ||
        typeof text !== 'string' ||
        !text
      ) {
        return { ok: false, status: 0, error: 'invalid-request' }
      }
      const c = cred as Record<string, unknown>
      const request = buildChannelRequest(
        channel as PushChannel,
        {
          url: typeof c.url === 'string' ? c.url : undefined,
          token: typeof c.token === 'string' ? c.token : undefined,
          chatId: typeof c.chatId === 'string' ? c.chatId : undefined,
          userId: typeof c.userId === 'string' ? c.userId : undefined,
        },
        title,
        text,
      )
      if (!request) return { ok: false, status: 0, error: 'invalid-credential' }
      // WeChat iLink: sendmessage only lands while the bot session is
      // "prepared" (ZCode keeps a getupdates long-poll alive for that).
      // This app is opened on demand, so warm the session after a cold
      // start and recover from {ret:-2,prepare failed} with one full
      // getupdates round before the single retry below.
      const weixinToken = channel === 'weixin' ? (c.token as string) : ''
      if (weixinToken) {
        await ensureIlinkSessionWarm(weixinToken)
      }
      const isWeixinPrepareFailed = (json: unknown): boolean => {
        if (channel !== 'weixin' || json == null || typeof json !== 'object') return false
        const obj = json as Record<string, unknown>
        const layers = [obj, obj.data, obj.result].filter(
          (l): l is Record<string, unknown> => l != null && typeof l === 'object' && !Array.isArray(l),
        )
        return layers.some((l) => {
          const ret = l.ret
          const msg = typeof l.errmsg === 'string' ? l.errmsg : typeof l.message === 'string' ? l.message : ''
          return ret === -2 || ret === '-2' || /prepare failed/i.test(msg)
        })
      }
      // One retry on transport-level failure: the iLink endpoint occasionally
      // black-holes a request past the 15s timeout while the next one answers
      // instantly. A hard-down network fails both attempts quickly anyway.
      // WeChat prepare-failed also uses the retry slot after a session recover.
      let lastError = ''
      let weixinRecovered = false
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await net.fetch(request.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(request.headers ?? {}) },
            body: request.body,
            signal: AbortSignal.timeout(15_000),
          })
          let json: unknown = null
          try {
            json = JSON.parse(await res.text())
          } catch {
            // Non-JSON error page (gateway etc.) — the HTTP status carries it
          }
          // Logical failures (HTTP 200 + platform errcode, e.g. weixin ret!=0)
          // must carry the platform detail too — otherwise the renderer can only
          // fall back to a bare "HTTP 200" and the real cause is invisible.
          const ok = isChannelSuccess(channel as PushChannel, res.ok, json)
          if (!ok) {
            // Cold-start / idle-session rejection: re-prepare via getupdates
            // and spend the retry slot on the same payload (not a duplicate
            // logical message — the first attempt never delivered).
            if (weixinToken && !weixinRecovered && isWeixinPrepareFailed(json)) {
              weixinRecovered = true
              const recovered = await recoverIlinkSession(weixinToken)
              console.error(
                `[webhook:send] channel=weixin prepare-failed, recover=${recovered ? 'ok' : 'fail'}`,
              )
              if (recovered) continue
            }
            const detail = channelErrorDetail(channel as PushChannel, res.status, json)
            console.error(`[webhook:send] channel=${channel as string} status=${res.status} detail=${detail}`)
            // A platform rejection is deterministic — retrying would just
            // duplicate the failure, so return immediately
            return { ok: false, status: res.status, error: detail }
          }
          return { ok, status: res.status }
        } catch (e) {
          lastError = String(e instanceof Error ? e.message : e)
        }
      }
      return { ok: false, status: 0, error: lastError }
    },
  )

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

  // Connection check for a stored bot token: one short getupdates round. An
  // empty-but-ok round means the token is alive (there are simply no new
  // messages); only a transport/API error reports failure. Lets the UI tell
  // "token dead, re-login" apart from "token alive, send payload rejected".
  ipcMain.handle(
    'ilink:check',
    async (_event, token: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (typeof token !== 'string' || !token) return { ok: false, error: 'invalid-request' }
      try {
        await ilinkPollActivation(net.fetch, token, 15_000)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) }
      }
    },
  )

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
  ipcMain.handle('island:clickthrough', (_event, clickThrough: unknown): void => {
    islandSetClickThrough(clickThrough === true)
  })
  ipcMain.handle('island:open-main', (): void => {
    showMainWindow()
    mainWindow?.webContents.send('island:open-alerts')
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

  // Grok Build (SuperGrok) subscription quota via the local `grok login`
  // state (~/.grok/auth.json); the CLI refreshes its own token, we never do.
  ipcMain.handle(
    'grok:usage',
    async (): Promise<QuotaOutcome> =>
      cachedQuotaOutcome('grok', () => fetchGrokUsage(net.fetch, homedir())),
  )

  // Local agent usage scan. Cached in the main process: a full three-period
  // scan takes tens of seconds, so repeated renderer refreshes are cheap. Each
  // result carries the epoch ms of its scan request (`scannedAt`) — cache hits
  // return the original stamp, so the renderer's as-of time stays honest — and
  // overlapping calls share one in-flight round-trip instead of spawning the
  // binary twice.
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
        const stamped: TokScanResult = { ...result, scannedAt: now }
        tokScanCache = { at: now, result: stamped }
        return stamped
      } catch (e) {
        return { error: String(e instanceof Error ? e.message : e) }
      } finally {
        tokScanInflight = null
      }
    })()
    tokScanInflight = pending
    return pending
  })
}

// ===== auto-update =====

// Feed failover: GitHub direct first; when unreachable (common in mainland
// China) the same feed through the gh-proxy.com mirror. The choice lives for
// the session only — every launch retries GitHub first.
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

  void app.whenReady().then(() => {
    applyCsp()
    initIlinkSession(net.fetch)
    registerIpc()
    createWindow()
    createTray()
    setupAutoUpdater()
    initIslandWindow(!app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null)
  })

  // Keep running in the tray when every window is hidden/closed; real quits go
  // through the tray menu which flips isQuitting first.
  app.on('window-all-closed', () => {
    // Intentional no-op: the tray keeps the app alive
  })

  app.on('before-quit', () => {
    // Let pending close events pass through during the real quit sequence
    isQuitting = true
    void stopIlinkSession()
  })
}
