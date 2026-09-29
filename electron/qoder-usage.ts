import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Qoder CLI (`qoder`) local usage reader.
 *
 * tokscale has no Qoder reader (verified against 4.14.0). The Qoder CLI keeps
 * Claude-Code-shaped session transcripts under `<config>/projects/<project>/
 * <sessionId>.jsonl` (documented at docs.qoder.com/cli/sessions; the CLI
 * binary carries the very same Anthropic usage field names), where `<config>`
 * is `~/.qoder` (global) or `~/.qoder-cn` (CN build), overridable through
 * `QODER_CONFIG_DIR`. Transcript lines embed an assistant `usage` object with
 * `input_tokens` / `output_tokens` / `cache_read_input_tokens` /
 * `cache_creation_input_tokens`, a `model` and a timestamp.
 *
 * No verified real-world sample was available when this was written (the CLI
 * on the reference machine had never held a session), so the line parser
 * accepts both the nested Claude-Code shape (`{type:'assistant', message:
 * {model, usage}}`) and flatter `{role:'assistant', model, usage}` variants,
 * with snake_case and camelCase counter spellings. Treat field drift as a
 * maintenance item: a format change degrades to "no Qoder usage", never to a
 * wrong number.
 *
 * Privacy: only token counters and model ids are read — never prompt or
 * response content.
 */

/** Client id this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts) */
const CLIENT_ID = 'qoder'

/** Provider every Qoder generation is attributed to */
const PROVIDER_ID = 'qoder'

/** Skip absurdly large transcripts (real ones stay well below this) */
const MAX_FILE_BYTES = 64 * 1024 * 1024

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
 * `vendor/model` → provider + model; a bare id stays Qoder-attributed (the
 * gateway serves first-party models under plain names).
 */
function splitVendorModel(model: string): { providerId: string; modelId: string } {
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
 * Usage of one assistant transcript line, or null. Accepts the nested
 * Claude-Code message shape and a flat usage sibling.
 */
function readLineUsage(line: Record<string, unknown>): {
  model: string
  tsMs: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
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
  // Qoder CN's first-party models bill in credits and report all-zero token
  // counters. Such a line is still a real generation: count the message and
  // keep every token counter at its honest zero (credits are a different
  // unit and must not be folded into tokens).
  const creditsBilled = numFrom(usage, 'credits') > 0
  if (input + output + cacheRead + cacheWrite === 0 && !creditsBilled) return null
  return {
    model: str(message?.model) || str(line.model) || 'unknown',
    tsMs: lineTsMs(line),
    input,
    output,
    cacheRead,
    cacheWrite,
  }
}

/** Parse one transcript file into usage records appended to `out` */
async function readTranscript(path: string, key: string, out: UsageRecord[], seen: Set<string>): Promise<void> {
  let text: string
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return
    text = await readFile(path, 'utf8')
  } catch {
    return
  }
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
      const dedupe = `${key}:${index}`
      if (!seen.has(dedupe)) {
        seen.add(dedupe)
        const { model, tsMs, ...counters } = usage
        out.push({ tsMs, modelId: model, ...counters })
      }
    }
    index++
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
 * Read Qoder CLI usage into a `tokscale graph`-shaped payload.
 *
 * Config roots, in order: `$QODER_CONFIG_DIR` (official override),
 * `~/.qoder` (global build), `~/.qoder-cn` (CN build). All are scanned — a
 * machine can hold both builds — and transcripts are deduplicated by path +
 * line index, so shared or symlinked roots never double count.
 *
 * Best-effort by contract — a missing store, an unreadable file or a directory
 * being rewritten mid-read must never affect the scan. Returns null when the
 * CLI has no recorded usage (or is not installed).
 */
export async function readQoderUsage(home: string): Promise<unknown | null> {
  try {
    const roots: string[] = []
    const override = process.env.QODER_CONFIG_DIR?.trim()
    if (override) roots.push(override)
    roots.push(join(home, '.qoder'), join(home, '.qoder-cn'))

    const records: UsageRecord[] = []
    const seen = new Set<string>()
    for (const root of roots) {
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
          await readTranscript(join(projectDir, file.name), `${projectDir}:${file.name}`, records, seen)
        }
      }
    }
    return records.length > 0 ? buildPayload(records) : null
  } catch {
    return null
  }
}
