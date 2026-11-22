import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The settings mirror: a copy of the encrypted settings document kept in
 * userData and read back by startup recovery when localStorage has lost the
 * original. Because it may be the only copy of the user's accounts, three
 * things hold for every access:
 *
 * - It is replaced in one step, never truncated. A plain writeFile empties
 *   the file first, so a crash mid-write — or a reader during the write —
 *   is left with nothing.
 * - The staged copy is flushed to disk before it takes the mirror's place,
 *   so a power loss right after the move does not leave an empty file.
 * - Reads and writes take turns. On Windows a rename that replaces a file
 *   another handle has open fails with EPERM, and a read that lands on that
 *   same instant finds no file at all; queueing the accesses removes the
 *   overlap that produces both. Every access the app makes goes through this
 *   module, so the app never overlaps with itself. A process outside the app
 *   that reads the mirror at the wrong moment can still make a write fail
 *   after its retries: the write rejects, the previous copy stays as it was,
 *   and the next launch writes the mirror again.
 */

const FILE_NAME = 'settings-backup.json'
/**
 * How often a write is tried again while Windows refuses it because another
 * process holds the file. A write that is still refused is dropped and redone
 * by the next launch, so it gives up early.
 */
const WRITE_ATTEMPTS = 5
/**
 * How often the read is tried again. A launch that gives up shows no accounts
 * until it is restarted, and a scanner holding the file at launch is exactly
 * the case worth waiting out, so the read waits longer than a write.
 */
const READ_ATTEMPTS = 10
const BUSY_RETRY_MS = 20

let queue: Promise<unknown> = Promise.resolve()

/** Run `task` once every access queued before it has settled. */
function takeTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Run `task`, trying again up to `attempts` times while Windows refuses it
 * because another process holds the file open (an indexer, a scanner); it
 * lets go on its own. Anything else, and the last refusal, is thrown as it
 * came.
 */
async function whileHeldOpen<T>(task: () => Promise<T>, attempts: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const busy = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!busy || attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS * attempt))
    }
  }
}

/**
 * The mirror's last saved contents, or null when there is none yet. Any
 * other failure rejects: a mirror that exists but cannot be read may well be
 * intact, and reporting it as "nothing to restore" would let the caller
 * overwrite it with empty settings.
 */
export function readSettingsMirror(userData: string): Promise<string | null> {
  return takeTurn(() =>
    whileHeldOpen(
      async () => {
        try {
          return await readFile(join(userData, FILE_NAME), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      },
      READ_ATTEMPTS,
    ),
  )
}

/**
 * Save the mirror, replacing the previous copy in one step. Rejects only
 * when the staged copy could not be written and moved over the mirror even
 * after retries; the previous copy is left as it was in that case.
 */
export function writeSettingsMirror(userData: string, payload: string): Promise<void> {
  return takeTurn(async () => {
    const target = join(userData, FILE_NAME)
    const staged = `${target}.${process.pid}.tmp`
    try {
      const handle = await open(staged, 'w')
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await whileHeldOpen(() => rename(staged, target), WRITE_ATTEMPTS)
    } catch (error) {
      // The mirror is unchanged; do not leave the staged copy behind as well
      await unlink(staged).catch(() => {})
      throw error
    }
  })
}
