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
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getWindowMaximized: () => ipcRenderer.invoke('window:get-maximized'),
  onWindowMaximized: (callback) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('desktop:window-maximized', listener)
    return () => ipcRenderer.removeListener('desktop:window-maximized', listener)
  },
  onCloseRequested: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('desktop:close-requested', listener)
    return () => ipcRenderer.removeListener('desktop:close-requested', listener)
  },
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdateDownloaded: (callback) => {
    const listener = (_event: IpcRendererEvent, version: string) => callback(version)
    ipcRenderer.on('desktop:update-downloaded', listener)
    return () => ipcRenderer.removeListener('desktop:update-downloaded', listener)
  },
}

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge)
