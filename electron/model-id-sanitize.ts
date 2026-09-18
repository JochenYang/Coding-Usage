import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stats } from 'node:fs'

/**
 * Non-ASCII model / provider id compatibility shim.
 *
 * tokscale 4.14.0 slices a model alias with a raw byte slice at index
 * `len - 8` whenever the alias is at least 10 bytes long
 * (`crates/tokscale-core/src/lib.rs:136`) and never checks for a UTF-8
 * character boundary. Any multi-byte character — CJK, Kana, Hangul, emoji —
 * therefore panics the whole per-client scan (exit 101, empty stdout), and a
 * single alias such as `zhipuai-coding-plan/新模型` removes the entire client
 * from the dashboard. Measured against 4.14.0 over 16 id/offset pairs: the
 * panic fires exactly when byte `len - 8` lands inside a multi-byte character,
 * so `新模型x` (10 bytes) crashes while `新模型xx` (11 bytes) is clean.
 *
 * tokscale has no exclude/ignore option (`config` exposes only `timezone`) and
 * prints nothing at all when it panics, so there is no result to filter after
 * the fact — the only interception point is before the binary reads the files.
 * Every non-ASCII id value is percent-encoded to pure ASCII (`新` → `%E6%96%B0`),
 * which keeps the byte slice on a character boundary; the scan result is
 * decoded back to the original text on its way to the renderer, so the UI keeps
 * showing the real Chinese name and no token is lost.
 *
 * Percent-encoding only ever rewrites bytes >= 0x80, so decoding is
 * unambiguous: a `%XX` run with XX >= 0x80 can only come from this encoder.
 */

/** Id-bearing keys tokscale reads (session transcripts and graph payloads) */
const ID_KEYS = ['model', 'modelAlias', 'modelId', 'provider', 'providerId'] as const

/** Files larger than this are left alone — the biggest real wire.jsonl is ~2 MB */
const MAX_FILE_BYTES = 32 * 1024 * 1024

/**
 * Files touched within this window are skipped: the running agent appends to
 * its own live transcript, and rewriting that file (temp + rename) would leave
 * the writer holding the replaced inode, losing the session tail.
 */
const LIVE_FILE_GUARD_MS = 90_000

/** Recursion guard for the session-tree walk */
const MAX_WALK_DEPTH = 8

/**
 * Cheap pre-filter for the per-line scan: a line with no non-ASCII code unit
 * and no `\u` escape cannot hold anything this module needs to rewrite.
 */
const NON_ASCII_HINT = /[\u0080-\uffff]|\\u/

/**
 * Structural key match: the key must be preceded by `{` or `,` so escaped
 * look-alikes inside tool-output strings (`\"model\":`) are never touched.
 */
const ID_KEY_PATTERN = new RegExp(
  `([{,]\\s*)"(${ID_KEYS.join('|')})"(\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`,
  'g',
)

interface FileRecord {
  /** Size in bytes when the file was last verified clean */
  size: number
  mtimeMs: number
}

type SanitizeState = Record<string, FileRecord>

/** Percent-encode every non-ASCII code point, leaving ASCII bytes untouched */
function percentEncode(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x7f) {
      out += ch
      continue
    }
    for (const byte of Buffer.from(ch, 'utf8')) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/** Decode `%XX` runs whose byte is >= 0x80 back into text; anything else stays */
function percentDecode(value: string): string {
  return value.replace(/(?:%[89A-Fa-f][0-9A-Fa-f])+/g, (run) => {
    const bytes = run.match(/%[0-9A-Fa-f]{2}/g) ?? []
    return Buffer.from(bytes.map((hex) => parseInt(hex.slice(1), 16))).toString('utf8')
  })
}

function hasNonAscii(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return true
  }
  return false
}

