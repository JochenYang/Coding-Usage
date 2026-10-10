import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Unit-test config for the pure logic under `src/lib`.
 *
 * Deliberately separate from `vite.config.ts`: a browser build must never pull
 * test setup, and this file pins the environment to node (the tested modules —
 * trend bucketing, scan aggregation — are DOM-free by design, which is what
 * makes them testable at all).
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
