import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Qoder (`qoder` / `qoder-global`) local usage reader.
 *
 * tokscale has no Qoder reader (verified against 4.14.0). The Qoder CLI and the
 * IDE share one session store: Claude-Code-shaped transcripts under
 * `<config>/projects/<project>/<sessionId>.jsonl` (documented at
 * docs.qoder.com/cli/sessions; the CLI binary carries the very same Anthropic
 * usage field names), where `<config>` is `~/.qoder` (global build) or
 * `~/.qoder-cn` (CN build), overridable through `QODER_CONFIG_DIR`. Transcript
 * lines embed an assistant `usage` object with `input_tokens` /
 * `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`,
 * a `model` and a timestamp.
 *
 * Two builds, two rows: one machine can hold both, and they are separate
 * products with separate quotas. The CN build feeds `qoder`, the global build
 * `qoder-global`.
 *
 * The global build reports **zero tokens** and bills in **credits**: its
 * `usage` carries `credits` / `original_credits` / `billable` next to four
 * zeroed token counters (verified 2026-11 on Qoder 0.5.6), and nothing else in
 * its local stores — IDE `main.sqlite` `chat_session_messages`,
 * `chat_session_context_usage` — records tokens at all. So a generation counts
 * as real usage when either tokens or credits are non-zero, and the credits are
 * carried through the payload: reporting 0 tokens with no explanation reads as
 * "this agent was never used".
 *
 * No verified CN-build sample was available when this was written (the CLI on
 * the reference machine had never held a CN session), so the line parser
 * accepts both the nested Claude-Code shape (`{type:'assistant', message:
 * {model, usage}}`) and flatter `{role:'assistant', model, usage}` variants,
 * with snake_case and camelCase counter spellings. Treat field drift as a
 * maintenance item: a format change degrades to "no Qoder usage", never to a
 * wrong number.
 *
 * Privacy: only token counters, credits, model ids and timestamps are read —
 * never prompt or response content.
 */

/**
 * Client ids this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts)
 */
const DOMESTIC_CLIENT_ID = 'qoder'
const GLOBAL_CLIENT_ID = 'qoder-global'

/** Provider every Qoder generation is attributed to */
const PROVIDER_ID = 'qoder'

/** Skip absurdly large transcripts (real ones stay well below this) */
const MAX_FILE_BYTES = 64 * 1024 * 1024

interface UsageRecord {
  /** Client row this generation belongs to (one per installed build) */
  clientId: string
  tsMs: number
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Qoder's own billing unit; 0 when the build reports tokens instead */
  credits: number
}

/** Usage found in one transcript, before it is attributed to an installed build */
type TranscriptRecord = Omit<UsageRecord, 'clientId'>

interface Slice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  credits: number
  messages: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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
 * `vendor/model` → provider + model.
 *
 * A bare id stays Qoder-attributed (the gateway serves first-party models under
 * plain names). `byok:` model ids embed the user's own BYOK profile:
 * `byok:qoder-custom-<uuid>/group%2Fauto-deepseek-v4-1-flash`. The profile id is
 * per-user, so taking it as the vendor would mint a provider row per profile in
 * the distribution chart; the model tail is what identifies the model, and the
 * `%2F` is Qoder's own separator escaping.
 */
function splitVendorModel(model: string): { providerId: string; modelId: string } {
  if (model.startsWith('byok:')) {
    const escapedOrSlash = model.split(/[/]/).pop() ?? model
    const decoded = escapedOrSlash.replace(/%2F/gi, '/').replace(/%252F/gi, '/')
    const tail = decoded.includes('/') ? decoded.slice(decoded.lastIndexOf('/') + 1) : decoded
    return { providerId: PROVIDER_ID, modelId: tail || model }
  }
  const slash = model.indexOf('/')
  if (slash <= 0) return { providerId: PROVIDER_ID, modelId: model }
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) }
}

