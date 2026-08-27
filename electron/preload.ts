import { contextBridge, ipcRenderer } from 'electron'

/**
 * Secure bridge between the renderer and the main process. Channel names and
 * signatures mirror the global `DesktopBridge` interface (src/types.d.ts),
 * backed by handlers registered in electron/main.ts.
 */
const desktopBridge: DesktopBridge = {
  fetch: (url, headers) => ipcRenderer.invoke('net:fetch', url, headers),
  encrypt: (plain) => ipcRenderer.invoke('safe:encrypt', plain),
  decrypt: (blob) => ipcRenderer.invoke('safe:decrypt', blob),
  setLoginItem: (open) => ipcRenderer.invoke('app:set-login-item', open),
  tokscaleScan: () => ipcRenderer.invoke('tokscale:scan'),
  codexQuota: () => ipcRenderer.invoke('codex:quota'),
  settingsBackupWrite: (payload) => ipcRenderer.invoke('settings:backup-write', payload),
  settingsBackupRead: () => ipcRenderer.invoke('settings:backup-read'),
  setWindowTheme: (mode) => ipcRenderer.invoke('window:set-theme', mode),
}

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge)
