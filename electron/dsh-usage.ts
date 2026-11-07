import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * DeepSeek Harness (`dsh`) local usage reader.
 *
 * tokscale has a DSH reader, but it is **fail-closed**: a single event it cannot
 * parse discards the whole transcript, silently. Reproduced 2026-11 against
 * tokscale 4.14.0 on this machine: one 21 MB session (3,020 calls, ~1.26 B
 * tokens) parsed to zero because of one event near its end, while every other
 * session counted. The dashboard therefore under-reported DSH by ~35%, with
 * nothing in the UI to show it.
 *
 * So DSH is read here directly and tokscale's `dsh` client is no longer asked
 * for it (see `TOKSCALE_CLIENTS`). Reading it ourselves also removes the old
 * alias shim: versioned transcripts are opened as they are.
 *
 * Store layout (`~/.dsh`, overridable through `DSH_HOME`):
 *   `<root>/sessions/<project>/<session>/session[.vN].jsonl[.zstd]`
 * A session directory can hold several versions side by side (a migrating
 * kernel leaves the old one behind) plus a hard-linked `session.jsonl.zstd`
 * alias; only the **highest version present** is read, so one session is one
 * transcript.
 *
 * Records: `type: 'assistant/message'` (plus `assistant/attempt` and
 * `compaction/summary`, which are billed provider calls too) carry
 * `data.usage = { inputTokens, outputTokens, cacheReadTokens, totalTokens }`, a
 * `time` in epoch ms, and the serving channel at `data.message.source.{provider,
 * model}` — or, for a compaction summary, directly on `data.{provider,model}`.
 * The work a fork copied from its parent is marked `session/end-seed` with
 * `data.inherited: true` (v4; older layouts used `header.seedLength`); everything
 * up to that seq is the parent's, and is skipped.
 *
 * Transcripts are NOT the whole story: the app deletes/archives sessions, and
 * DSH's own usage plugin keeps the only surviving record of them at
 * `<root>/storages/dsh-app-plugin-usage/usage.jsonl` (one JSON row per billed
 * event: `sessionId`, `seq`, `time`, `provider`, `model`, the four counters).
 * Measured here 2026-11: 392 sessions in that store vs 194 still on disk — the
 * transcripts accounted for 3.59 B tokens and the vanished sessions for another
 * 8.59 B, which is exactly the gap between this dashboard and the number the
 * DSH app itself shows. So both are read, merged **event by event**: a
 * `sessionId#seq` a transcript knows about is claimed (counted, inherited, or
 * superseded by a later snapshot) and the store cannot add it back, while a store
 * row no transcript claims is real usage that would otherwise be lost — including
 * events a *readable* transcript is missing, because a killed writer leaves a
 * clean prefix rather than a torn line.
 *
 * `.jsonl.zstd` files are **append-only concatenated frames** (one frame per
 * write, thousands per file). Node's zstd decoder stops after the first frame,
 * so frames are decoded one at a time and a frame that fails to decode is
 * skipped instead of voiding the transcript.
 *
 * Privacy: only counters, model/provider ids and timestamps are read — never
 * message content.
 */

/** Client id this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts) */
const CLIENT_ID = 'dsh'

/** Fallback provider id when an event names no serving channel */
const VENDOR_PROVIDER = 'dsh'

/** zstd frame magic: the only marker frames can be split on */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Recursion guard for the session walk (`sessions/<project>/<session>`) */
const MAX_WALK_DEPTH = 4

/** Skip absurdly large files (the largest real transcript is ~22 MB) */
const MAX_FILE_BYTES = 256 * 1024 * 1024

/** Skip an outsized usage store rather than parsing it into memory */
const MAX_STORE_BYTES = 64 * 1024 * 1024

/** Bounded retry when a frame candidate fails: keeps a damaged file from becoming O(n²) */
const MAX_FRAME_RETRY = 4

/** Ceiling on one frame's decompressed size (real frames stay in the KB range) */
const MAX_FRAME_OUTPUT_BYTES = 64 * 1024 * 1024

/** What one transcript contributed, and which store rows it already accounts for */
export interface ParsedTranscript {
  records: UsageRecord[]
  /**
   * `sessionId#seq` of every billable event this transcript can account for —
   * counted, inherited from a fork, or superseded by a later snapshot. The app's
   * usage store is matched against this alone (never against a message id, which
   * has its own namespace), so an event is counted once and an event only the
   * store still holds is recovered.
   */
  claimedKeys: string[]
}

