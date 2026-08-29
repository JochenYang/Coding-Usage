import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { BUILTIN_PRICING } from './builtin-pricing'

/**
 * Model pricing for the scan cost override. tokscale computes costs against
 * its own (sometimes unseeded, network-dependent) pricing cache; we instead
 * price every matched model with the public OpenRouter catalog so the shown
 * numbers follow official per-model rates consistently.
 *
 * Layers: in-memory (1h) → userData cache file (any age) → bundled seed
 * (generated from the same catalog). A background fetch refreshes the cache
 * file daily and never blocks the scan.
 */

export interface PricingEntry {
  /** USD per token: input / output / cache read / cache write */
  i: number
  o: number
  r: number
  w: number
}

export interface PricingTable {
  /** normalized model id → per-token prices */
  models: Map<string, PricingEntry>
  source: 'openrouter' | 'cache-file' | 'builtin'
  fetchedAt: number
}

const CACHE_FILE = 'pricing-cache.json'
const MEM_TTL_MS = 60 * 60_000
const FETCH_TTL_MS = 24 * 60 * 60_000

let memory: { at: number; table: PricingTable } | null = null

/** lowercase, vendor prefix dropped, only [a-z0-9] kept */
export function normalizeModelId(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function buildModels(
  entries: Array<{ id: string; i: number; o: number; r: number; w: number }>,
): Map<string, PricingEntry> {
  const map = new Map<string, PricingEntry>()
  for (const e of entries) {
    const entry = { i: e.i, o: e.o, r: e.r, w: e.w }
    const full = normalizeModelId(e.id)
    if (full) map.set(full, entry)
    // Vendor-stripped suffix gets its own key so "claude-opus-4-8" matches
    // "anthropic/claude-opus-4.8" even when the full id normalizes differently
    const tail = normalizeModelId(e.id.split('/').pop() ?? e.id)
    if (tail && tail !== full) map.set(tail, entry)
  }
  return map
}

function builtinTable(): PricingTable {
  return { models: buildModels(BUILTIN_PRICING), source: 'builtin', fetchedAt: 0 }
}

async function readCacheFile(): Promise<PricingTable | null> {
  try {
    const raw = await readFile(join(app.getPath('userData'), CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; models?: Record<string, PricingEntry> }
    if (!parsed.models || typeof parsed.models !== 'object') return null
    return { models: new Map(Object.entries(parsed.models)), source: 'cache-file', fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0 }
  } catch {
    return null
  }
}

async function writeCacheFile(table: PricingTable): Promise<void> {
  try {
    const file = join(app.getPath('userData'), CACHE_FILE)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ fetchedAt: table.fetchedAt, models: Object.fromEntries(table.models) }))
  } catch {
    // best-effort cache
  }
}

async function fetchOpenRouter(): Promise<PricingTable | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: Array<{ id?: unknown; pricing?: Record<string, unknown> }> }
    if (!Array.isArray(json.data)) return null
    const num = (v: unknown): number => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN
      return Number.isFinite(n) && n >= 0 ? n : 0
    }
    const entries = json.data
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({
        id: m.id as string,
        i: num(m.pricing?.prompt),
        o: num(m.pricing?.completion),
        r: num(m.pricing?.input_cache_read),
        w: num(m.pricing?.input_cache_write),
      }))
    if (entries.length === 0) return null
    return { models: buildModels(entries), source: 'openrouter', fetchedAt: Date.now() }
  } catch {
    return null
  }
}

/**
 * Best-effort pricing table: never throws, never blocks longer than the
 * timeouts above. A stale cache file or the bundled seed is always good
 * enough to price scans offline.
 */
export async function getPricingTable(): Promise<PricingTable> {
  if (memory && Date.now() - memory.at < MEM_TTL_MS) return memory.table

  const cached = await readCacheFile()
  const needsRefresh = !cached || Date.now() - cached.fetchedAt > FETCH_TTL_MS
  let table: PricingTable

  if (cached && !needsRefresh) {
    table = cached
  } else {
    const fresh = await fetchOpenRouter()
    if (fresh) {
      table = fresh
      void writeCacheFile(fresh)
    } else if (cached) {
      table = cached
    } else {
      table = builtinTable()
    }
  }

  memory = { at: Date.now(), table }
  return table
}

/** Price one model's token counts; null when the model is unknown */
export function priceTokens(
  table: PricingTable,
  modelId: string,
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): number | null {
  const key = normalizeModelId(modelId)
  // "-free" variants are free tiers by definition (kimi-k2.5-free, glm-4.7-free, …)
  if (key.endsWith('free')) return 0
  const entry = table.models.get(key)
  if (!entry) return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return (
    n(tokens.input) * entry.i +
    n(tokens.output) * entry.o +
    n(tokens.cacheRead) * entry.r +
    n(tokens.cacheWrite) * entry.w
  )
}