/** Decode a JSON string literal body; null when it is not a valid literal */
function jsonStringBody(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(`"${raw}"`)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** Re-encode text as a JSON string literal body */
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * Percent-encode the non-ASCII id values of one JSONL payload.
 *
 * Works line by line on the raw bytes instead of parse + re-serialize, so
 * unrelated content (float formatting, escape style, key order) survives
 * byte-for-byte. Returns the input untouched when nothing needed rewriting.
 */
export function encodeNonAsciiIds(text: string): { text: string; changed: boolean } {
  if (!NON_ASCII_HINT.test(text)) return { text, changed: false }
  let changed = false
  const lines = text.split('\n').map((line) => {
    if (!NON_ASCII_HINT.test(line)) return line
    return line.replace(ID_KEY_PATTERN, (match, lead: string, key: string, sep: string, raw: string) => {
      // `\uXXXX` escapes hide non-ASCII from the byte-level check, so go through
      // the decoded value: it is what tokscale actually sees in memory.
      const value = jsonStringBody(raw)
      if (value == null || !hasNonAscii(value)) return match
      changed = true
      return `${lead}"${key}"${sep}"${jsonEscape(percentEncode(value))}"`
    })
  })
  return { text: lines.join('\n'), changed }
}

/**
 * Decode the ids of a `tokscale graph` payload back to their original text.
 * Pure and never throws: a payload that was never encoded passes through.
 */
export function decodeNonAsciiIds(daily: unknown): unknown {
  const root = daily as { contributions?: unknown } | null
  if (root == null || typeof root !== 'object' || !Array.isArray(root.contributions)) return daily
  let changed = false
  for (const contribution of root.contributions) {
    if (contribution == null || typeof contribution !== 'object') continue
    const clients = (contribution as { clients?: unknown }).clients
    if (!Array.isArray(clients)) continue
    for (const entry of clients) {
      if (entry == null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      for (const key of ID_KEYS) {
        const value = record[key]
        if (typeof value !== 'string' || !value.includes('%')) continue
        const decoded = percentDecode(value)
        if (decoded === value) continue
        record[key] = decoded
        changed = true
      }
    }
  }
  return changed ? root : daily
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** Every `.jsonl` file under `root`, depth-limited; unreadable branches stop the walk */
async function collectJsonlFiles(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return out
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) await collectJsonlFiles(full, depth + 1, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/**
 * Make every recorded model/provider id safe for tokscale to read, in place.
 *
 * Best-effort by contract: a missing root, an unreadable file or a failed write
 * must never affect the scan. Files the running agent may still be appending to
 * are skipped, and a state file remembers the size/mtime of every file already
 * verified so unchanged transcripts are not re-read on every refresh.
 *
 * @param roots     session roots to sweep (e.g. `~/.kimi-code/sessions`)
 * @param stateFile JSON file remembering the files already verified clean
 */
export async function ensureScannableModelIds(roots: string[], stateFile: string): Promise<void> {
  try {
    let state: SanitizeState = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed as SanitizeState
    } catch {
      // missing/corrupt state — every file is re-examined from scratch
    }

    const now = Date.now()
    let checked = false
    for (const root of roots) {
      for (const file of await collectJsonlFiles(root)) {
        try {
          const before = await statOrNull(file)
          if (!before || before.size === 0 || before.size > MAX_FILE_BYTES) continue
          if (now - before.mtimeMs < LIVE_FILE_GUARD_MS) continue
          const record = state[file]
          if (record && record.size === before.size && record.mtimeMs === before.mtimeMs) continue

          const { text, changed } = encodeNonAsciiIds(await readFile(file, 'utf8'))
          if (changed) {
            // Atomic-ish write: a half-written transcript would be worse than
            // the panic this module exists to prevent.
            const tmp = `${file}.${process.pid}.tmp`
            await writeFile(tmp, text, 'utf8')
            await rename(tmp, file)
          }
          const after = await statOrNull(file)
          state[file] = { size: after?.size ?? before.size, mtimeMs: after?.mtimeMs ?? before.mtimeMs }
          checked = true
        } catch {
          // one unreadable file must not stop the sweep
        }
      }
    }
    if (checked) await writeFile(stateFile, JSON.stringify(state), 'utf8')
  } catch {
    // best-effort — the scan itself reports what it can read
  }
}
