/**
 * Global type declarations for the optional Electron desktop bridge.
 * The bridge is injected by the preload script only when running inside
 * Electron; the plain browser dev path must work without it (hence optional).
 */
export {}

declare global {
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
    /** Mirror the encrypted v3 settings document to a userData file */
    settingsBackupWrite(payload: string): Promise<void>
    /** Read the mirrored settings document, or null when none exists */
    settingsBackupRead(): Promise<string | null>
    /** Sync the integrated title-bar overlay colors with the resolved app theme */
    setWindowTheme(mode: 'light' | 'dark'): Promise<void>
  }

  /** Raw result of one tokscale scan round-trip (`tokscale:scan` IPC) */
  interface TokScaleRaw {
    today?: unknown
    month?: unknown
    allTime?: unknown
    /** Set when the scan failed (binary missing, exit code, timeout, ...) */
    error?: string
  }

  interface Window {
    desktopBridge?: DesktopBridge
  }
}
