import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Cindy (`cindy`) local usage reader.
 *
 * Cindy runs its coding agent on Pi, but with its own agent home:
 * `<Cindy userData>/pi-agent-home` instead of `~/.pi`. tokscale's native `pi`
 * client only scans `~/.pi/agent/sessions`, so a Cindy user's usage never
 * reaches the dashboard — and asking the CLI for a `cindy` client would only
 * add an empty payload. This module reads the agent home directly and emits a
 * payload shaped like a `tokscale graph` result, which the main process merges
 * into the scan.
 *
 * Store layout (verified against Cindy 1.0.x on Windows):
 *   - `<Cindy userData>/pi-agent-home/sessions/**\/*.jsonl` — chat sessions,
 *     flat or grouped by working directory depending on how the run was launched
 *   - `<Cindy userData>/pi-agent-home/runtime/pi-subagent-runs/**\/*.jsonl` —
 *     the session transcripts of delegated subagent runs
 * Both live under the same agent home, so the walk starts there and every
 * candidate file is gated on the pi session header (see
 * `parseSessionTranscript`): other `.jsonl` files that happen to sit in the
 * agent home are not usage and must never be summed.
 *
 * Usage is recorded per entry, the same way Pi accounts for a session:
 *   - `message` entries whose `message.role` is `assistant` carry
 *     `message.usage` = `{ input, output, cacheRead, cacheWrite, cost.total }`
 *     alongside `message.model` / `message.provider`
 *   - `usage` entries (e.g. cache warming) carry the same object and no message
 *   - `compaction` / `branch_summary` entries carry the usage of the summary
 *     generation; they name no model, so they are attributed to the model that
 *     last answered in the same transcript
 * The message `reasoning` counter is a subset of `output` in Pi's accounting
 * and has no slot in the graph shape, so it is not added on top.
 *
 * Forked / cloned sessions copy their branch entries, entry ids included, so
 * records are deduplicated by entry id: the generation happened once and must
 * be counted once no matter how many transcripts replay it.
 *
 * Privacy: only token counters, the cost figure, model/provider ids and
 * timestamps are read. Prompt, response, thinking and tool content are never
 * parsed — lines are skipped unless they can carry usage.
 */

/** Client id this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts) */
const CLIENT_ID = 'cindy'

/** Fallback provider id for a bare model name with no vendor prefix */
const VENDOR_PROVIDER = 'cindy'

/** Agent home inside the app's userData directory */
const AGENT_HOME = 'pi-agent-home'

/**
 * Recursion guard for the agent-home walk. Real depths are 2 (flat sessions),
 * 3 (sessions/<cwd>/…, runtime/pi-subagent-runs/<task>/…) and 4 at most.
 */
const MAX_WALK_DEPTH = 8

/** Skip absurdly large transcripts (real ones stay well below this) */
const MAX_FILE_BYTES = 64 * 1024 * 1024

