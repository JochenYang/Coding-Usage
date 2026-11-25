import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  readSessionCursors,
  readStoredClientRows,
  saveSessionCursors,
  storedClients,
  type SessionCursor,
  type StoredDayRow,
} from './usage-store'

/**
 * Antigravity local usage reader, one client per flavour.
 *
 * tokscale's own Antigravity reader covers `~/.gemini/antigravity-cli/` only
 * (and is not enabled here); the IDE and the 2.0 app keep their conversations
 * elsewhere. This module reads all three stores directly and emits a payload
 * shaped like a `tokscale graph` result, which the main process merges into the
 * scan. Each root is its own client id — `antigravity-ide`, `antigravity` and
 * `antigravity-cli` — so the overview's table can show the three separately,
 * matching the three subscription cards.
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
 *           #19 internal model id (e.g. "gemini-3-flash-a")
 *           #21 display model name (e.g. "Gemini 3.5 Flash (High)")
 *
 * **Dating a generation.** The IDE-era rows carried a per-generation timestamp
 * (`chatModel.#9`), but neither the 2.0 app nor the CLI writes one: a recursive
 * scan of every nesting level of their `gen_metadata` finds no epoch-seconds
 * field, and `steps` has no time column either. Dating such a row to its
 * conversation's creation day made a long-running conversation report all of
 * its usage on the day it started — the app's active conversation showed
 * nothing "today" at all. So the reader dates by **arrival** instead: each scan
 * counts the generations past a per-conversation high-water mark (`idx`, the
 * append order) on the day the scan runs, then advances the mark (see
 * `readSessionCursors` in usage-store.ts).
 *
 * The first scan of a conversation needs a rule, and there are two cases
 * ({@link firstScanPlan}): with any Antigravity history in the store, the
 * conversation starts at its current end, because an older build already
 * counted this disk content (under a creation-day rule, and all three roots
 * under one client id the split cannot separate); with none at all, the reader
 * itself is new and the whole database is its back catalogue, counted on its
 * last-write day. A whole-database count is dated by the file's last-write time
 * rather than "now": that is the day its most recent generations were produced.
 *
 * Two costs follow, both preferred over double counting (which no later scan can
 * undo): usage an already-recorded conversation gained between its last recorded
 * scan and this upgrade, and the same for a conversation started on the upgrade
 * day, is not booked — the next generation after the upgrade is. And a day's
 * figure must be reported as a **running total** (the store's rows for today plus
 * this scan), because the store keeps the larger view of a client on a day and a
 * bare increment would be the smaller one.
 *
 * Because the numbers are unofficial and could shift when Antigravity changes,
 * every row is verified against the stored output total before it is counted:
 * `#3` must equal `#9 + #10`. A row that disagrees is dropped (the format
 * moved), and a row without `#3` cannot be verified so it is dropped too. The
 * check covers the output fields only — a silent re-meaning of an input field
 * (no stored input total exists to compare against) is the known residual risk.
 *
 * Privacy: only token counters, the model name and row order are read. Message
 * bodies live in other columns and are never touched.
 */

/**
 * Conversation roots relative to the home directory, each with the client id it
 * reports. The ids must exist in AGENT_CLIENTS (src/lib/agent-usage.ts).
 */
const SESSION_ROOTS = [
  { dir: 'antigravity-ide', client: 'antigravity-ide' },
  { dir: 'antigravity', client: 'antigravity' },
  { dir: 'antigravity-cli', client: 'antigravity-cli' },
] as const

/** One conversation database holds a few thousand generations at most */
const MAX_DB_BYTES = 512 * 1024 * 1024

