import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// Mirrors the electron-vite renderer define: the browser path (dev:web /
// build:web) must see the same build-time version constant or SettingsPage
// crashes at module scope.
const APP_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

/**
 * Git-ignored scratch dirs: review probes, preview harnesses, build logs — and
 * files another process holds open (a headless browser's profile). Vite watches
 * the project root by default, and one locked file under .tmp/ took the dev
 * server down with EBUSY on Windows. Ignoring them skips the watching only;
 * the preview pages under .tmp/ are still served.
 *
 * Mirrored in electron.vite.config.ts (the `npm run dev` renderer server).
 */
const WATCH_IGNORED = ['**/.tmp/**', '**/.devflow/**', '**/.playwright-cli/**']

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: { watch: { ignored: WATCH_IGNORED } },
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
})
