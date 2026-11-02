/**
 * Pure model-pricing logic shared by the main process and the builtin-snapshot
 * generator. No Electron or filesystem imports: this module can run in a plain
 * Node process as well as in the packaged app.
 *
 * Prices are stored per token (USD), converted from the catalogue's USD per
 * million tokens. The primary catalogue is models.dev projected onto the model
 * vendors' own storefronts; OpenRouter is only the fallback when that fetch
 * fails.
 */

export interface PricingTier {
  /** Context size in tokens above which this rate applies */
  threshold: number
  /** USD per token */
  i: number
  o: number
  r: number
  w: number
}

export interface PricingEntry {
  /** USD per token: input / output / cache read / cache write */
  i: number
  o: number
  r: number
  w: number
  /** Long-context steps, ascending by threshold; the last exceeded step wins */
  tiers?: PricingTier[]
}

export type PricingSource = 'models.dev' | 'openrouter' | 'builtin'

export interface PricingTable {
  models: Map<string, PricingEntry>
  source: PricingSource
  fetchedAt: number
  /** Snapshot generation date, only for the builtin source */
  generatedAt?: string
  modelCount: number
}

export interface PricingMeta {
  source: PricingSource
  fetchedAt: number
  generatedAt?: string
  modelCount: number
}

/** Lowercase, vendor prefix dropped, only [a-z0-9] kept */
export function normalizeModelId(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * One official vendor and the storefronts models.dev lists it under, in
 * preference order. Regional stores follow the international one because the
 * catalogue prices everything in USD and the scan cannot tell which regional
 * store billed the usage; coding-plan and token-plan stores are deliberately
 * absent because their zero prices are not per-token prices.
 */
interface OfficialVendor {
  vendor: string
  stores: string[]
  /** Normalized model-id prefixes this vendor actually owns */
  prefixes: string[]
}

const OFFICIAL_VENDORS: OfficialVendor[] = [
  { vendor: 'anthropic', stores: ['anthropic'], prefixes: ['claude'] },
  {
    vendor: 'openai',
    stores: ['openai'],
    prefixes: ['gpt', 'chatgpt', 'o1', 'o3', 'o4', 'text-embedding', 'gpt-image'],
  },
  { vendor: 'google', stores: ['google', 'google-vertex'], prefixes: ['gemini', 'gemma'] },
  { vendor: 'deepseek', stores: ['deepseek'], prefixes: ['deepseek'] },
  { vendor: 'zhipu', stores: ['zai', 'zhipuai'], prefixes: ['glm'] },
  { vendor: 'moonshot', stores: ['moonshotai', 'moonshotai-cn'], prefixes: ['kimi'] },
  { vendor: 'alibaba', stores: ['alibaba', 'alibaba-cn'], prefixes: ['qwen', 'qvq'] },
  { vendor: 'xai', stores: ['xai'], prefixes: ['grok'] },
  { vendor: 'minimax', stores: ['minimax', 'minimax-cn'], prefixes: ['minimax'] },
  { vendor: 'stepfun', stores: ['stepfun-ai', 'stepfun'], prefixes: ['step'] },
  { vendor: 'sensenova', stores: ['sensenova'], prefixes: ['sensenova'] },
  { vendor: 'xiaomi', stores: ['xiaomi'], prefixes: ['mimo'] },
  { vendor: 'volcengine', stores: ['volcengine'], prefixes: ['doubao', 'seed'] },
  { vendor: 'tencent', stores: ['tencent-tokenhub'], prefixes: ['hy'] },
  { vendor: 'mistral', stores: ['mistral'], prefixes: ['mistral', 'codestral', 'pixtral', 'magistral'] },
  { vendor: 'meta', stores: ['meta'], prefixes: ['llama'] },
  { vendor: 'cohere', stores: ['cohere'], prefixes: ['command'] },
  { vendor: 'nvidia', stores: ['nvidia'], prefixes: ['nemotron'] },
]

/**
 * Codenames that price as a catalogue entry under a different id.
 *
 * Antigravity's SQLite stores carry a product display name for recent turns but
 * only the internal codename for older ones, and the catalogue lists no bare
 * `gemini-3-flash` — `gemini-3-flash-a`/`-b` are the same model it sells as
 * `gemini-3-flash-preview` (the mapping tokscale's own Antigravity parser uses).
 */
const MODEL_ALIASES: Record<string, string> = {
  gemini3flasha: 'gemini3flashpreview',
  gemini3flashb: 'gemini3flashpreview',
}

/** Reasoning-tier words the catalogue never carries in an id */
const TIER_SUFFIXES = ['thinking', 'high', 'low', 'medium'] as const

/** Router/region markers some agents prepend to a bare model name */
const ROUTE_PREFIXES = ['auto', 'cn', 'global'] as const

/**
 * Fast-mode multipliers from ccusage's public override table (MIT). A model
 * ending in `-fast` is billed at this multiple of its base rate; unknown fast
 * models stay unpriced rather than silently using the base rate.
 */
const FAST_MULTIPLIERS: Record<string, number> = {
  gpt56sol: 2,
  gpt56terra: 2,
  gpt56luna: 2,
  gpt55: 2.5,
  gpt54: 2,
  gpt53codex: 2,
  gpt6astra: 2,
  gpt6sol: 2,
  gpt61sol: 2,
  gpt61terra: 2,
  gpt6luna: 2,
}
const FAST_PREFIX_MULTIPLIERS: Array<[string, number]> = [
  ['claudeopus46', 6],
  ['claudeopus47', 6],
  ['claudeopus48', 2],
]

function fastMultiplier(baseKey: string): number | null {
  const exact = FAST_MULTIPLIERS[baseKey]
  if (exact) return exact
  for (const [prefix, value] of FAST_PREFIX_MULTIPLIERS) {
    if (baseKey.startsWith(prefix)) return value
  }
  return null
}

/** Flex-mode multiplier from ccusage's public override table (MIT). */
const FLEX_MODELS = new Set([
  'gpt6astra',
  'gpt61sol',
  'gpt61terra',
  'gpt6luna',
  'gpt6sol',
  'gpt56sol',
  'gpt56terra',
  'gpt56luna',
  'gpt55',
  'gpt55pro',
  'gpt54',
  'gpt54mini',
  'gpt54nano',
  'gpt54pro',
  'gpt52',
  'gpt51',
  'gpt5',
  'gpt5mini',
  'gpt5nano',
  'o3',
  'o4mini',
])

/** Date suffix used by snapshot model ids (`-20250929` or `@20250929`) */
const DATE_SUFFIX = /(?:19|20)\d{6}$/

/** Candidate keys for a normalized id, in the order they should be tried */
export function pricingCandidates(key: string): string[] {
  const out: string[] = []
  const alias = MODEL_ALIASES[key]
  if (alias) out.push(alias)
  if (DATE_SUFFIX.test(key)) {
    const trimmed = key.replace(DATE_SUFFIX, '')
    out.push(MODEL_ALIASES[trimmed] ?? trimmed)
  }
  for (const suffix of TIER_SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const trimmed = key.slice(0, -suffix.length)
      out.push(MODEL_ALIASES[trimmed] ?? trimmed)
    }
  }
  // Router-prefixed ids such as "group/auto-deepseek-v4.1-flash" or
  // "littlejochen/cn:deepseek-v4.1-flash" name the same official model.
  for (const prefix of ROUTE_PREFIXES) {
    if (key.length > prefix.length && key.startsWith(prefix)) {
      const stripped = key.slice(prefix.length)
      if (stripped) out.push(MODEL_ALIASES[stripped] ?? stripped)
    }
  }
  return out
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : 0
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }
  return 0
}

