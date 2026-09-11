import { copyFile, link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stats } from 'node:fs'

/**
 * WorkBuddy AI (international) transcript alias.
 *
 * The domestic WorkBuddy app stores its transcripts under
 * `~/.workbuddy/projects/` — the only location tokscale's WorkBuddy scanner
 * discovers. The international WorkBuddy AI app keeps the same transcript
 * format under `~/.workbuddy-ai/projects/`, which tokscale never looks at:
 * its usage silently vanishes from the local scan (reproduced against
 * tokscale 4.14.0 — the identical transcript parses under `.workbuddy` but
 * yields zero under `.workbuddy-ai`). Alias every international transcript
 * into the scanned home with a hard link: one inode keeps append-only writes
 * visible, nothing is copied, and the original stays the single source of
 * truth.
 *
 * A state file remembers the links this app created. Only remembered aliases
 * are ever replaced or removed; a file that was already present in the
 * scanned home is never touched, so a real domestic session can never be
 * clobbered. Volumes without hard links fall back to a copy that is re-copied
 * when the source moves on.
 */

/** What was created for one alias target; `ino: -1` marks a copy fallback */
interface AliasRecord {
  /** Source path this alias mirrors */
  src: string
  /** Source inode at creation time (hard link), or -1 for the copy fallback */
  ino: number
  /** Copy fallback: source size/mtime when the copy was taken */
  size?: number
  mtimeMs?: number
}

type AliasState = Record<string, AliasRecord>

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** Hard link, falling back to a copy on volumes without hard links */
async function createAlias(source: string, target: string, v: Stats): Promise<AliasRecord | null> {
  try {
    await link(source, target)
    return { src: source, ino: v.ino }
  } catch {
    // Cross-volume or a link-hostile filesystem — a refreshed copy still works
  }
  try {
    await copyFile(source, target)
    return { src: source, ino: -1, size: v.size, mtimeMs: v.mtimeMs }
  } catch {
    return null
  }
}

/** True when a copy-fallback alias still matches its source */
function copyIsCurrent(rec: AliasRecord | undefined, v: Stats): boolean {
  return rec != null && rec.ino === -1 && rec.size === v.size && rec.mtimeMs === v.mtimeMs
}

/**
 * Mirror every `~/.workbuddy-ai/projects/<project>/*.jsonl` transcript into
 * `~/.workbuddy/projects/<project>/` so tokscale's scanner sees it.
 * Best-effort: a missing international home must never affect the scan.
 *
 * @param workbuddyHome    Scanned home (`~/.workbuddy`)
 * @param workbuddyAiHome  International home (`~/.workbuddy-ai`)
 * @param stateFile        JSON file remembering the aliases this app created
 */
export async function ensureWorkbuddyAliases(
  workbuddyHome: string,
  workbuddyAiHome: string,
  stateFile: string,
): Promise<void> {
  try {
    let state: AliasState = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed as AliasState
    } catch {
      // missing/corrupt state — every alias is re-examined from scratch
    }

    let dirty = false
    const sourceProjects = join(workbuddyAiHome, 'projects')
    const targetProjects = join(workbuddyHome, 'projects')
    const projects = await readdir(sourceProjects, { withFileTypes: true }).catch(() => [])
    for (const project of projects) {
      if (!project.isDirectory()) continue
      try {
        const sourceDir = join(sourceProjects, project.name)
        const targetDir = join(targetProjects, project.name)
        let ensuredDir = false
        const files = await readdir(sourceDir, { withFileTypes: true })
        for (const file of files) {
          // Only `.jsonl` transcripts carry usage; tokscale matches the same
          // extension (case-insensitively) and ignores sidecar files.
          if (!file.isFile() || !file.name.toLowerCase().endsWith('.jsonl')) continue
          const source = join(sourceDir, file.name)
          const v = await statOrNull(source)
          if (!v) continue
          const target = join(targetDir, file.name)
          const t = await statOrNull(target)
          const rec = state[target]

          if (!t) {
            if (!ensuredDir) {
              await mkdir(targetDir, { recursive: true }).catch(() => {})
              ensuredDir = true
            }
            const created = await createAlias(source, target, v)
            if (created) {
              state[target] = created
              dirty = true
            }
            continue
          }
          // A live hard link to the current source — ours or pre-existing, adopt it
          if (t.ino !== 0 && t.ino === v.ino) {
            if (rec?.ino !== v.ino) {
              state[target] = { src: source, ino: v.ino }
              dirty = true
            }
            continue
          }
          if (copyIsCurrent(rec, v)) continue
          if (!rec) continue // a real file already sitting there — never touch it
          // Our alias, but the source moved on (replaced) — refresh it.
          await unlink(target).catch(() => {})
          const created = await createAlias(source, target, v)
          if (created) state[target] = created
          else delete state[target]
          dirty = true
        }
      } catch {
        // one unreadable project must not stop the sweep
      }
    }

    // Prune: aliases whose source vanished (session deleted, or the app was
    // uninstalled) and records whose target link is gone.
    for (const target of Object.keys(state)) {
      if (!(await statOrNull(state[target].src))) {
        await unlink(target).catch(() => {})
        delete state[target]
        dirty = true
        continue
      }
      if (!(await statOrNull(target))) {
        delete state[target]
        dirty = true
      }
    }

    if (dirty) await writeFile(stateFile, JSON.stringify(state), 'utf8')
  } catch {
    // best-effort — the scan itself reports what it can read
  }
}
