import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * CodeBuddy CN IDE (`codebuddy`) local usage reader.
 *
 * tokscale only scans the CodeBuddy CLI transcripts (`~/.codebuddy/projects`,
 * Claude-Code-shaped jsonl — covered by `TOKSCALE_CLIENTS` in electron/main.ts).
 * The CN IDE keeps its chat somewhere else entirely: one JSON file per message
 * under `%LOCALAPPDATA%/CodeBuddyExtension/Data/<userId>/CodeBuddyIDE/<userId>/
 * history/<workspaceHash>/<conversationId>/messages/<messageId>.json`, and that
 * store is what a CN install actually accumulates usage in. This module reads
 * it and emits a payload shaped like a `tokscale graph` result, which the main
 * process merges into the scan unconditionally: tokscale's reader covers only
 * the CLI transcripts under `~/.codebuddy/projects`, so the two stores are
 * disjoint by origin and a user running both the CLI and the IDE gets both
 * halves counted (see the `mergeAlways` note in electron/main.ts).
 *
 * Message files carry `{ id, role, message, extra, createdAt }` where `message`
 * and `extra` are themselves JSON strings. Only assistant messages with an
 * `extra.statsSnapshot` contribute usage:
 *   `statsSnapshot.inputTokens`  = total prompt tokens (cache included)
 *   `cachedInputTokens`          = cache-hit portion of the prompt
 *   `cacheMissTokens`            = uncached prompt portion
 *   `cacheWriteTokens`           = prompt cache writes
 *   `outputTokens`               = completion tokens
 *   `credit`                     = CN subscription credits burned by the call
 * The aggregation maps cache-read/cache-write explicitly so the dashboard's
 * cache column stays meaningful; `credit` has no tokscale-graph slot and is
 * intentionally dropped here (tokens only).
 *
 * Privacy: only token counters and model ids are read. Message bodies (the
 * `message` string) are never parsed or touched.
 */

/** Client id this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts) */
const CLIENT_ID = 'codebuddy'

/** Fallback gateway owner, used when a model name identifies no vendor */
const PROVIDER_ID = 'tencent'

/**
 * Gateway owner of a bare model name.
 *
 * CodeBuddy CN reports the model without a vendor prefix (`MiniMax-M2.5`), so
 * the provider has to be inferred from the name — the same thing tokscale's own
 * `inferred_provider_from_model` does. Without it every CN IDE entry lands under
 * the `tencent` gateway id while the CLI half of the same account lands under
 * the real vendor, and one account's usage shows up as two providers in the
 * cost breakdown.
 */
function inferProvider(model: string): string {
  const name = model.toLowerCase()
  if (name.startsWith('minimax')) return 'minimax'
  if (name.startsWith('glm') || name.startsWith('zai') || name.startsWith('z-ai')) return 'zhipu'
  if (name.startsWith('deepseek')) return 'deepseek'
  if (name.startsWith('kimi') || name.startsWith('moonshot')) return 'moonshot'
  if (name.startsWith('claude')) return 'anthropic'
  if (name.startsWith('gpt') || name.startsWith('o1') || name.startsWith('o3')) return 'openai'
  if (name.startsWith('gemini')) return 'google'
  if (name.startsWith('qwen')) return 'qwen'
  if (name.startsWith('grok')) return 'xai'
  return PROVIDER_ID
}

/** `vendor/model` → provider + model; a bare id is inferred from its name */
function splitVendorModel(model: string): { providerId: string; modelId: string } {
  const slash = model.indexOf('/')
  if (slash <= 0) return { providerId: inferProvider(model), modelId: model }
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) }
}

/** Extension root relative to LOCALAPPDATA (falls back to home/AppData/Local) */
const EXTENSION_REL = ['CodeBuddyExtension', 'Data'] as const

/** IDE product segment inside `Data/<userId>/` */
const IDE_SEGMENT = 'CodeBuddyIDE'

/** Walk guard for the history/workspace/conversation descent */
const MAX_WALK_DEPTH = 6

/** Skip absurdly large payloads (real message files are a few KB) */
const MAX_FILE_BYTES = 8 * 1024 * 1024

