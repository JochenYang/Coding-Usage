import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Antigravity (`antigravity`) local usage reader.
 *
 * tokscale cannot read this agent on a machine that installed the IDE flavour:
 * its reader covers `~/.gemini/antigravity-cli/conversations/*.db`, and an IDE
 * install keeps its conversations under `~/.gemini/antigravity-ide/` instead
 * (verified: `graph --client antigravity` and `antigravity-cli` both return an
 * empty payload here while nine databases sit on disk). This module reads those
 * databases directly and emits a payload shaped like a `tokscale graph` result,
 * which the main process merges into the scan.
 *
 * Layout: `<home>/.gemini/<root>/conversations/<conversationId>.db`, one SQLite
 * database per conversation, each with a `gen_metadata` table holding one row
 * per model generation in a blob that is an **unlabeled protobuf** — Antigravity
 * publishes no schema. The field numbers below were recovered from the agent's
 * own descriptors and cross-checked against two independent readers
 * (tokscale's `antigravity-cli` parser and agent-walker's `agy_conv.rs`), which
 * agree on every number used here:
 *
 *   gen_metadata.data
 *     #1  chatModel (message)
 *           #4  usage (message)
 *                 #1  fixed system-prompt tokens (billable input)
 *                 #2  newly processed (non-cached) input tokens
 *                 #3  output total — MUST equal #9 + #10 (see below)
 *                 #5  cache-read tokens (present once a cached prefix exists)
 *                 #9  visible output tokens
 *                 #10 thinking tokens
 *                 #11 response id (dedup key; a retry repeats it)
 *           #9  #4 = { #1 seconds, #2 nanos } generation timestamp
 *           #19 internal model id (e.g. "gemini-3-flash-a")
 *           #21 display model name (e.g. "Gemini 3.5 Flash (High)")
 *
 * Because the numbers are unofficial and could shift when Antigravity changes,
 * every row is verified against the stored output total before it is counted:
 * `#3` must equal `#9 + #10`. A row that disagrees is dropped (the format
 * moved), and a row without `#3` cannot be verified so it is dropped too. The
 * check covers the output fields only — a silent re-meaning of an input field
 * (no stored input total exists to compare against) is the known residual risk.
 *
 * Privacy: only token counters, the model name and timestamps are read. Message
 * bodies live in other columns and are never touched.
 */

/** Conversation roots relative to the home directory, newest flavour first */
const SESSION_ROOTS = ['antigravity-ide', 'antigravity', 'antigravity-cli'] as const

/** Client id this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts) */
const CLIENT_ID = 'antigravity'

/** One conversation database holds a few thousand generations at most */
const MAX_DB_BYTES = 512 * 1024 * 1024

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

// ===== protobuf wire reader =====

interface WireField {
  field: number
  wire: number
  value: number
  bytes?: Buffer
}

/** Parse one message's fields; malformed input yields what was readable so far */
function readFields(buf: Buffer): WireField[] {
  const out: WireField[] = []
  let i = 0
  while (i < buf.length) {
    let shift = 0
    let tag = 0
    while (i < buf.length) {
      const byte = buf[i++]
      tag |= (byte & 0x7f) << shift
      shift += 7
      if (!(byte & 0x80)) break
    }
    if (shift > 35 || tag === 0) break
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      let value = 0
      shift = 0
      while (i < buf.length) {
        const byte = buf[i++]
        value |= (byte & 0x7f) << shift
        shift += 7
        if (!(byte & 0x80)) break
      }
      out.push({ field, wire, value })
    } else if (wire === 2) {
      let len = 0
      shift = 0
      while (i < buf.length) {
        const byte = buf[i++]
        len |= (byte & 0x7f) << shift
        shift += 7
        if (!(byte & 0x80)) break
      }
      if (len < 0 || i + len > buf.length) break
      out.push({ field, wire, value: len, bytes: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 1) {
      i += 8
    } else if (wire === 5) {
      i += 4
    } else {
      break // unknown wire type: the rest is unreliable
    }
  }
  return out
}

const msgField = (fields: WireField[], n: number): WireField[] | null => {
  const hit = fields.find((f) => f.field === n && f.bytes)
  return hit?.bytes ? readFields(hit.bytes) : null
}

const numField = (fields: WireField[], n: number): number => {
  const hit = fields.find((f) => f.field === n && f.bytes === undefined)
  return hit ? hit.value : 0
}

const strField = (fields: WireField[], n: number): string => {
  const hit = fields.find((f) => f.field === n && f.bytes)
  return hit?.bytes ? hit.bytes.toString('utf8') : ''
}

/** `#9.#4` = { seconds, nanos } → epoch ms, or 0 when absent */
function readTimestamp(fields: WireField[]): number {
  const stamp = msgField(fields, 9)
  const inner = stamp ? msgField(stamp, 4) : null
  if (!inner) return 0
  const seconds = numField(inner, 1)
  const nanos = numField(inner, 2)
  return seconds > 0 ? seconds * 1000 + Math.floor(nanos / 1e6) : 0
}

// ===== row parsing =====

/** Local calendar day, matching the renderer's `todayKey()` bucketing */
function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface ParseOutcome {
  record?: UsageRecord
  /** Rows whose field layout disagreed with the verified map */
  drifted: boolean
}

function parseGeneration(blob: Buffer, fallbackMs: number): ParseOutcome {
  const chat = msgField(readFields(blob), 1)
  const usage = chat ? msgField(chat, 4) : null
  if (!chat || !usage) return { drifted: false }

  const input = numField(usage, 1) + numField(usage, 2)
  const outputText = numField(usage, 9)
  const thinking = numField(usage, 10)
  const total = numField(usage, 3)
  // The only stored total is the output one; without it the row is unverifiable
  if (total === 0 && outputText === 0 && thinking === 0) return { drifted: false }
  if (total === 0) return { drifted: false }
  if (total !== outputText + thinking) return { drifted: true }

  // Display name reads better and prices correctly once the tier suffix is
  // dropped (see the pricing note in main.ts); the internal id is the fallback.
  const display = strField(chat, 21) || strField(chat, 19) || 'unknown'
  const modelId = display.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'unknown'
  return {
    drifted: false,
    record: {
      tsMs: readTimestamp(chat) || fallbackMs,
      modelId,
      input,
      output: outputText + thinking,
      cacheRead: numField(usage, 5),
      cacheWrite: 0,
    },
  }
}

// ===== database walk =====

async function listConversationDbs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.db'))
      .map((e) => join(root, e.name))
  } catch {
    return [] // root not present on this install
  }
}

