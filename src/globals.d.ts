/**
 * Global type declarations for the optional Electron desktop bridge.
 * The bridge is injected by the preload script only when running inside
 * Electron; the plain browser dev path must work without it (hence optional).
 */
import type { AlertItem } from './lib/alerts'

export {}

declare global {
  /** Build-time constant injected by electron-vite from package.json#version */
  const __APP_VERSION__: string
  /** Snapshot of the auto-update state machine (desktop:update-status) */
  interface DesktopUpdateState {
    status: 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error'
    version?: string
    percent?: number
    /** Active mirror, e.g. "gh-proxy.com" when GitHub direct failed */
    mirror?: string
    message?: string
  }

  /** Result of a main-process `net.fetch` round-trip (`net:fetch` IPC) */
  interface DesktopFetchResult {
    status: number
    body: string
  }

  /** Result of one webhook push attempt (`webhook:send` IPC) */
  interface WebhookSendResult {
    ok: boolean
    /** HTTP status; 0 means the request never completed */
    status: number
    /** Logical failure detail (e.g. a platform errcode) */
    error?: string
  }

  /** Alert-push channel ids accepted by `webhook:send` */
  type WebhookChannel = 'wecom' | 'feishu' | 'telegram' | 'weixin'

  /** Credential pieces for a webhook send; only the channel-relevant fields are used */
  interface WebhookCredential {
    /** wecom / feishu full webhook URL */
    url?: string
    /** telegram bot token / weixin iLink bot token */
    token?: string
    /** telegram chat id */
    chatId?: string
    /** weixin ilink_user_id push target */
    userId?: string
  }

  /** `ilink:begin` — fresh WeChat login QR (data: URL image) */
  interface IlinkBeginResult {
    dataUrl?: string
    qrCode?: string
    expiresAt?: number
    error?: string
  }

  /** `ilink:poll` — WeChat login QR scan status */
  interface IlinkPollResult {
    status: 'pending' | 'scanned' | 'success' | 'expired' | 'error'
    botToken?: string
    botId?: string
    message?: string
  }

  /** `ilink:activate` — one WeChat bot activation check */
  interface IlinkActivateResult {
    userId?: string
    error?: string
  }

  /** Shape exposed as `window.desktopBridge` by `electron/preload.ts` */
  interface DesktopBridge {
    /** Main-process fetch (not subject to CORS); status 0 means the request failed entirely */
    fetch(url: string, headers: Record<string, string>): Promise<DesktopFetchResult>
    /** POST a markdown message to a WeCom group-robot webhook; the payload shape is owned by main */
    webhookSend(channel: WebhookChannel, cred: WebhookCredential, title: string, text: string): Promise<WebhookSendResult>
    /** WeChat iLink bot: fetch a fresh login QR (image as data: URL) */
    ilinkBegin(): Promise<IlinkBeginResult>
    /** WeChat iLink bot: poll the login QR status; success returns the bot token */
    ilinkPoll(qrCode: string): Promise<IlinkPollResult>
    /** WeChat iLink bot: one activation check; userId appears after the user messages the bot */
    ilinkActivate(token: string): Promise<IlinkActivateResult>
    /** Relay a fresh alert batch to the system-level island overlay (desktop only) */
    islandShow(alerts: unknown[]): Promise<void>
    /** Hide the system-level island overlay */
    islandHide(): Promise<void>
    /** Toggle click-through on the overlay (off while the pointer hovers it) */
    islandClickThrough(clickThrough: boolean): Promise<void>
    /** Focus the main window and open the alerts page (overlay body click) */
    islandOpenMain(): Promise<void>
    /** Overlay surface: subscribe to relayed alert batches */
    onIslandAlert(callback: (alerts: AlertItem[]) => void): () => void
    /** Main window: fired when the overlay body is clicked */
    onOpenAlerts(callback: () => void): () => void
    /** Encrypt via safeStorage; returns an `enc:v3:<base64>` blob, or null when encryption is unavailable */
    encrypt(plain: string): Promise<string | null>
    /** Decrypt an `enc:v3:` blob produced by {@link DesktopBridge.encrypt}; null on failure */
    decrypt(blob: string): Promise<string | null>
    /** Toggle launch-on-login (Windows: openAtLogin registry entry) */
    setLoginItem(open: boolean): Promise<void>
    /** Scan local AI coding-agent usage via tokscale (main process). Absent in browser dev */
    tokscaleScan(): Promise<TokScaleRaw>
    /** Codex subscription quota from the local ChatGPT login (official wham endpoint) */
    codexQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Claude subscription quota from the local Claude Code OAuth login (official usage endpoint) */
    claudeUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Gemini Code Assist quota via the local Gemini CLI OAuth login (refresh happens in main) */
    geminiUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Grok Build (SuperGrok) quota via the local `grok login` state; body is a normalized {percent,resetsAt,plan,email} */
    grokUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Mirror the encrypted v3 settings document to a userData file */
    settingsBackupWrite(payload: string): Promise<void>
    /** Read the mirrored settings document, or null when none exists */
    settingsBackupRead(): Promise<string | null>
    /** Minimize the window (custom caption button) */
    minimizeWindow(): Promise<void>
    /** Toggle maximize/restore (custom caption button + title-bar double click) */
    toggleMaximizeWindow(): Promise<void>
    /** Hide the window to the tray ("minimize to tray" choice) */
    hideWindow(): Promise<void>
    /** Real quit through the tray/confirm flow (sets the pass-through gate first) */
    quitApp(): Promise<void>
    /** Current maximize state for the caption-button glyph */
    getWindowMaximized(): Promise<boolean>
    /** Subscribe to maximize/unmaximize transitions; returns an unsubscribe function */
    onWindowMaximized(callback: (maximized: boolean) => void): () => void
    /** Fired when a close is intercepted (caption X / Alt+F4) so the app can confirm */
    onCloseRequested(callback: () => void): () => void
    /** Quit and install the downloaded auto-update (no-op when nothing is staged) */
    installUpdate(): Promise<void>
    /** Kick a manual update check; resolves with the current state snapshot */
    checkForUpdates(): Promise<DesktopUpdateState>
    /** Subscribe to update-state transitions; returns an unsubscribe function */
    onUpdateStatus(callback: (status: DesktopUpdateState) => void): () => void
    /** Subscribe to autoUpdater's update-downloaded event; returns an unsubscribe function */
    onUpdateDownloaded(callback: (version: string) => void): () => void
  }

  /** Raw result of one tokscale scan round-trip (`tokscale:scan` IPC) */
  interface TokScaleRaw {
    /** Per-day contributions from `tokscale graph` (aggregated renderer-side) */
    daily?: unknown
    /** Set when the scan failed (binary missing, exit code, timeout, ...) */
    error?: string
  }

  interface Window {
    desktopBridge?: DesktopBridge
  }
}