const PER_MILLION = 1_000_000

function entryFromCost(raw: unknown): PricingEntry | null {
  const cost = asRecord(raw)
  if (!cost) return null
  const input = num(cost.input)
  const output = num(cost.output)
  // models.dev omits cache prices on several families; its own convention (and
  // the one ccusage follows) is cache write = input × 1.25, cache read = input × 0.1.
  // The scan exposes one cache-write bucket, so a 1h write cannot be split out
  // and is priced at the 5m/default rate rather than guessed at input × 2.
  const cacheRead = cost.cache_read == null ? input * 0.1 : num(cost.cache_read)
  const cacheWrite = cost.cache_write == null ? input * 1.25 : num(cost.cache_write)
  const entry: PricingEntry = {
    i: input / PER_MILLION,
    o: output / PER_MILLION,
    r: cacheRead / PER_MILLION,
    w: cacheWrite / PER_MILLION,
  }
  const tiers: PricingTier[] = []
  if (Array.isArray(cost.tiers)) {
    for (const rawTier of cost.tiers) {
      const tier = asRecord(rawTier)
      const meta = asRecord(tier?.tier)
      if (!tier || !meta || meta.type !== 'context') continue
      const size = num(meta.size)
      if (size <= 0) continue
      const tierInput = tier.input == null ? input : num(tier.input)
      const tierCacheRead = tier.cache_read == null ? tierInput * 0.1 : num(tier.cache_read)
      const tierCacheWrite = tier.cache_write == null ? tierInput * 1.25 : num(tier.cache_write)
      tiers.push({
        threshold: size,
        i: tierInput / PER_MILLION,
        o: (tier.output == null ? output : num(tier.output)) / PER_MILLION,
        r: tierCacheRead / PER_MILLION,
        w: tierCacheWrite / PER_MILLION,
      })
    }
    tiers.sort((a, b) => a.threshold - b.threshold)
  }
  if (tiers.length > 0) entry.tiers = tiers
  return entry
}

