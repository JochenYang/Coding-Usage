import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

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
  claudeUsage: () => ipcRenderer.invoke('claude:usage'),
  geminiUsage: () => ipcRenderer.invoke('gemini:usage'),
  settingsBackupWrite: (payload) => ipcRenderer.invoke('settings:backup-write', payload),
  settingsBackupRead: () => ipcRenderer.invoke('settings:backup-read'),
  setWindowTheme: (mode) => ipcRenderer.invoke('window:set-theme', mode),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdateDownloaded: (callback) => {
    const listener = (_event: IpcRendererEvent, version: string) => callback(version)
    ipcRenderer.on('desktop:update-downloaded', listener)
    return () => ipcRenderer.removeListener('desktop:update-downloaded', listener)
  },
}

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge)