interface UsageRecord {
  /** `sessionId#seq` — shared with DSH's own usage store */
  key: string
  /**
   * Cross-file identity: the message id when the event has one. A fork copies
   * its parent's events verbatim (ids included) into a new session, so the
   * generation must be counted once no matter how many transcripts replay it.
   */
  identity: string
  tsMs: number
  providerId: string
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
 * `channel/model` → provider + model.
 *
 * DSH records the serving channel in `source.provider` and the model id in
 * `source.model`, which can carry a routing prefix (`group/auto-deepseek-v4-1-flash`).
 * The channel is the honest provider (it is what the gateway billed); the model
 * keeps its short tail so one model does not split into a row per routing mode.
 */
function splitModel(provider: string, model: string): { providerId: string; modelId: string } {
  const providerId = provider.trim() || VENDOR_PROVIDER
  const slash = model.lastIndexOf('/')
  const modelId = slash >= 0 ? model.slice(slash + 1) : model
  return { providerId, modelId: modelId || 'unknown' }
}

/**
 * Decode an append-only zstd transcript: every concatenated frame, in order.
 *
 * Frames are located by their magic, which can also occur inside compressed
 * data; a candidate slice that fails to decode is retried with the following
 * frames merged in (bounded, so a pathological file cannot turn this into an
 * O(n²) decompression storm), and a frame that still fails is skipped so one bad
 * append cannot void the session.
 *
 * `droppedFrames > 0` means the transcript is incomplete — the caller must not
 * treat the session as fully accounted for in that case.
 */
export function decodeZstdFrames(raw: Buffer): { text: string; droppedFrames: number } {
  const offsets: number[] = []
  let at = 0
  while ((at = raw.indexOf(ZSTD_MAGIC, at)) !== -1) {
    offsets.push(at)
    at += ZSTD_MAGIC.length
  }
  // A non-empty file with no frame at all is undecodable, not an empty
  // transcript: reporting it as complete would make the caller trust a session
  // that has nothing to say.
  if (offsets.length === 0) return { text: '', droppedFrames: raw.length > 0 ? 1 : 0 }
  if (offsets[0] !== 0) offsets.unshift(0)

  const parts: Buffer[] = []
  let droppedFrames = 0
  let index = 0
  while (index < offsets.length) {
    let next = index + 1
    let decoded: Buffer | null = null
    while (next <= offsets.length && next - index <= MAX_FRAME_RETRY) {
      const slice = raw.subarray(offsets[index], next < offsets.length ? offsets[next] : raw.length)
      try {
        decoded = zstdDecompressSync(slice, { maxOutputLength: MAX_FRAME_OUTPUT_BYTES })
        break
      } catch {
        next++
      }
    }
    if (decoded) {
      parts.push(decoded)
      index = next
    } else {
      // Every candidate that merged in following frames failed, so this frame is
      // unreadable: skip exactly one frame (the next one may still be fine) and
      // report the loss.
      droppedFrames++
      index++
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), droppedFrames }
}

/**
 * Parse one transcript into usage records. Never throws: an unparsable line is
 * skipped, a missing header just means no seed boundary.
 *
 * Two seeded boundaries are honoured, because both exist in real data:
 * `header.seedLength` (older layout) and a `session/end-seed` event carrying
 * `data.inherited: true` (the v4 layout) — everything at or before the boundary
 * was copied from the parent session and is not this session's work.
 *
 * `claimedKeys` follows a deliberate rule: a key is claimed only when this
 * transcript can actually account for that event — it was counted, a later
 * snapshot replaced it, or it belongs to the inherited prefix. A line with no
 * usage, all-zero counters or no timestamp claims nothing, so the app's usage
 * store can still supply that event instead of being blocked by a stub.
 *
 * Exported for unit tests; `readDshUsage` is the only production caller.
 */
export function parseDshTranscript(text: string, sessionId = ''): ParsedTranscript {
  const records: UsageRecord[] = []
  // identity → index in `records`, so a later snapshot of the same generation
  // replaces the earlier one instead of being dropped
  const byIdentity = new Map<string, number>()
  const lines: unknown[] = []

  // First pass: collect the lines and the seeded-fork boundary. The boundary
  // event sits *after* the events it covers (a v4 child appends its inherited
  // prefix first), so it cannot be discovered while streaming.
  let seedLength = 0
  let headerRead = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // torn line from an appending writer
    }
    const entry = asRecord(parsed)
    if (!entry) continue
    lines.push(entry)
    if (!headerRead) {
      headerRead = true
      if (str(entry.type) === 'session') seedLength = num(entry.seedLength)
    }
    if (str(entry.type) === 'session/end-seed' && asRecord(entry.data)?.inherited === true) {
      seedLength = num(entry.seq)
    }
  }

  // Second pass: the billable events
  const claimedKeys: string[] = []
  /**
   * Snapshots with no usable counters, held back: they claim nothing on their
   * own (the store may hold the real report), but if the same generation later
   * has a valid report, these keys are superseded and must be claimed too —
   * otherwise the store's stale snapshot row is added as an extra event.
   */
  const pendingStubs: Array<{ key: string; identity: string }> = []
  for (const entry of lines as Record<string, unknown>[]) {
    const type = str(entry.type)
    if (type !== 'assistant/message' && type !== 'assistant/attempt' && type !== 'compaction/summary') continue

    const seq = num(entry.seq)
    const key = `${sessionId}#${seq}`
    // An inherited event belongs to the parent session: this transcript knows
    // about it (so the store must not bill it to the child) but does not count it.
    if (seedLength > 0 && seq < seedLength) {
      claimedKeys.push(key)
      continue
    }

    const data = asRecord(entry.data)
    const message = asRecord(data?.message)
    const messageId = str(message?.id)
    // Only a real message id identifies a generation across snapshots. An event
    // without one is identified by its own key, which must never enter the
    // message-id namespace (`id:foo#3` colliding with session `id:foo`, seq 3).
    const identity = messageId ? `id:${messageId}` : ''

    const usage = asRecord(data?.usage)
    if (!usage) {
      if (identity) pendingStubs.push({ key, identity })
      continue
    }
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    const tsMs = num(entry.time)
    // A stub line (no counters or no timestamp) claims nothing on its own: the
    // store may hold the real report for that event.
    if (input + output + cacheRead + cacheWrite === 0 || tsMs <= 0) {
      if (identity) pendingStubs.push({ key, identity })
      continue
    }

    // An assistant message names its serving channel on `data.message.source`;
    // a compaction summary (a billed provider call with no message) names it
    // directly on `data`. Reading only the first path put those calls under
    // `dsh/unknown`, where they could not be priced.
    const messageSource = asRecord(message?.source)
    const providerRaw = str(messageSource?.provider) || str(data?.provider)
    const modelRaw = str(messageSource?.model) || str(data?.model)
    const { providerId, modelId } = splitModel(providerRaw, modelRaw)
    claimedKeys.push(key)
    // Records are keyed by message id when there is one, so a later snapshot
    // supersedes the earlier one instead of being counted beside it.
    const recordKey = identity || key
    const record: UsageRecord = { key, identity, tsMs, providerId, modelId, input, output, cacheRead, cacheWrite }
    const previous = byIdentity.get(recordKey)
    if (previous === undefined) {
      byIdentity.set(recordKey, records.length)
      records.push(record)
    } else {
      // A later snapshot supersedes the earlier one; its key is already claimed
      records[previous] = record
    }
  }

  // An early snapshot that has no counters of its own is superseded once the same
  // generation reports a real one: claim its key so the store's stale row for it
  // is not added on top.
  for (const stub of pendingStubs) {
    if (byIdentity.has(stub.identity)) claimedKeys.push(stub.key)
  }

  return { records, claimedKeys }
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
        // cost 0 on purpose: DSH records no price; the main process prices these
        // entries from the shared price table.
        return { client: CLIENT_ID, modelId, providerId, tokens, cost: 0, messages: slice.messages }
      })
      // No clock: DSH transcripts carry per-event timestamps but no session span,
      // and a fabricated duration would distort the tok/s rate.
      return { date, totals, tokenBreakdown, clients, intensity: 0, activeTimeMs: 0 }
    })

  // `totals` is summed from the entries above, so the renderer's
  // "unclassified" derivation (totals − Σclients) stays exactly zero.
  return { meta: null, contributions }
}