/** Timestamp of a transcript line: ISO string or epoch milliseconds */
function lineTsMs(line: Record<string, unknown>): number {
  const raw = line.timestamp ?? line.time ?? line.created_at ?? line.createdAt
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * Identity of one generation inside a transcript, or null when the line carries
 * no stable id.
 *
 * A Claude-Code-shaped transcript appends the SAME assistant message several
 * times while it streams, and each line reports a larger `usage` than the one
 * before it. Summing those lines multiplies the real usage; the id is what lets
 * the caller keep only the final, complete report for that generation.
 */
function lineIdentity(line: Record<string, unknown>, message: Record<string, unknown> | null): string {
  const candidates = [
    message?.id,
    line.messageId,
    line.message_id,
    line.requestId,
    line.request_id,
    line.uuid,
    line.id,
  ]
  for (const candidate of candidates) {
    const value = str(candidate)
    if (value) return value
  }
  return ''
}

/**
 * Usage of one assistant transcript line, or null. Accepts the nested
 * Claude-Code message shape and a flat usage sibling.
 */
function readLineUsage(line: Record<string, unknown>): {
  model: string
  tsMs: number
  identity: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  credits: number
} | null {
  const type = str(line.type) || str(line.role)
  if (type !== 'assistant') return null
  const message = asRecord(line.message)
  const usage = asRecord(message?.usage) ?? asRecord(line.usage)
  if (!usage) return null
  const input = numFrom(usage, 'input_tokens', 'inputTokens', 'input')
  const output = numFrom(usage, 'output_tokens', 'outputTokens', 'output')
  const cacheRead = numFrom(usage, 'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read', 'cacheRead')
  const cacheWrite = numFrom(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write', 'cacheWrite')
  // The global build bills in credits and reports all-zero token counters; the
  // CN build reports tokens. `original_credits` is the pre-discount figure and
  // only stands in when the billed amount is absent (not merely unparseable), so
  // a discounted request is never counted at full price.
  // `credits` is the billed amount; `original_credits` is the pre-discount
  // figure. The fallback is taken only when `credits` is *absent*: a value that
  // is present but not a number is format drift, and falling back there would
  // count a discounted request at full price.
  const hasBilled = usage.credits != null
  const billed = typeof usage.credits === 'number' && Number.isFinite(usage.credits) ? usage.credits : 0
  const credits = hasBilled ? billed : numFrom(usage, 'original_credits', 'originalCredits')
  // Such a line is still a real generation: keep every counter at its honest
  // value (credits are a different unit and must not be folded into tokens).
  if (input + output + cacheRead + cacheWrite === 0 && credits <= 0) return null
  return {
    model: str(message?.model) || str(line.model) || 'unknown',
    tsMs: lineTsMs(line),
    identity: lineIdentity(line, message),
    input,
    output,
    cacheRead,
    cacheWrite,
    credits,
  }
}

/**
 * Parse one transcript file into usage records appended to `out`.
 *
 * `key` identifies the file by path (used as the fallback dedupe key for lines
 * without an id); `fileId` is its name, which is the session id — the scope a
 * message id is unique in.
 */
async function readTranscript(
  path: string,
  key: string,
  fileId: string,
  out: TranscriptRecord[],
  seen: Set<string>,
): Promise<void> {
  let text: string
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return
    text = await readFile(path, 'utf8')
  } catch {
    return
  }
  // Keyed by generation identity so a streamed message keeps only its final
  // report; the index is the fallback for lines that carry no id at all.
  const byIdentity = new Map<string, number>()
  let index = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('"usage"')) {
      index++
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      index++
      continue // torn trailing line while the agent appends
    }
    const record = asRecord(parsed)
    const usage = record ? readLineUsage(record) : null
    if (usage && usage.tsMs > 0) {
      const { model, tsMs, identity, ...counters } = usage
      const entry: TranscriptRecord = { tsMs, modelId: model, ...counters }
      // Scoped to the transcript file, not to its path: a migration copy holds
      // the same session id under a different root and must still count once,
      // while ids that are only unique inside their own session (a per-session
      // counter, a `uuid` fallback) cannot collide with another session's.
      const dedupeKey = identity ? `${fileId}:id:${identity}` : `${key}:${index}`
      const previous = identity ? byIdentity.get(identity) : undefined
      if (previous === undefined) {
        if (identity) byIdentity.set(identity, out.length)
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey)
          out.push(entry)
        }
      } else {
        // A later line for the same generation supersedes the earlier one:
        // the stream reports partial counters first and the total last.
        out[previous] = entry
      }
    }
    index++
  }
}

