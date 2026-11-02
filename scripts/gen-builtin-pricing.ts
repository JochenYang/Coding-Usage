#!/usr/bin/env node
/**
 * Regenerate electron/builtin-pricing.ts from models.dev's official vendor
 * storefronts. Run when the offline snapshot needs refreshing:
 *
 *   node --experimental-strip-types scripts/gen-builtin-pricing.ts
 *
 * The generated table stores per-token USD prices and long-context tiers; the
 * runtime projection lives in electron/model-pricing-core.ts so this script
 * and the app cannot drift apart.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildModelsFromModelsDev } from '../electron/model-pricing-core.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(30_000) })
if (!res.ok) {
  console.error(`models.dev responded ${res.status}`)
  process.exit(1)
}
const json: unknown = await res.json()
const models = buildModelsFromModelsDev(json)
if (models.size === 0) {
  console.error('models.dev projection produced no priced models')
  process.exit(1)
}

const rows = [...models.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([k, entry]) => ({
    k,
    i: entry.i,
    o: entry.o,
    r: entry.r,
    w: entry.w,
    ...(entry.tiers && entry.tiers.length > 0 ? { t: entry.tiers } : {}),
  }))

const generatedAt = new Date().toISOString().slice(0, 10)
const header = `/**
 * GENERATED FILE — do not edit by hand.
 * Source: models.dev api.json, projected onto official vendor storefronts
 * (${rows.length} models, generated ${generatedAt}).
 * Regenerate: node --experimental-strip-types scripts/gen-builtin-pricing.ts
 *
 * Offline fallback for the scan cost override. Prices are USD per token;
 * optional \`t\` carries long-context tiers.
 */

export interface BuiltinPricingTier {
  threshold: number
  i: number
  o: number
  r: number
  w: number
}

export interface BuiltinPricingEntry {
  /** Normalized model id */
  k: string
  i: number
  o: number
  r: number
  w: number
  t?: BuiltinPricingTier[]
}

export const BUILTIN_PRICING_META = {
  source: 'models.dev',
  generatedAt: '${generatedAt}',
  modelCount: ${rows.length},
} as const

export const BUILTIN_PRICING: BuiltinPricingEntry[] = ${JSON.stringify(rows, null, 1)}
`

writeFileSync(join(root, 'electron', 'builtin-pricing.ts'), header)
console.log(`wrote electron/builtin-pricing.ts with ${rows.length} models`)