interface SessionFile {
  path: string
  /** Version number from `session.vN.jsonl`; 0 for the unversioned name */
  version: number
}

/** All transcript candidates under a session root, best-effort */
async function collectSessionFiles(
  dir: string,
  depth = 0,
  out: Map<string, SessionFile> = new Map(),
): Promise<Map<string, SessionFile>> {
  if (depth > MAX_WALK_DEPTH) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSessionFiles(path, depth + 1, out)
      continue
    }
    const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(entry.name)
    if (!match || !entry.isFile()) continue
    const version = match[1] ? Number(match[1]) : 0
    // One transcript per session directory: the highest version present wins, so
    // a migrating kernel's leftover v3 copy (or a hard-linked alias) is not
    // counted a second time.
    const existing = out.get(dir)
    if (!existing || version > existing.version) out.set(dir, { path, version })
  }
  return out
}

/** Whole transcript text plus how many frames were undecodable, or null */
async function readTranscriptText(path: string): Promise<{ text: string; droppedFrames: number } | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null
    const raw = await readFile(path)
    return path.endsWith('.zstd') ? decodeZstdFrames(raw) : { text: raw.toString('utf8'), droppedFrames: 0 }
  } catch {
    return null
  }
}

/**
 * Parsed sessions, keyed by path and invalidated by inode/ctime/mtime/size.
 *
 * Decompressing and parsing ~140 MB of transcripts costs seconds of CPU on the
 * main process (`readFile` is async, the decode is not). A scan runs every few
 * minutes and almost every file is unchanged in between, so the *parsed records*
 * are cached instead of the decoded text: records are a few MB where the text is
 * hundreds, and the cache turns a repeat scan into a stat per file. Appends touch
 * size/mtime, and a same-size rewrite with a restored mtime still changes ctime
 * and (for a replace-then-rename) the inode, so neither a live session nor a
 * recycled path can serve stale numbers.
 */