interface UsageRecord {
  /**
   * Entry id from the transcript. Fork/clone copies replay the same entries, so
   * this is what keeps one generation from being counted twice.
   */
  key: string
  tsMs: number
  providerId: string
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

interface Slice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  messages: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** First numeric value among `keys` — layouts spell the counters differently */
function numFrom(rec: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return 0
}

/** Local calendar day, matching the renderer's `todayKey()` bucketing */
function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Vendor prefixes Cindy's gateway uses that spell a provider differently than
 * the ids the rest of the dashboard already has in its distribution: one
 * vendor must own one row, so `moonshotai/kimi-k3.1-pro` lands under the same
 * `moonshot` slice as Kimi Code's own sessions.
 */
const VENDOR_PROVIDER_ALIASES: Record<string, string> = {
  moonshotai: 'moonshot',
  'z-ai': 'zhipu',
}

/**
 * Provider id for a Pi provider field. `custom_provider:<name>` routing
 * prefixes are stripped, and the ChatGPT-subscription channel collapses onto
 * its vendor so one account cannot split across two rows of the provider
 * distribution.
 */
function normalizeProvider(raw: string): string {
  const stripped = raw.replace(/^custom_provider:/, '').trim()
  if (!stripped) return VENDOR_PROVIDER
  if (stripped === 'openai-codex' || stripped === 'chatgpt') return 'openai'
  return VENDOR_PROVIDER_ALIASES[stripped] ?? stripped
}

/**
 * `vendor/model` → provider + model. Pi records gateway models with their
 * vendor prefix (`deepseek/deepseek-v4-flash`, `moonshotai/kimi-k3.1-pro`), so
 * the prefix names the real vendor; a bare id keeps the channel provider.
 */
function splitVendorModel(model: string, provider: string): { providerId: string; modelId: string } {
  const slash = model.indexOf('/')
  if (slash <= 0) return { providerId: normalizeProvider(provider), modelId: model }
  const prefix = model.slice(0, slash).trim()
  return {
    providerId: prefix ? (VENDOR_PROVIDER_ALIASES[prefix] ?? prefix) : normalizeProvider(provider),
    modelId: model.slice(slash + 1),
  }
}

/** Token counters and recorded cost of one `usage` object, or null when empty */
function readUsage(
  raw: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number } | null {
  const usage = asRecord(raw)
  if (!usage) return null
  const input = numFrom(usage, 'input', 'input_tokens', 'inputTokens')
  const output = numFrom(usage, 'output', 'output_tokens', 'outputTokens')
  const cacheRead = numFrom(usage, 'cacheRead', 'cache_read', 'cache_read_tokens', 'cacheReadInputTokens')
  const cacheWrite = numFrom(
    usage,
    'cacheWrite',
    'cache_write',
    'cache_write_tokens',
    'cacheCreationInputTokens',
  )
  // Pi's own USD figure for the generation. Catalog repricing in the main
  // process still wins where it knows the model; this is the fallback for
  // gateway-only models the catalog has never heard of.
  const cost = asRecord(usage.cost)
  const costUsd = cost ? numFrom(cost, 'total', 'totalUsd') : numFrom(usage, 'cost', 'costUsd')
  if (input + output + cacheRead + cacheWrite === 0) return null
  return { input, output, cacheRead, cacheWrite, costUsd }
}

/** Entry timestamp: the nested message stamp (epoch ms) wins over the ISO one */
function entryTsMs(entry: Record<string, unknown>, message: Record<string, unknown> | null): number {
  const messageTs = num(message?.timestamp)
  if (messageTs > 0) return messageTs
  const raw = entry.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * Parse one Pi session transcript into usage records.
 *
 * Returns null when the file is not a Pi session: the first line must be the
 * `session` header Pi writes before anything else. That gate is what keeps
 * unrelated `.jsonl` files inside the agent home out of the totals.
 *
 * Exported for unit tests; the reader below is the only production caller.
 */
export function parseSessionTranscript(text: string, source = ''): UsageRecord[] | null {
  const lines = text.split('\n')
  let header: Record<string, unknown> | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      header = asRecord(JSON.parse(trimmed))
    } catch {
      header = null // torn first line: not a readable session
    }
    break
  }
  if (!header || str(header.type) !== 'session') return null

  const records: UsageRecord[] = []
  // The model that last answered in this transcript. Compaction and branch
  // summaries bill a generation but name no model, so this is their only
  // honest attribution.
  let lastModel = ''
  let lastProvider = ''

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    // Cheap pre-filter: only entries carrying usage, or a model switch, can
    // change what this transcript contributes. Content lines are never parsed.
    if (!trimmed.includes('"usage"') && !trimmed.includes('"model_change"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // torn trailing line while the agent appends
    }
    const entry = asRecord(parsed)
    if (!entry) continue
    const type = str(entry.type)
    const key = str(entry.id) || `${source}:line:${index}`

    if (type === 'model_change') {
      const model = str(entry.modelId) || str(entry.model)
      if (model) lastModel = model
      const provider = str(entry.provider)
      if (provider) lastProvider = provider
      continue
    }

    if (type === 'message') {
      const message = asRecord(entry.message)
      if (!message || str(message.role) !== 'assistant') continue
      const counters = readUsage(message.usage)
      if (!counters) continue
      const model = str(message.model)
      const provider = str(message.provider)
      if (model) lastModel = model
      if (provider) lastProvider = provider
      const tsMs = entryTsMs(entry, message)
      if (tsMs <= 0) continue
      records.push({
        key,
        tsMs,
        providerId: lastProvider,
        modelId: lastModel || 'unknown',
        ...counters,
      })
      continue
    }

    // Usage outside the message list: cache warming, compaction summaries and
    // branch summaries. Pi's own session totals include them, so the dashboard
    // must too.
    if (type === 'usage' || type === 'compaction' || type === 'branch_summary') {
      const counters = readUsage(entry.usage)
      if (!counters) continue
      const model = str(entry.model) || lastModel
      const provider = str(entry.provider) || lastProvider
      const tsMs = entryTsMs(entry, null)
      if (tsMs <= 0) continue
      records.push({
        key,
        tsMs,
        providerId: provider,
        modelId: model || 'unknown',
        ...counters,
      })
    }
  }
  return records
}

