import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

/**
 * Safe read/write primitives for the two agent config files.
 *
 * Both agents' own writers share the same shape — read the whole document,
 * mutate one subtree, write a temp file, rename it over the original — so this
 * module keeps that contract in one place and adds the two guarantees a GUI
 * needs on top of it:
 *
 *   - **compare-and-swap**: a write carries the hash of the text it was derived
 *     from; if the file changed in between (the agent itself, another tool, or
 *     a hand edit), the write is refused instead of clobbering it.
 *   - **backup before overwrite**: a byte-for-byte copy lands next to the file
 *     under a name that identifies this feature, so a bad write is always
 *     recoverable without relying on the app's own undo.
 *
 * Neither agent takes a cross-process lock we can participate in (kimicode's
 * `acquire()` is a no-op; mcode uses a lockfile this process does not hold), so
 * refusing on drift is the only honest concurrency story available.
 */

/** Prefix identifying backups written by the Agent config feature */
export const BACKUP_PREFIX = '.bak-agentconfig-'

export interface ConfigSnapshot {
  path: string
  text: string
  /** sha256 of `text`, hex — the CAS token */
  hash: string
  /** Last modification time in epoch ms, for human-readable drift reports */
  mtimeMs: number
}

export type WriteOutcome =
  | { ok: true; backupPath: string; snapshot: ConfigSnapshot }
  | { ok: false; reason: 'conflict'; expectedHash: string; actualHash: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'failed'; message: string }

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Read a config file into a snapshot; null when it does not exist */
export async function readSnapshot(path: string): Promise<ConfigSnapshot | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    // A file that vanished between read and stat keeps mtime 0; the hash is
    // what the CAS actually relies on.
  }
  return { path, text, hash: sha256(text), mtimeMs }
}

/** `config.toml` → `config.toml.bak-agentconfig-20260921-103045` */
function backupPathFor(path: string, at: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${path}${BACKUP_PREFIX}${stamp}`
}

/** Copy the current file aside; returns the backup path */
export function writeBackup(path: string, at = new Date()): string {
  const backupPath = backupPathFor(path, at)
  copyFileSync(path, backupPath)
  return backupPath
}

/**
 * One write queue per file path.
 *
 * The renderer can fire two saves in quick succession (double click, two
 * drawers), and interleaving a backup/rename pair from two writers would be
 * worse than serializing them. The queue is process-local, which is exactly the
 * scope this app owns.
 */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve()
  const next = prev.then(task, task)
  // Keep the chain alive without leaking rejections into the next writer.
  queues.set(
    path,
    next.catch(() => undefined),
  )
  return next
}

/**
 * Replace a config file's contents.
 *
 * `expected` is the snapshot the caller derived its new text from. When the
 * file on disk no longer matches it, nothing is written and the caller is told
 * to reload — the alternative (last writer wins) silently destroys whatever the
 * agent or the user changed in the meantime.
 */
export function writeSnapshot(
  path: string,
  nextText: string,
  expected: ConfigSnapshot,
): Promise<WriteOutcome> {
  return enqueue(path, async (): Promise<WriteOutcome> => {
    if (!existsSync(path)) return { ok: false, reason: 'missing' }

    const current = await readSnapshot(path)
    if (!current) return { ok: false, reason: 'missing' }
    if (current.hash !== expected.hash) {
      return { ok: false, reason: 'conflict', expectedHash: expected.hash, actualHash: current.hash }
    }

    const backupPath = writeBackup(path, new Date())
    const tmpPath = `${path}.tmp-agentconfig-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      writeFileSync(tmpPath, nextText, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmpPath, path)
    } catch (e) {
      // Leave the original in place and drop the temp file; the backup stays so
      // the user can see exactly what the file looked like before the attempt.
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        // best effort — a leftover temp file is harmless
      }
      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) }
    }

    const written = await readSnapshot(path)
    if (!written) return { ok: false, reason: 'failed', message: 'config file vanished after write' }
    return { ok: true, backupPath, snapshot: written }
  })
}