interface UsageRecord {
  /** Calendar day this record is booked to (arrival dating, see the module comment) */
  date: string
  client: string
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /**
   * Part of a whole-database count: the row describes the conversation
   * completely, so it is folded against the stored day with `max` instead of
   * being added to it.
   */
  whole: boolean
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

// ===== row parsing =====

/** Local calendar day, matching the renderer's `todayKey()` bucketing */
function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface ParseOutcome {
  record?: Omit<UsageRecord, 'date' | 'client' | 'whole'>
  /** `chatModel.#4.#11` — the response id used as the cross-store dedup key */
  responseId: string
  /** Rows whose field layout disagreed with the verified map */
  drifted: boolean
}

function parseGeneration(blob: Buffer): ParseOutcome {
  const chat = msgField(readFields(blob), 1)
  const usage = chat ? msgField(chat, 4) : null
  if (!chat || !usage) return { responseId: '', drifted: false }

  const input = numField(usage, 1) + numField(usage, 2)
  const outputText = numField(usage, 9)
  const thinking = numField(usage, 10)
  const total = numField(usage, 3)
  // The only stored total is the output one: without it the row is unverifiable
  if (total === 0) return { responseId: '', drifted: false }
  if (total !== outputText + thinking) return { responseId: '', drifted: true }

  // Display name reads better and prices correctly once the tier suffix is
  // dropped (see the pricing note in main.ts); the internal id is the fallback.
  const display = strField(chat, 21) || strField(chat, 19) || 'unknown'
  const modelId = display.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'unknown'
  return {
    responseId: strField(usage, 11).trim(),
    drifted: false,
    record: {
      modelId,
      input,
      output: outputText + thinking,
      cacheRead: numField(usage, 5),
      cacheWrite: 0,
    },
  }
}

// ===== database walk =====

interface ConversationListing {
  dbs: string[]
  /**
   * The directory exists but could not be read (permissions, antivirus, a
   * network home). Its conversations must keep their marks: an unreadable root
   * is not the same as a flavour that was never installed.
   */
  failed: boolean
}

async function listConversationDbs(root: string): Promise<ConversationListing> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return {
      dbs: entries.filter((e) => e.isFile() && e.name.endsWith('.db')).map((e) => join(root, e.name)),
      failed: false,
    }
  } catch (error) {
    // A missing root is the normal case for a flavour that is not installed
    const code = (error as NodeJS.ErrnoException).code
    return { dbs: [], failed: code !== 'ENOENT' && code !== 'ENOTDIR' }
  }
}

/**
 * Where a scan should start for one conversation, and which day its rows go to.
 *
 * - With a stored mark: the file number is the file's identity, so a mark whose
 *   file number differs describes a *different* database that replaced the old
 *   one at the same path — the whole new database is new. Without usable file
 *   numbers, a database whose indexes ended up *below* the stored mark is
 *   treated the same way (its indexes went backwards). Rows past the mark are
 *   today's; a whole new file is dated by its last write.
 * - Without a mark, when the upgrade still has to be bridged (`skipBackCatalogue`
 *   — the first scan of this build over a store that already holds Antigravity
 *   usage): start at the current end without booking anything. An older build
 *   counted this disk content under a time rule and a single client id that the
 *   split cannot separate, and counting it again would inflate a day it already
 *   sits in.
 * - Without a mark otherwise: the whole database has never been recorded, so it
 *   counts whole, dated by its last write. That covers a store with no
 *   Antigravity history at all and every conversation that appeared (or failed
 *   to read) after this build's first scan.
 *
 * The cost of the second case is a one-off gap: usage an already-recorded
 * conversation gained between its last recorded scan and this upgrade. That is
 * preferred over double counting, which no later scan could undo.
 *
 * Exported so the rule can be asserted directly: a test cannot fabricate an old
 * file's creation time (Windows does not let it set one).
 */
export function firstScanPlan(input: {
  stored: SessionCursor | undefined
  /** First scan of this build over a store that already holds Antigravity usage */
  skipBackCatalogue: boolean
  current: SessionCursor
  /** File's last-write time, which dates a whole-database count */
  mtimeMs: number
  nowMs: number
}): { cursor: number; date: string | null } {
  const { stored, skipBackCatalogue, current, mtimeMs, nowMs } = input
  if (stored !== undefined) {
    const identityMoved = stored.fileId !== '' && current.fileId !== '' && stored.fileId !== current.fileId
    const restarted = identityMoved || current.maxIdx < stored.maxIdx
    return restarted ? { cursor: -1, date: localDay(mtimeMs) } : { cursor: stored.maxIdx, date: localDay(nowMs) }
  }
  if (skipBackCatalogue) return { cursor: current.maxIdx, date: null }
  return { cursor: -1, date: localDay(mtimeMs) }
}

interface ConversationRows {
  /** Highest index of a row that carries data; −1 when there is none */
  maxIdx: number
  rows: Array<{ idx: number; data: Uint8Array }>
}

