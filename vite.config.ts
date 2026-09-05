import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// Mirrors the electron-vite renderer define: the browser path (dev:web /
// build:web) must see the same build-time version constant or SettingsPage
// crashes at module scope.
const APP_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
})