/** Fold the flat records into `tokscale graph`-shaped contributions */
function buildPayload(records: UsageRecord[]): unknown {
  // Grouped by provider AND model: two vendors can serve the same model name,
  // and the cost breakdown attributes by provider.
  const days = new Map<string, Map<string, Slice>>()
  for (const record of records) {
    const day = localDay(record.tsMs)
    let slices = days.get(day)
    if (!slices) {
      slices = new Map()
      days.set(day, slices)
    }
    const { providerId, modelId } = splitVendorModel(record.modelId, record.providerId)
    const key = `${providerId}\u0000${modelId}`
    const hit = slices.get(key) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      messages: 0,
    }
    hit.input += record.input
    hit.output += record.output
    hit.cacheRead += record.cacheRead
    hit.cacheWrite += record.cacheWrite
    hit.costUsd += record.costUsd
    hit.messages += 1
    slices.set(key, hit)
  }

  const contributions = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, slices]) => {
      const totals = { tokens: 0, cost: 0, messages: 0 }
      const tokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const clients = [...slices.entries()].map(([key, slice]) => {
        const [providerId, modelId] = key.split('\u0000')
        const tokens = {
          input: slice.input,
          output: slice.output,
          cacheRead: slice.cacheRead,
          cacheWrite: slice.cacheWrite,
        }
        // Rounded to the micro-dollar the graph shape uses, then summed into
        // the day total: the day cost must be exactly the sum of its entries,
        // because the main process folds its repricing delta back into
        // `totals.cost` on that assumption.
        const cost = Math.round(slice.costUsd * 1e6) / 1e6
        totals.tokens += slice.input + slice.output + slice.cacheRead + slice.cacheWrite
        totals.messages += slice.messages
        totals.cost += cost
        tokenBreakdown.input += slice.input
        tokenBreakdown.output += slice.output
        tokenBreakdown.cacheRead += slice.cacheRead
        tokenBreakdown.cacheWrite += slice.cacheWrite
        return {
          client: CLIENT_ID,
          modelId,
          providerId,
          tokens,
          cost,
          messages: slice.messages,
        }
      })
      return { date, totals, tokenBreakdown, clients, intensity: 0, activeTimeMs: 0 }
    })

  // `totals` is summed from the very entries above so the renderer's
  // "unclassified" derivation (totals − Σclients) stays exactly zero.
  return { meta: null, contributions }
}

/** Collect every `.jsonl` under the agent home (bounded depth, best-effort) */
async function collectSessionFiles(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return out
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Package caches inside the agent home hold thousands of files and never
      // hold sessions; skipping them keeps the walk shallow and fast.
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await collectSessionFiles(join(root, entry.name), depth + 1, out)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(join(root, entry.name))
    }
  }
  return out
}

/** Whole transcript text, or null when the file cannot be read as one */
async function readSessionText(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Read Cindy's Pi sessions into a `tokscale graph`-shaped payload.
 *
 * `cindyUserData` is Cindy's own Electron userData directory
 * (`%APPDATA%/Cindy` on Windows) — the caller resolves it, this module never
 * guesses an install path. It is deliberately not this app's userData: the two
 * applications keep separate homes.
 *
 * Best-effort by contract — a missing agent home, an unreadable file or a
 * transcript being appended mid-read must never affect the scan. Returns null
 * when Cindy has recorded no usage (or was never run on this machine).
 */
export async function readCindyUsage(cindyUserData: string): Promise<unknown | null> {
  try {
    const root = join(cindyUserData, AGENT_HOME)
    const files = await collectSessionFiles(root)
    const records: UsageRecord[] = []
    const seen = new Set<string>()
    for (const file of files) {
      const text = await readSessionText(file)
      if (text == null) continue
      const parsed = parseSessionTranscript(text, file)
      if (!parsed) continue
      for (const record of parsed) {
        // Same generation replayed by a fork/clone of the session: keep the
        // first, drop the copy.
        if (seen.has(record.key)) continue
        seen.add(record.key)
        records.push(record)
      }
    }
    return records.length > 0 ? buildPayload(records) : null
  } catch {
    return null
  }
}
