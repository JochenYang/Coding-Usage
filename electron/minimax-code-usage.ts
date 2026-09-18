import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * MiniMax Code (`mcode`) local usage reader.
 *
 * tokscale ships no session-file reader for MiniMax Code: its `mcode` client
 * only supports headless capture (`%APPDATA%\tokscale\headless\mcode`,
 * `~/.config/tokscale/headless/mcode`, `~/Library/Application Support/tokscale/
 * headless/mcode`), so `tokscale graph --client mcode` reports zero even after
 * heavy use. This module reads the agent's own session store and emits a payload
 * shaped exactly like a `tokscale graph` result, which the main process merges
 * into the scan with `mergeGraphPayloads`.
 *
 * Layout (verified against MiniMax Code 0.4.x): one directory per session under
 * `<home>/.minimax/v2/sessions/<YYYY>/<MM>/<DD>/<HH-MM-SS-mmm>-<sessionId>/`,
 * carrying usage in one of two mutually exclusive files —
 *   - `ledger.jsonl`   (older): `kind == 'message.pi_history_appended'` events
 *     whose `messages[]` hold assistant entries with `usage`
 *   - `messages.jsonl` (newer): one `{ message_id, turn_id, message }` per line
 * `<home>/.mavis` is a symlink to `.minimax`; only the canonical path is scanned
 * so no session can be counted twice.
 *
 * Privacy: only token counters are read. Message bodies (`message.content`,
 * tool-call results, thinking blocks) are never touched.
 */

/** Session root relative to the home directory (canonical path only) */
const SESSIONS_REL = ['.minimax', 'v2', 'sessions'] as const

/** Client id this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts) */
const CLIENT_ID = 'mcode'

/** Recursion guard for the session-tree walk (root→year→month→day→session) */
const MAX_WALK_DEPTH = 6

/** Skip absurdly large payloads (the biggest real file today is ~330 KB) */
const MAX_FILE_BYTES = 64 * 1024 * 1024

interface UsageRecord {
  tsMs: number
  modelId: string
  providerId: string
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

/** First numeric value among `keys` — the two layouts spell the counters differently */
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

/** Provider id without MiniMax's synthetic `custom_provider:` routing prefix */
function normalizeProvider(raw: string): string {
  const stripped = raw.replace(/^custom_provider:/, '').trim()
  return stripped || 'minimax'
}

/** Token counters of one `usage` object, or null when it carries no usage at all */
function readCounters(usage: Record<string, unknown>): Omit<UsageRecord, 'tsMs' | 'modelId' | 'providerId'> | null {
  const input = numFrom(usage, 'input', 'input_tokens', 'inputTokens')
  const output = numFrom(usage, 'output', 'output_tokens', 'outputTokens')
  const cacheRead = numFrom(usage, 'cacheRead', 'cache_read', 'cache_read_tokens', 'cacheReadTokens')
  const cacheWrite = numFrom(usage, 'cacheWrite', 'cache_write', 'cache_write_tokens', 'cacheWriteTokens')
  if (input + output + cacheRead + cacheWrite === 0) return null
  return { input, output, cacheRead, cacheWrite }
}

/** Push one assistant record, deduplicated by `key` */
function pushRecord(
  out: UsageRecord[],
  seen: Set<string>,
  key: string,
  message: Record<string, unknown>,
  event: Record<string, unknown>,
  counters: Omit<UsageRecord, 'tsMs' | 'modelId' | 'providerId'>,
): void {
  if (seen.has(key)) return
  seen.add(key)
  out.push({
    tsMs: num(message.timestamp) || num(event.createdAtMs),
    modelId: str(message.model) || 'unknown',
    providerId: normalizeProvider(str(message.provider)),
    ...counters,
  })
}

/** Layout A: `ledger.jsonl` — assistant entries inside pi-history events */
function readLedger(text: string, sessionKey: string, out: UsageRecord[], seen: Set<string>): void {
  for (const line of text.split('\n')) {
    // Cheap pre-filter: only pi-history events can carry assistant usage.
    if (!line.includes('"message.pi_history_appended"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // torn trailing line while the agent appends
    }
    const event = asRecord(parsed)
    if (!event || event.kind !== 'message.pi_history_appended') continue
    const messages = Array.isArray(event.messages) ? event.messages : []
    for (const raw of messages) {
      const message = asRecord(raw)
      if (!message || message.role !== 'assistant') continue
      const usage = asRecord(message.usage)
      if (!usage) continue
      const counters = readCounters(usage)
      if (!counters) continue
      pushRecord(out, seen, `${sessionKey}:${str(message.responseId) || num(message.timestamp)}`, message, event, counters)
    }
  }
}

/** Layout B: `messages.jsonl` — one assistant message per line */
function readMessages(text: string, sessionKey: string, out: UsageRecord[], seen: Set<string>): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // torn trailing line while the agent appends
    }
    const event = asRecord(parsed)
    if (!event) continue
    const message = asRecord(event.message)
    if (!message || message.role !== 'assistant') continue
    const usage = asRecord(message.usage)
    if (!usage) continue
    const counters = readCounters(usage)
    if (!counters) continue
    const key = str(event.message_id) || str(event.turn_id)
    pushRecord(out, seen, `${sessionKey}:${key}`, message, event, counters)
  }
}

