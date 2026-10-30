import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Unit-test config for the pure logic under `src/lib` and the main process's
 * storage layer under `electron/`.
 *
 * Deliberately separate from `vite.config.ts`: a browser build must never pull
 * test setup, and this file pins the environment to node (the tested modules —
 * trend bucketing, scan aggregation, the usage history store — touch no DOM and
 * no Electron API, which is what makes them testable at all).
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
  },
})