const sessionCache = new Map<
  string,
  { ino: number; ctimeMs: number; mtimeMs: number; size: number; parsed: ParsedTranscript; droppedFrames: number }
>()

/** Bound the cache: a machine with years of sessions should not grow it forever */
const MAX_CACHED_SESSIONS = 4096

async function loadSession(
  path: string,
  sessionId: string,
): Promise<{ parsed: ParsedTranscript; droppedFrames: number } | null> {
  let info
  try {
    info = await stat(path)
  } catch {
    sessionCache.delete(path)
    return null
  }
  if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null

  const cached = sessionCache.get(path)
  if (
    cached &&
    cached.ino === info.ino &&
    cached.ctimeMs === info.ctimeMs &&
    cached.mtimeMs === info.mtimeMs &&
    cached.size === info.size
  ) {
    return cached
  }

  const text = await readTranscriptText(path)
  if (text == null) return null
  const entry = {
    ino: info.ino,
    ctimeMs: info.ctimeMs,
    mtimeMs: info.mtimeMs,
    size: info.size,
    parsed: parseDshTranscript(text.text, sessionId),
    droppedFrames: text.droppedFrames,
  }
  if (sessionCache.size >= MAX_CACHED_SESSIONS) sessionCache.clear()
  sessionCache.set(path, entry)
  return entry
}

/**
 * Read DSH usage into a `tokscale graph`-shaped payload.
 *
 * `home` is the user's home directory — `homedir()` in production, a temporary
 * directory in tests. `DSH_HOME` overrides the root, matching DSH's own
 * lookup. Best-effort by contract: a missing store, an unreadable file or a
 * transcript being appended mid-read must never affect the scan. Returns null
 * when DSH has recorded no usage.
 */
/**
 * Rows kept by DSH's own usage plugin for a root, grouped by session id.
 *
 * This store is the only surviving record of sessions the app has since
 * deleted or archived — see the module docstring — and it is also the complete
 * record of a session whose transcript was damaged. Plain JSONL, one billed
 * event per line; malformed lines are skipped rather than failing the read.
 */
