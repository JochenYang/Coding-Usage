#!/usr/bin/env node
/**
 * Regenerate electron/builtin-pricing.ts from the public OpenRouter models
 * catalog (https://openrouter.ai/api/v1/models). Run when prices drift:
 *
 *   node scripts/gen-builtin-pricing.mjs
 *
 * The generated table is the offline fallback for the main-process pricing
 * override; the live fetch in electron/model-pricing.ts refreshes it at
 * runtime. Prices are USD per token, parsed from OpenRouter's string fields.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(30_000) })
if (!res.ok) {
  console.error(`openrouter responded ${res.status}`)
  process.exit(1)
}
const { data } = await res.json()
if (!Array.isArray(data) || data.length === 0) {
  console.error('unexpected catalog shape')
  process.exit(1)
}

const num = (v) => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// Keep raw ids; the runtime normalizes (strip vendor prefix, drop
// non-alphanumerics) when building its lookup map.
const models = data.map((m) => ({
  id: m.id,
  i: num(m.pricing?.prompt),
  o: num(m.pricing?.completion),
  r: num(m.pricing?.input_cache_read),
  w: num(m.pricing?.input_cache_write),
}))

const header = `/**
 * GENERATED FILE — do not edit by hand.
 * Source: OpenRouter public catalog via scripts/gen-builtin-pricing.mjs
 * (${models.length} models, generated ${new Date().toISOString()}).
 * Offline seed for the scan cost override; the live fetch refreshes it.
 */

export interface BuiltinPricingEntry {
  id: string
  /** USD per token: input / output / cache read / cache write */
  i: number
  o: number
  r: number
  w: number
}

export const BUILTIN_PRICING: BuiltinPricingEntry[] = ${JSON.stringify(models, null, 1)}
`

writeFileSync(join(root, 'electron', 'builtin-pricing.ts'), header)
console.log(`wrote electron/builtin-pricing.ts with ${models.length} models`)