function isZeroEntry(entry: PricingEntry): boolean {
  return entry.i === 0 && entry.o === 0 && entry.r === 0 && entry.w === 0
}

/**
 * Insert one entry without letting a later zero-priced listing (the common
 * shape of coding-plan entries) overwrite a real price; otherwise the first
 * storefront in preference order wins.
 */
function putEntry(map: Map<string, PricingEntry>, key: string, entry: PricingEntry): void {
  if (!key) return
  const existing = map.get(key)
  if (!existing || (isZeroEntry(existing) && !isZeroEntry(entry))) map.set(key, entry)
}

/** Strip a trailing date from a normalized key so undated log ids match */
function baseKey(key: string): string {
  return DATE_SUFFIX.test(key) ? key.replace(DATE_SUFFIX, '') : ''
}

/**
 * Project the models.dev provider map onto official vendor storefronts.
 *
 * The remote catalogue contains reseller and coding-plan listings under the
 * same model name; accepting those by name makes a cheap or zero listing
 * overwrite the vendor's real price. Only the vendors' own stores are read,
 * and only model ids that belong to the vendor's family.
 */
export function buildModelsFromModelsDev(root: unknown): Map<string, PricingEntry> {
  const providers = asRecord(root)
  const map = new Map<string, PricingEntry>()
  if (!providers) return map

  for (const official of OFFICIAL_VENDORS) {
    for (const store of official.stores) {
      const provider = asRecord(providers[store])
      const models = asRecord(provider?.models)
      if (!models) continue
      for (const [fallbackId, rawModel] of Object.entries(models)) {
        const model = asRecord(rawModel)
        if (!model) continue
        const id = typeof model.id === 'string' && model.id ? model.id : fallbackId
        const key = normalizeModelId(id)
        if (!key || !official.prefixes.some((prefix) => key.startsWith(prefix))) continue
        const entry = entryFromCost(model.cost)
        if (!entry) continue
        putEntry(map, key, entry)
        const base = baseKey(key)
        if (base) putEntry(map, base, entry)
      }
    }
  }
  return map
}

