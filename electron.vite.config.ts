import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// Single source of truth for the version the settings page displays
const APP_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

export default defineConfig({
  main: {
    // externalizeDeps keeps dependencies (electron-updater) as runtime requires
    // instead of bundling them; electron and node builtins are always external.
    build: {
      outDir: 'dist-electron',
      emptyOutDir: false,
      rollupOptions: {
        // Entry keeps a './' prefix: bare 'electron/main.ts' would collide with
        // the default external pattern /^electron\/.+/ (electron subpath import)
        input: './electron/main.ts',
        // Force CommonJS with an explicit .cjs extension: the project ships
        // "type": "module", so a plain .js entry would be misread as ESM.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist-electron',
      // Shared output dir with main — emptying here would delete main.cjs
      emptyOutDir: false,
      rollupOptions: {
        input: './electron/preload.ts',
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'dist',
      rollupOptions: { input: 'index.html' },
    },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  },
})