/** Every generation row of one conversation that carries data, in append order */
async function readConversationRows(path: string): Promise<ConversationRows> {
  // Imported lazily so a runtime without node:sqlite degrades instead of failing
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx').all() as Array<{
      idx: number
      data: Uint8Array | null
    }>
    // Derive the mark from the rows that are actually here, not a separate
    // MAX(): a generation appended between the two statements would otherwise be
    // counted now and skipped by the mark, or a row still being written would be
    // stepped over and never read. A null row at the end leaves the mark on the
    // last real one, so the next scan picks it up once it is written.
    const readable = rows.filter((row): row is { idx: number; data: Uint8Array } => row.data != null)
    const maxIdx = readable.length > 0 ? readable[readable.length - 1]!.idx : -1
    return { maxIdx, rows: readable }
  } finally {
    db.close()
  }
}

interface CollectOutcome {
  /** Rows whose layout disagreed with the verified map */
  drifted: number
  /** Rows that made it into `records` */
  counted: number
}

/**
 * Turn the rows past `cursor` into usage records, booked to `date`.
 *
 * `cursor` is the high-water mark from the previous scan (−1 for a whole
 * database, whose entire content is new). A row past it is counted now and the
 * caller advances the mark; a row at or below it was counted by an earlier
 * scan and is skipped, which is what keeps "arrival dating" from re-counting
 * history.
 */
function collectRecords(
  rows: ConversationRows['rows'],
  client: string,
  cursor: number,
  date: string,
  whole: boolean,
  records: UsageRecord[],
  seen: Set<string>,
): CollectOutcome {
  let drifted = 0
  let counted = 0
  for (const row of rows) {
    if (row.idx <= cursor) continue
    const blob = Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength)
    const outcome = parseGeneration(blob)
    if (outcome.drifted) {
      drifted++
      continue
    }
    const record = outcome.record
    if (!record) continue
    if (record.input + record.output + record.cacheRead === 0) continue
    // A retried generation repeats its response id: count each once, and
    // dedupe across roots too (a conversation can be mirrored between them)
    const id = outcome.responseId
    if (id && !seen.has(id)) seen.add(id)
    else if (id) continue
    records.push({ date, client, whole, ...record })
    counted++
  }
  return { drifted, counted }
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

/**
 * Fold the flat records into `tokscale graph`-shaped contributions.
 *
 * Rows carry their own day (arrival dating, see the module comment), so the
 * payload can span several days — normally one, but a first scan of a client
 * books a whole back catalogue on the day its conversations were last written.
 * Slices are keyed by day, client *and* model: each flavour is its own row in
 * the overview and they can call the same model.
 *
 * Today's rows start from `base` — the client rows the history already holds
 * for today. This reader reports what is *new* since the previous scan, and the
 * store keeps the larger view of a client on a day; sending only the increment
 * would therefore be smaller than the day already recorded and would be thrown
 * away. Sending the running total keeps the merge honest.
 */
/**
 * Fold the flat records into `tokscale graph`-shaped contributions.
 *
 * Rows carry their own day (arrival dating, see the module comment), so the
 * payload can span several days — normally one, but a whole-database count books
 * a back catalogue on the day its conversations were last written. Slices are
 * keyed by day, client *and* model: each flavour is its own row in the overview
 * and they can call the same model.
 *
 * Today's rows start from `base` — the client rows the history already holds
 * for today. This reader reports what is *new* since the previous scan, and the
 * store keeps the larger view of a client on a day; sending only the increment
 * would therefore be smaller than the day already recorded and would be thrown
 * away. Sending the running total keeps the merge honest.
 *
 * A whole-database count is different: it already describes the conversation
 * completely, so it is folded in with `max` rather than added. Adding would
 * double a day the same conversation was counted on before (a replaced file or
 * reordered indexes on the same day); taking the larger can only under-count an
 * older reading, which is the direction the store tolerates.
 */