/** Build the fallback table from OpenRouter's `/api/v1/models` response */
export function buildModelsFromOpenRouter(root: unknown): Map<string, PricingEntry> {
  const map = new Map<string, PricingEntry>()
  const data = asRecord(root)?.data
  if (!Array.isArray(data)) return map

  for (const rawModel of data) {
    const model = asRecord(rawModel)
    if (!model || typeof model.id !== 'string') continue
    const pricing = asRecord(model.pricing)
    if (!pricing) continue
    const input = num(pricing.prompt)
    const output = num(pricing.completion)
    const key = normalizeModelId(model.id)
    if (!key) continue
    const entry: PricingEntry = {
      i: input,
      o: output,
      r: pricing.input_cache_read == null ? input * 0.1 : num(pricing.input_cache_read),
      w: pricing.input_cache_write == null ? input * 1.25 : num(pricing.input_cache_write),
    }
    if (Array.isArray(pricing.overrides)) {
      const tiers: PricingTier[] = []
      for (const rawTier of pricing.overrides) {
        const tier = asRecord(rawTier)
        const threshold = num(tier?.min_prompt_tokens)
        if (!tier || threshold <= 0) continue
        const tierInput = tier.prompt == null ? input : num(tier.prompt)
        tiers.push({
          threshold,
          i: tierInput,
          o: tier.completion == null ? output : num(tier.completion),
          r: tier.input_cache_read == null ? tierInput * 0.1 : num(tier.input_cache_read),
          w: tier.input_cache_write == null ? tierInput * 1.25 : num(tier.input_cache_write),
        })
      }
      tiers.sort((a, b) => a.threshold - b.threshold)
      if (tiers.length > 0) entry.tiers = tiers
    }
    putEntry(map, key, entry)
    const base = baseKey(key)
    if (base) putEntry(map, base, entry)
  }
  return map
}

/** Look up one model in a table, trying alias/date/tier candidates in order */
export function findPricingEntry(table: PricingTable, modelId: string): PricingEntry | null {
  const key = normalizeModelId(modelId)
  const direct = table.models.get(key)
  if (direct) return direct
  for (const candidate of pricingCandidates(key)) {
    const entry = table.models.get(candidate)
    if (entry) return entry
  }
  return null
}

function rateAt(entry: PricingEntry, contextTokens: number): PricingTier | PricingEntry {
  if (!entry.tiers || entry.tiers.length === 0) return entry
  let rate: PricingTier | PricingEntry = entry
  for (const tier of entry.tiers) {
    if (contextTokens > tier.threshold) rate = tier
  }
  return rate
}

/**
 * Price one model's token counts; null when the model is unknown.
 *
 * Long-context tiers switch the whole request to the tier rate once the
 * context (input + cache buckets) crosses the threshold. The scan payload only
 * aggregates token counts per day and model, so a tier is only safe when that
 * aggregate is a single message (one request); summing many small requests
 * overstates the context and would bill the whole day at the tier rate.
 * A `-free` model is free by definition.
 */
export function priceTokens(
  table: PricingTable,
  modelId: string,
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  messageCount?: number,
): number | null {
  const key = normalizeModelId(modelId)
  if (key.endsWith('free')) return 0
  let lookup = key
  let speed = 1
  if (key.endsWith('fast')) {
    const base = key.slice(0, -4)
    const multiplier = fastMultiplier(base)
    if (multiplier == null) return null
    lookup = base
    speed = multiplier
  } else if (key.endsWith('flex')) {
    const base = key.slice(0, -4)
    if (!FLEX_MODELS.has(base)) return null
    lookup = base
    speed = 0.5
  }
  const entry = findPricingEntry(table, lookup)
  if (!entry) return null
  const input = num(tokens.input)
  const output = num(tokens.output)
  const cacheRead = num(tokens.cacheRead)
  const cacheWrite = num(tokens.cacheWrite)
  const rate = messageCount === 1 ? rateAt(entry, input + cacheRead + cacheWrite) : entry
  return (input * rate.i + output * rate.o + cacheRead * rate.r + cacheWrite * rate.w) * speed
}