interface UsageRecord {
  tsMs: number
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface Slice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
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

/** Local calendar day, matching the renderer's `todayKey()` bucketing */
function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Usage counters of one message file, or null when it carries none. Only
 * messages with a `statsSnapshot` ever had a model call behind them; helper
 * and user messages are skipped without touching their bodies.
 */
function readCounters(extra: Record<string, unknown>): Omit<UsageRecord, 'tsMs' | 'modelId'> | null {
  const snapshot = asRecord(extra.statsSnapshot)
  if (!snapshot) return null
  const totalInput = num(snapshot.inputTokens)
  const cacheRead = num(snapshot.cachedInputTokens)
  const miss = num(snapshot.cacheMissTokens)
  // inputTokens = cached + miss; when the miss field is absent derive it so
  // the uncached column never double-counts the cache-hit portion.
  const input = miss > 0 ? miss : Math.max(0, totalInput - cacheRead)
  const output = num(snapshot.outputTokens)
  const cacheWrite = num(snapshot.cacheWriteTokens)
  if (input + output + cacheRead + cacheWrite === 0) return null
  return { input, output, cacheRead, cacheWrite }
}

/**
 * Conversation dirs are the `history/<ws>/<conv>` leaves that hold a
 * `messages` directory; the userId level above `CodeBuddyIDE` is scanned
 * rather than assumed so a second account on one machine still counts.
 */
async function collectConversationDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = new Set(entries.map((e) => e.name))
  // Conversation leaves (`history/<ws>/<conv>`) hold both an index.json and
  // the messages dir; the levels above (workspace, account) are descended.
  if (names.has('messages') && names.has('index.json')) return [root]
  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    dirs.push(...(await collectConversationDirs(join(root, entry.name), depth + 1)))
  }
  return dirs
}

/** Parse one message file into a usage record, or null */
async function readMessageFile(path: string): Promise<UsageRecord | null> {
  let raw: string
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const file = asRecord(parsed)
  if (!file) return null
  const extraRaw = str(file.extra)
  if (!extraRaw) return null
  let extraParsed: unknown
  try {
    extraParsed = JSON.parse(extraRaw)
  } catch {
    return null
  }
  const extra = asRecord(extraParsed)
  if (!extra) return null
  const counters = readCounters(extra)
  if (!counters) return null
  const tsMs = Date.parse(str(file.createdAt))
  if (!Number.isFinite(tsMs)) return null
  return { tsMs, modelId: str(extra.modelId) || 'unknown', ...counters }
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
    const { providerId, modelId } = splitVendorModel(record.modelId)
    const key = `${providerId}\u0000${modelId}`
    const hit = slices.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
    hit.input += record.input
    hit.output += record.output
    hit.cacheRead += record.cacheRead
    hit.cacheWrite += record.cacheWrite
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
        const total = slice.input + slice.output + slice.cacheRead + slice.cacheWrite
        totals.tokens += total
        totals.messages += slice.messages
        tokenBreakdown.input += slice.input
        tokenBreakdown.output += slice.output
        tokenBreakdown.cacheRead += slice.cacheRead
        tokenBreakdown.cacheWrite += slice.cacheWrite
        // cost 0 on purpose: no local price is recorded, so the main process
        // prices these entries from the OpenRouter catalog like every other one.
        return { client: CLIENT_ID, modelId, providerId, tokens, cost: 0, messages: slice.messages }
      })
      return { date, totals, tokenBreakdown, clients, intensity: 0, activeTimeMs: 0 }
    })

  // `totals` is summed from the very entries above so the renderer's
  // "unclassified" derivation (totals − Σclients) stays exactly zero.
  return { meta: null, contributions }
}

/**
 * Read CodeBuddy CN IDE usage into a `tokscale graph`-shaped payload.
 *
 * Best-effort by contract — a missing store, an unreadable file or a directory
 * being rewritten mid-read must never affect the scan. Returns null when the
 * IDE has no recorded usage (or is not installed).
 */
export async function readCodeBuddyUsage(home: string): Promise<unknown | null> {
  try {
    const localBase = process.env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local')
    const dataRoot = join(localBase, ...EXTENSION_REL)
    const userIds = await readdir(dataRoot, { withFileTypes: true }).catch(() => [])
    const records: UsageRecord[] = []
    for (const userId of userIds) {
      if (!userId.isDirectory()) continue
      // Data/<userId>/CodeBuddyIDE/<userId>/history — the second id level is
      // scanned rather than assumed so account switches still resolve.
      const ideRoots = await readdir(join(dataRoot, userId.name, IDE_SEGMENT), { withFileTypes: true }).catch(() => [])
      for (const ideRoot of ideRoots) {
        if (!ideRoot.isDirectory()) continue
        const historyRoot = join(dataRoot, userId.name, IDE_SEGMENT, ideRoot.name, 'history')
        const convDirs = await collectConversationDirs(historyRoot)
        for (const convDir of convDirs) {
          const messagesDir = join(convDir, 'messages')
          const files = await readdir(messagesDir, { withFileTypes: true }).catch(() => [])
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue
            const record = await readMessageFile(join(messagesDir, file.name))
            if (record) records.push(record)
          }
        }
      }
    }
    return records.length > 0 ? buildPayload(records) : null
  } catch {
    return null
  }
}