function buildPayload(records: UsageRecord[], base: StoredDayRow[], today: string): unknown {
  const increments = new Map<string, Slice>()
  const wholes = new Map<string, Slice>()
  const accumulate = (target: Map<string, Slice>, record: UsageRecord): void => {
    const key = `${record.date}\u0000${record.client}\u0000${record.modelId}`
    const hit = target.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
    hit.input += record.input
    hit.output += record.output
    hit.cacheRead += record.cacheRead
    hit.cacheWrite += record.cacheWrite
    hit.messages += 1
    target.set(key, hit)
  }
  for (const record of records) accumulate(record.whole ? wholes : increments, record)

  const slices = new Map<string, Slice>()
  for (const row of base) {
    slices.set(`${today}\u0000${row.client}\u0000${row.modelId}`, { ...row.tokens, messages: row.messages })
  }
  for (const [key, whole] of wholes) {
    const previous = slices.get(key)
    slices.set(
      key,
      previous
        ? {
            input: Math.max(previous.input, whole.input),
            output: Math.max(previous.output, whole.output),
            cacheRead: Math.max(previous.cacheRead, whole.cacheRead),
            cacheWrite: Math.max(previous.cacheWrite, whole.cacheWrite),
            messages: Math.max(previous.messages, whole.messages),
          }
        : whole,
    )
  }
  for (const [key, increment] of increments) {
    const previous = slices.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
    slices.set(key, {
      input: previous.input + increment.input,
      output: previous.output + increment.output,
      cacheRead: previous.cacheRead + increment.cacheRead,
      cacheWrite: previous.cacheWrite + increment.cacheWrite,
      messages: previous.messages + increment.messages,
    })
  }

  const days = new Map<
    string,
    {
      totals: { tokens: number; cost: number; messages: number }
      tokenBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number }
      clients: unknown[]
    }
  >()
  for (const [key, slice] of slices) {
    const [date, client, modelId] = key.split('\u0000')
    const day = days.get(date) ?? {
      totals: { tokens: 0, cost: 0, messages: 0 },
      tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      clients: [],
    }
    const tokens = {
      input: slice.input,
      output: slice.output,
      cacheRead: slice.cacheRead,
      cacheWrite: slice.cacheWrite,
    }
    const total = slice.input + slice.output + slice.cacheRead + slice.cacheWrite
    day.totals.tokens += total
    day.totals.messages += slice.messages
    day.tokenBreakdown.input += slice.input
    day.tokenBreakdown.output += slice.output
    day.tokenBreakdown.cacheRead += slice.cacheRead
    day.tokenBreakdown.cacheWrite += slice.cacheWrite
    // cost 0 on purpose: Antigravity records no cost locally, so the main
    // process prices these entries from the catalogue like every other one.
    day.clients.push({
      client,
      modelId,
      providerId: providerForModel(modelId),
      tokens,
      cost: 0,
      messages: slice.messages,
    })
    days.set(date, day)
  }

  const contributions = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, day]) => ({ date, ...day, intensity: 0, activeTimeMs: 0 }))
  return { meta: null, contributions }
}

/** Result of one read: the payload and the marks it implies */
export interface AntigravityScan {
  payload: unknown | null
  /**
   * Advance the per-conversation marks. Call only once `payload` has reached
   * the store — a mark advanced for usage that never landed drops it for good.
   * Safe to call more than once.
   */
  commit: () => void
}

/** Client ids this reader reports, one per flavour */
const ANTIGRAVITY_CLIENTS: readonly string[] = SESSION_ROOTS.map((root) => root.client)

/**
 * Whether the store already holds Antigravity usage under any flavour.
 *
 * Older builds read all three roots and saved them under a single client id, so
 * one id having history means this disk content was counted before: a flavour
 * the split made new must start at its current end instead of re-counting the
 * whole catalogue. Exported so the rule can be asserted directly.
 */
export function antigravityKnown(known: ReadonlySet<string>): boolean {
  return ANTIGRAVITY_CLIENTS.some((id) => known.has(id))
}

/**
 * Read Antigravity's local usage into a `tokscale graph`-shaped payload.
 *
 * Every known conversation root is scanned, each reported as its own client:
 * `antigravity-ide` for the IDE, `antigravity` for the 2.0 app and
 * `antigravity-cli` for the terminal agent. Generations are deduplicated by
 * response id across all of them, so a conversation reachable from two roots is
 * still counted once.
 *
 * What is returned contains the *new* part of each conversation — the
 * generations past its stored high-water mark — dated to today, plus the whole
 * of a conversation that has never been recorded: one that appeared (or could
 * not be read) after this build's first scan, or one in a store with no
 * Antigravity history at all. A whole count is dated by the file's last write.
 * The first scan over a store that already holds Antigravity usage starts every
 * conversation at its current mark instead, because an older build counted that
 * content under a rule and a client id the split cannot separate — counting it
 * again would inflate a day it already sits in. Today's contribution is the
 * day's **running total** (what the store already holds for today plus this
 * scan), because the store keeps the larger view of a client on a day and a bare
 * increment would be the smaller one.
 *
 * The marks are returned, not written: the caller commits them after the
 * payload is stored (see {@link AntigravityScan.commit}). When there is nothing
 * to store the marks are committed here instead — a machine with no new rows
 * would otherwise never advance them, since the caller only commits for a
 * payload. A conversation that was found but could not be read this round keeps
 * its previous mark, as does one whose rows all failed verification (so a parser
 * fix can still recover them); when only some rows failed, the good ones are
 * counted and the mark advances (the bad ones are dropped — the documented cost
 * of a format change).
 *
 * Legacy `.pb` conversation files (the pre-SQLite format) are out of scope: they
 * are opaque to this reader.
 *
 * Best-effort by contract — a missing root, an unreadable database or a schema
 * change must never affect the scan. Returns a null payload when nothing usable
 * was found.
 */
