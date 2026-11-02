import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { BUILTIN_PRICING, BUILTIN_PRICING_META } from './builtin-pricing'
import {
  buildModelsFromModelsDev,
  buildModelsFromOpenRouter,
  normalizeModelId,
  priceTokens,
  type PricingEntry,
  type PricingMeta,
  type PricingSource,
  type PricingTable,
  type PricingTier,
} from './model-pricing-core'

export { normalizeModelId, priceTokens }
export type { PricingEntry, PricingMeta, PricingSource, PricingTable, PricingTier }

/**
 * Model pricing for the scan cost override.
 *
 * Primary source is models.dev projected onto the vendor-owned storefronts:
 * that keeps reseller and coding-plan listings (including their zero prices)
 * out of the catalogue. OpenRouter is only fetched when models.dev cannot be
 * read, and the generated builtin snapshot is the offline floor. A background
 * fetch refreshes the on-disk cache daily and never blocks the scan.
 */

const CACHE_FILE = 'pricing-cache.json'
const CACHE_VERSION = 2
const MEM_TTL_MS = 60 * 60_000
const FETCH_TTL_MS = 24 * 60 * 60_000

const MODELS_DEV_URL = 'https://models.dev/api.json'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'

let memory: { at: number; table: PricingTable } | null = null
let builtin: PricingTable | null = null

/** JSON shape stored in userData; entries keep per-token prices and tiers */
interface StoredPricingEntry {
  i: number
  o: number
  r: number
  w: number
  t?: PricingTier[]
}

interface StoredPricingFile {
  version?: unknown
  source?: unknown
  fetchedAt?: unknown
  models?: unknown
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStoredTier(value: unknown): value is PricingTier {
  if (value == null || typeof value !== 'object') return false
  const tier = value as Partial<PricingTier>
  return (
    isFiniteNumber(tier.threshold) &&
    tier.threshold > 0 &&
    isFiniteNumber(tier.i) &&
    isFiniteNumber(tier.o) &&
    isFiniteNumber(tier.r) &&
    isFiniteNumber(tier.w)
  )
}

function isStoredEntry(value: unknown): value is StoredPricingEntry {
  if (value == null || typeof value !== 'object') return false
  const entry = value as Partial<StoredPricingEntry>
  if (!isFiniteNumber(entry.i) || !isFiniteNumber(entry.o) || !isFiniteNumber(entry.r) || !isFiniteNumber(entry.w)) {
    return false
  }
  return entry.t == null || (Array.isArray(entry.t) && entry.t.every(isStoredTier))
}

function builtinTable(): PricingTable {
  if (builtin) return builtin
  const models = new Map<string, PricingEntry>()
  for (const row of BUILTIN_PRICING) {
    models.set(row.k, {
      i: row.i,
      o: row.o,
      r: row.r,
      w: row.w,
      ...(row.t && row.t.length > 0 ? { tiers: row.t } : {}),
    })
  }
  builtin = {
    models,
    source: 'builtin',
    fetchedAt: 0,
    generatedAt: BUILTIN_PRICING_META.generatedAt,
    modelCount: models.size,
  }
  return builtin
}

async function readCacheFile(): Promise<PricingTable | null> {
  try {
    const raw = await readFile(join(app.getPath('userData'), CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as StoredPricingFile
    // Version 1 stored OpenRouter models only and cannot be told apart from the
    // new official catalogue; ignore it and refill on the next fetch.
    if (parsed.version !== CACHE_VERSION) return null
    if (parsed.source !== 'models.dev' && parsed.source !== 'openrouter') return null
    if (!isFiniteNumber(parsed.fetchedAt)) return null
    if (parsed.models == null || typeof parsed.models !== 'object') return null
    const models = new Map<string, PricingEntry>()
    for (const [key, value] of Object.entries(parsed.models)) {
      if (!isStoredEntry(value)) continue
      models.set(key, {
        i: value.i,
        o: value.o,
        r: value.r,
        w: value.w,
        ...(value.t && value.t.length > 0 ? { tiers: value.t } : {}),
      })
    }
    if (models.size === 0) return null
    return {
      models,
      source: parsed.source,
      fetchedAt: parsed.fetchedAt,
      modelCount: models.size,
    }
  } catch {
    return null
  }
}

async function writeCacheFile(table: PricingTable): Promise<void> {
  try {
    const file = join(app.getPath('userData'), CACHE_FILE)
    await mkdir(dirname(file), { recursive: true })
    const models: Record<string, StoredPricingEntry> = {}
    for (const [key, entry] of table.models) {
      models[key] = { i: entry.i, o: entry.o, r: entry.r, w: entry.w, ...(entry.tiers ? { t: entry.tiers } : {}) }
    }
    await writeFile(
      file,
      JSON.stringify({ version: CACHE_VERSION, source: table.source, fetchedAt: table.fetchedAt, models }),
    )
  } catch {
    // best-effort cache
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

async function fetchModelsDev(): Promise<PricingTable | null> {
  const json = await fetchJson(MODELS_DEV_URL)
  if (json == null) return null
  const models = buildModelsFromModelsDev(json)
  if (models.size === 0) return null
  return { models, source: 'models.dev', fetchedAt: Date.now(), modelCount: models.size }
}

async function fetchOpenRouter(): Promise<PricingTable | null> {
  const json = await fetchJson(OPENROUTER_URL)
  if (json == null) return null
  const models = buildModelsFromOpenRouter(json)
  if (models.size === 0) return null
  return { models, source: 'openrouter', fetchedAt: Date.now(), modelCount: models.size }
}

function toMeta(table: PricingTable): PricingMeta {
  return {
    source: table.source,
    fetchedAt: table.fetchedAt,
    ...(table.generatedAt ? { generatedAt: table.generatedAt } : {}),
    modelCount: table.modelCount,
  }
}

/**
 * Best-effort pricing table: never throws, never blocks longer than the
 * timeouts above. models.dev is preferred; a stale models.dev cache, an
 * OpenRouter fallback, or the bundled snapshot keep scans priced offline.
 */
export async function getPricingTable(): Promise<PricingTable> {
  if (memory && Date.now() - memory.at < MEM_TTL_MS) return memory.table

  const cached = await readCacheFile()
  if (cached && cached.source === 'models.dev' && Date.now() - cached.fetchedAt <= FETCH_TTL_MS) {
    memory = { at: Date.now(), table: cached }
    return cached
  }

  let table: PricingTable
  const fresh = await fetchModelsDev()
  if (fresh) {
    table = fresh
    void writeCacheFile(fresh)
  } else if (cached) {
    table = cached
  } else {
    const fallback = await fetchOpenRouter()
    table = fallback ?? builtinTable()
    if (fallback) void writeCacheFile(fallback)
  }

  memory = { at: Date.now(), table }
  return table
}

/** Snapshot for the cost page; never triggers a fetch. */
export function getPricingMeta(): PricingMeta {
  return toMeta(memory?.table ?? builtinTable())
}