async function readPluginRows(root: string): Promise<Map<string, UsageRecord[]>> {
  const out = new Map<string, UsageRecord[]>()
  const path = join(root, 'storages', 'dsh-app-plugin-usage', 'usage.jsonl')
  let text: string
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_STORE_BYTES) return out
    text = await readFile(path, 'utf8')
  } catch {
    return out
  }
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: Record<string, unknown> | null
    try {
      row = asRecord(JSON.parse(trimmed))
    } catch {
      continue
    }
    if (!row) continue
    const sessionId = str(row.sessionId)
    const seq = num(row.seq)
    const tsMs = num(row.time)
    const input = num(row.inputTokens)
    const output = num(row.outputTokens)
    const cacheRead = num(row.cacheReadTokens)
    const cacheWrite = num(row.cacheWriteTokens)
    if (!sessionId || seq <= 0 || tsMs <= 0) continue
    if (input + output + cacheRead + cacheWrite === 0) continue
    const { providerId, modelId } = splitModel(str(row.provider), str(row.model))
    const key = `${sessionId}#${seq}`
    // The plugin's store holds a few duplicated keys (the same event folded
    // twice); the first row wins.
    if (seen.has(key)) continue
    seen.add(key)
    const record: UsageRecord = { key, identity: key, tsMs, providerId, modelId, input, output, cacheRead, cacheWrite }
    const list = out.get(sessionId)
    if (list) list.push(record)
    else out.set(sessionId, [record])
  }
  return out
}

/**
 * Read DSH usage into a `tokscale graph`-shaped payload.
 *
 * `home` is the user's home directory — `homedir()` in production, a temporary
 * directory in tests. `DSH_HOME` overrides the root, matching DSH's own
 * lookup.
 *
 * Two sources, merged event by event rather than per session:
 *
 * - the transcript, when one still exists;
 * - the app's own usage store, which survives sessions it has deleted and events
 *   a damaged transcript could not supply.
 *
 * Every billable event a transcript knows about is claimed, counted or not
 * (inherited prefix, superseded snapshot, fork copy), and only unclaimed store
 * rows are added. That keeps both directions honest: a store row cannot revive an
 * event the transcript already accounts for, and an event only the store still
 * holds is not lost because a transcript happens to be readable — which matters
 * because a readable transcript can still be *truncated* (a killed writer leaves
 * a clean prefix, not a torn line).
 *
 * Best-effort by contract: a missing store, an unreadable file or a transcript
 * being appended mid-read must never affect the scan. Returns null when DSH has
 * recorded no usage.
 */
export async function readDshUsage(home: string): Promise<unknown | null> {
  try {
    const root = process.env.DSH_HOME?.trim() || join(home, '.dsh')
    const sessionsRoot = join(root, 'sessions')
    const files = await collectSessionFiles(sessionsRoot)
    const pluginRows = await readPluginRows(root)
    const records: UsageRecord[] = []
    // Two namespaces, deliberately separate: store rows are keyed by
    // `sessionId#seq`, transcript dedupe is keyed by message id. Sharing one set
    // let a record's own key satisfy its identity check (an event without a
    // message id skipped itself) and let `id:foo#3` collide with a session named
    // `id:foo`, seq 3.
    const claimedEventKeys = new Set<string>()
    const seenMessageIds = new Set<string>()

    for (const [dir, file] of files) {
      // The session id is the directory name (it matches the transcript header)
      const sessionId = basename(dir)
      const loaded = await loadSession(file.path, sessionId)
      if (loaded == null) continue
      const parsed = loaded.parsed
      for (const key of parsed.claimedKeys) claimedEventKeys.add(key)
      for (const record of parsed.records) {
        // A fork copies its parent's events verbatim (ids included): the
        // generation happened once and must be counted once — but its key in this
        // session is still claimed, so the store cannot smuggle the copy back.
        // Only a real message id joins the identity set: an event without one is
        // identified by its own key alone.
        if (record.identity) {
          if (seenMessageIds.has(record.identity)) continue
          seenMessageIds.add(record.identity)
        }
        claimedEventKeys.add(record.key)
        records.push(record)
      }
    }

    for (const rows of pluginRows.values()) {
      for (const record of rows) {
        if (claimedEventKeys.has(record.key)) continue
        claimedEventKeys.add(record.key)
        records.push(record)
      }
    }

    return records.length > 0 ? buildPayload(records) : null
  } catch {
    return null
  }
}