export async function readAntigravityUsage(home: string): Promise<AntigravityScan> {
  const nothing: AntigravityScan = { payload: null, commit: () => {} }
  try {
    const cursors = readSessionCursors()
    // The upgrade bridge only applies to this build's very first scan: once any
    // mark exists, a conversation without one is new to this build and was never
    // counted, so its whole database is booked
    const skipBackCatalogue = cursors.size === 0 && antigravityKnown(storedClients())
    const nextCursors = new Map<string, SessionCursor>()
    const seenDbs = new Set<string>()
    const records: UsageRecord[] = []
    const seenResponses = new Set<string>()
    const now = Date.now()
    let drift = 0
    let examined = 0
    for (const root of SESSION_ROOTS) {
      const dir = join(home, '.gemini', root.dir, 'conversations')
      const listing = await listConversationDbs(dir)
      if (listing.failed) {
        // A root that exists but cannot be read keeps every mark under it: one
        // transient permission or antivirus failure must not drop a flavour
        for (const path of cursors.keys()) {
          if (path.startsWith(`${dir}${sep}`)) seenDbs.add(path)
        }
      }
      for (const db of listing.dbs) {
        let info: Awaited<ReturnType<typeof stat>>
        try {
          info = await stat(db)
        } catch {
          continue // gone: its mark is dropped
        }
        if (!info.isFile()) continue
        seenDbs.add(db)
        examined++
        let read: ConversationRows
        try {
          if (info.size === 0 || info.size > MAX_DB_BYTES) throw new Error('unreadable size')
          read = await readConversationRows(db)
        } catch {
          // Found but unreadable this round: keep the previous mark so the next
          // scan continues from there instead of skipping the gap
          const previous = cursors.get(db)
          if (previous) nextCursors.set(db, previous)
          continue
        }
        const current: SessionCursor = { maxIdx: read.maxIdx, fileId: info.ino > 0 ? String(info.ino) : '' }
        const plan = firstScanPlan({
          stored: cursors.get(db),
          skipBackCatalogue,
          current,
          mtimeMs: info.mtimeMs,
          nowMs: now,
        })
        if (plan.date != null) {
          const outcome = collectRecords(
            read.rows,
            root.client,
            plan.cursor,
            plan.date,
            plan.cursor < 0,
            records,
            seenResponses,
          )
          drift += outcome.drifted
          if (outcome.drifted > 0 && outcome.counted === 0) {
            // Nothing could be verified: leave the mark where it was so a
            // parser fix recovers the whole range rather than skipping it
            const previous = cursors.get(db)
            if (previous) nextCursors.set(db, previous)
            continue
          }
        }
        nextCursors.set(db, current)
      }
    }
    if (process.env.CODING_USAGE_DEBUG_ANTIGRAVITY === '1') {
      console.log(`[antigravity] dbs=${examined} records=${records.length} drifted=${drift}`)
    }
    const commit = (): void => saveSessionCursors(nextCursors, seenDbs)
    if (records.length === 0) {
      // Nothing to store, so the marks are safe to advance now: the caller only
      // commits for a payload, and holding them back would leave the reader in
      // its upgrade branch forever, counting nothing at all
      commit()
      return { payload: null, commit }
    }
    const today = localDay(now)
    // Only this reader's own rows belong in the running total
    const base = readStoredClientRows(today).filter((row) => ANTIGRAVITY_CLIENTS.includes(row.client))
    return { payload: buildPayload(records, base, today), commit }
  } catch {
    return nothing
  }
}