/** Newest mtime of the database and its WAL sidecars — recent writes land there */
async function newestMtimeMs(path: string): Promise<number> {
  let newest = 0
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const info = await stat(candidate)
      if (info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      // sidecar absent
    }
  }
  return newest
}

async function readConversation(path: string, records: UsageRecord[], seen: Set<string>): Promise<number> {
  // Imported lazily so a runtime without node:sqlite degrades instead of failing
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  let drifted = 0
  try {
    const rows = db
      .prepare('SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx')
      .all() as Array<{ data: Uint8Array | null }>
    const fallbackMs = await newestMtimeMs(path)
    for (const row of rows) {
      if (!row.data) continue
      const blob = Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength)
      const outcome = parseGeneration(blob, fallbackMs)
      if (outcome.drifted) {
        drifted++
        continue
      }
      const record = outcome.record
      if (!record) continue
      if (record.input + record.output + record.cacheRead === 0) continue
      // A retried generation repeats its response id: count each once, and
      // dedupe across roots too (a conversation can be mirrored between them)
      const id = responseIdOf(blob)
      if (id && !seen.has(id)) seen.add(id)
      else if (id) continue
      records.push(record)
    }
  } finally {
    db.close()
  }
  return drifted
}

/** `chatModel.#4.#11` — the response id used as the cross-store dedup key */
function responseIdOf(blob: Buffer): string {
  const chat = msgField(readFields(blob), 1)
  const usage = chat ? msgField(chat, 4) : null
  return usage ? strField(usage, 11).trim() : ''
}

// ===== payload =====

/**
 * Where a generation's model actually comes from.
 *
 * Antigravity proxies several vendors, so attributing every row to Google would
 * put Claude traffic in Google's column of the provider distribution. The model
 * name is the only signal the store carries.
 */
function providerForModel(modelId: string): string {
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return 'anthropic'
  if (id.includes('gpt') || /(^|[^a-z])o[34]($|[^a-z])/.test(id)) return 'openai'
  return 'google'
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
    const key = `antigravity\u0000${record.modelId}`
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
        const [, modelId] = key.split('\u0000')
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
        // cost 0 on purpose: Antigravity records no cost locally, so the main
        // process prices these entries from the catalogue like every other one.
        return {
          client: CLIENT_ID,
          modelId,
          providerId: providerForModel(modelId),
          tokens,
          cost: 0,
          messages: slice.messages,
        }
      })
      return { date, totals, tokenBreakdown, clients, intensity: 0, activeTimeMs: 0 }
    })

  return { meta: null, contributions }
}

/**
 * Read Antigravity's local usage into a `tokscale graph`-shaped payload.
 *
 * Every known conversation root is scanned: which one an install uses depends on
 * the flavour (`antigravity-cli` for the terminal agent, `antigravity` for the
 * 2.0 app, `antigravity-ide` for the IDE). Generations are deduplicated by
 * response id across all of them, so a conversation reachable from two roots is
 * still counted once.
 *
 * Legacy `.pb` conversation files (the pre-SQLite format) are out of scope: they
 * are opaque to this reader.
 *
 * Best-effort by contract — a missing root, an unreadable database or a schema
 * change must never affect the scan. Returns null when nothing usable was found.
 */
export async function readAntigravityUsage(home: string): Promise<unknown | null> {
  try {
    const records: UsageRecord[] = []
    const seen = new Set<string>()
    let drift = 0
    let examined = 0
    for (const root of SESSION_ROOTS) {
      const dir = join(home, '.gemini', root, 'conversations')
      for (const db of await listConversationDbs(dir)) {
        try {
          const info = await stat(db)
          if (!info.isFile() || info.size === 0 || info.size > MAX_DB_BYTES) continue
          examined++
          drift += await readConversation(db, records, seen)
        } catch {
          // one unreadable conversation must not stop the sweep
        }
      }
    }
    if (process.env.CODING_USAGE_DEBUG_ANTIGRAVITY === '1') {
      console.log(`[antigravity] dbs=${examined} records=${records.length} drifted=${drift}`)
    }
    return records.length > 0 ? buildPayload(records) : null
  } catch {
    return null
  }
}
