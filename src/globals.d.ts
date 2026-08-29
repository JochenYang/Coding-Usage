/**
 * Global type declarations for the optional Electron desktop bridge.
 * The bridge is injected by the preload script only when running inside
 * Electron; the plain browser dev path must work without it (hence optional).
 */
export {}

declare global {
  /** Build-time constant injected by electron-vite from package.json#version */
  const __APP_VERSION__: string

  /** Result of a main-process `net.fetch` round-trip (`net:fetch` IPC) */
  interface DesktopFetchResult {
    status: number
    body: string
  }

  /** Shape exposed as `window.desktopBridge` by `electron/preload.ts` */
  interface DesktopBridge {
    /** Main-process fetch (not subject to CORS); status 0 means the request failed entirely */
    fetch(url: string, headers: Record<string, string>): Promise<DesktopFetchResult>
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