/** Every session directory under `root`; a directory holding a usage carrier is a leaf */
async function collectSessionDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = new Set(entries.map((e) => e.name))
  if (names.has('ledger.jsonl') || names.has('messages.jsonl')) return [root]

  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    dirs.push(...(await collectSessionDirs(join(root, entry.name), depth + 1)))
  }
  return dirs
}

async function readTextIfSane(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Fold the flat records into `tokscale graph`-shaped contributions */
function buildPayload(records: UsageRecord[]): unknown {
  const days = new Map<string, Map<string, Slice>>()
  for (const record of records) {
    const day = localDay(record.tsMs)
    let slices = days.get(day)
    if (!slices) {
      slices = new Map()
      days.set(day, slices)
    }
    // Provider first: the same model name can arrive through different routers.
    const key = `${record.providerId}\u0000${record.modelId}`
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
        // cost 0 on purpose: MiniMax Code records no cost, so the main process
        // prices these entries from the OpenRouter catalog like every other one.
        return { client: CLIENT_ID, modelId, providerId, tokens, cost: 0, messages: slice.messages }
      })
      return { date, totals, tokenBreakdown, clients, intensity: 0, activeTimeMs: 0 }
    })

  // `totals` is summed from the very entries above so the renderer's
  // "unclassified" derivation (totals − Σclients) stays exactly zero.
  return { meta: null, contributions }
}

/** Collect the usage records under one session root (empty when it holds none) */
async function collectRecords(root: string): Promise<UsageRecord[]> {
  const dirs = await collectSessionDirs(root)
  const records: UsageRecord[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    try {
      // One carrier per session: `ledger.jsonl` wins, `messages.jsonl` is the
      // newer layout. They never coexist, but the order makes that explicit.
      const ledger = await readTextIfSane(join(dir, 'ledger.jsonl'))
      if (ledger != null) {
        readLedger(ledger, dir, records, seen)
        continue
      }
      const messages = await readTextIfSane(join(dir, 'messages.jsonl'))
      if (messages != null) readMessages(messages, dir, records, seen)
    } catch {
      // one unreadable session must not stop the sweep
    }
  }
  return records
}

/**
 * Read MiniMax Code's local usage into a `tokscale graph`-shaped payload.
 *
 * `.minimax` is the directory the agent installs as; `.mavis` is its internal
 * name — every manifest records its session dir under `.mavis` — and which of
 * the two is the real directory (the other being a symlink) varies between
 * installs, so both are probed. The first root that yields usage wins, which
 * keeps a symlinked pair from ever being counted twice.
 *
 * Best-effort by contract — a missing store, an unreadable file or a directory
 * being rewritten mid-read must never affect the scan. Returns null when the
 * agent has no recorded usage (or is not installed).
 */
export async function readMiniMaxCodeUsage(home: string): Promise<unknown | null> {
  try {
    const roots = [join(home, ...SESSIONS_REL), join(home, '.mavis', 'v2', 'sessions')]
    for (const root of roots) {
      const records = await collectRecords(root)
      if (records.length > 0) return buildPayload(records)
    }
    return null
  } catch {
    return null
  }
}