/** Fold the flat records into `tokscale graph`-shaped contributions */
function buildPayload(records: UsageRecord[]): unknown {
  // Grouped by client, provider and model: the two builds are two rows, and the
  // provider split keeps a vendor-prefixed model id on its own slice.
  const days = new Map<string, Map<string, Slice>>()
  for (const record of records) {
    const day = localDay(record.tsMs)
    let slices = days.get(day)
    if (!slices) {
      slices = new Map()
      days.set(day, slices)
    }
    const { providerId, modelId } = splitVendorModel(record.modelId)
    const key = `${record.clientId}\u0000${providerId}\u0000${modelId}`
    const hit = slices.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, credits: 0, messages: 0 }
    hit.input += record.input
    hit.output += record.output
    hit.cacheRead += record.cacheRead
    hit.cacheWrite += record.cacheWrite
    hit.credits += record.credits
    hit.messages += 1
    slices.set(key, hit)
  }

  const contributions = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, slices]) => {
      const totals = { tokens: 0, cost: 0, messages: 0, credits: 0 }
      const tokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const clients = [...slices.entries()].map(([key, slice]) => {
        const [client, providerId, modelId] = key.split('\u0000')
        const tokens = {
          input: slice.input,
          output: slice.output,
          cacheRead: slice.cacheRead,
          cacheWrite: slice.cacheWrite,
        }
        const total = slice.input + slice.output + slice.cacheRead + slice.cacheWrite
        // Rounded to the micro-credit, then summed into the day total, so the
        // day figure is exactly the sum of its rows (same rule as the cost
        // figure the main process reprices).
        const credits = Math.round(slice.credits * 1e6) / 1e6
        totals.tokens += total
        totals.messages += slice.messages
        totals.credits += credits
        tokenBreakdown.input += slice.input
        tokenBreakdown.output += slice.output
        tokenBreakdown.cacheRead += slice.cacheRead
        tokenBreakdown.cacheWrite += slice.cacheWrite
        // cost 0 on purpose: no local price is recorded, so the main process
        // prices these entries from the shared price table like every other one.
        return { client, modelId, providerId, tokens, cost: 0, messages: slice.messages, credits }
      })
      return { date, totals, tokenBreakdown, clients, intensity: 0, activeTimeMs: 0 }
    })

  // `totals` is summed from the very entries above so the renderer's
  // "unclassified" derivation (totals − Σclients) stays exactly zero.
  return { meta: null, contributions }
}

/**
 * Read Qoder usage into a `tokscale graph`-shaped payload.
 *
 * Config roots: `$QODER_CONFIG_DIR` (official override; attributed to whichever
 * build root it points at, and to the CN row when it points somewhere else),
 * `~/.qoder-cn` (CN build), `~/.qoder` (global build). All are scanned — a
 * machine can hold both builds — and each root feeds its own client row, with
 * paths already claimed by a root skipped so an override cannot steal a build's
 * usage for the other row.
 *
 * Deduplication is scoped to the session file name (a session id), not to the
 * file's path: a copied profile holds the same session under a different root
 * and must still count once, while ids that are only unique inside their own
 * session cannot collide with another session's. Lines without an identity fall
 * back to path + line index, which cannot collide by construction.
 *
 * Best-effort by contract — a missing store, an unreadable file or a directory
 * being rewritten mid-read must never affect the scan. Returns null when the
 * CLI has no recorded usage (or is not installed).
 */
export async function readQoderUsage(home: string, options?: { client?: string }): Promise<unknown | null> {
  try {
    const cnRoot = join(home, '.qoder-cn')
    const globalRoot = join(home, '.qoder')
    const roots: Array<{ client: string; root: string }> = []
    const claimed = new Set<string>()
    const addRoot = (client: string, root: string): void => {
      // `options.client` selects one row: the main process registers one payload
      // per client id, so the skip-when-tokscale-covers-it rule can be applied to
      // each build separately instead of to the pair.
      if (options?.client && options.client !== client) return
      const id = root.toLowerCase()
      if (claimed.has(id)) return
      claimed.add(id)
      roots.push({ client, root })
    }
    const override = process.env.QODER_CONFIG_DIR?.trim()
    if (override) {
      // The override names a config root, not a build. Attribute it to the build
      // whose root it is; anything else is the CN row, which is what the
      // override meant before the builds were split.
      const resolved = override.toLowerCase().replace(/[\\/]+$/, '')
      const isGlobal = resolved === globalRoot.toLowerCase().replace(/[\\/]+$/, '')
      addRoot(isGlobal ? GLOBAL_CLIENT_ID : DOMESTIC_CLIENT_ID, override)
    }
    addRoot(DOMESTIC_CLIENT_ID, cnRoot)
    addRoot(GLOBAL_CLIENT_ID, globalRoot)

    const records: UsageRecord[] = []
    const seen = new Set<string>()
    for (const { client, root } of roots) {
      const projects = join(root, 'projects')
      let projectDirs
      try {
        projectDirs = await readdir(projects, { withFileTypes: true })
      } catch {
        continue // no Qoder projects under this root
      }
      for (const project of projectDirs) {
        if (!project.isDirectory()) continue
        const projectDir = join(projects, project.name)
        let files
        try {
          files = await readdir(projectDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const file of files) {
          // Transcripts are `<sessionId>.jsonl` directly inside the project
          // dir; `<sessionId>/state.json` subdirectories are skipped by the
          // isFile + extension check.
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
          const parsed: TranscriptRecord[] = []
          await readTranscript(join(projectDir, file.name), `${projectDir}:${file.name}`, file.name, parsed, seen)
          for (const record of parsed) records.push({ ...record, clientId: client })
        }
      }
    }
    return records.length > 0 ? buildPayload(records) : null
  } catch {
    return null
  }
}
