import { copyFile, link, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Stats } from 'node:fs'

/**
 * DSH transcript-name compatibility shim.
 *
 * tokscale's DSH scanner discovers transcripts by their canonical file names
 * (`session.jsonl` / `session.jsonl.zstd`); the DSH app moved its transcripts
 * to versioned names (`session.v3.jsonl.zstd`, and `session.v4.jsonl.zstd` on
 * the 0.1.7-rc kernel line, also written by the SkillSpace internal build
 * which shares the same `~/.dsh` home), which the scanner never matches — DSH
 * usage silently freezes at the day of the rename (reproduced against
 * tokscale 4.14.0, 4.15.1 and its current main branch; a renamed file parses
 * fine). Alias each versioned transcript to the canonical name with a hard
 * link: one inode keeps append-only writes visible, nothing is copied, and
 * the versioned file stays the single source of truth.
 *
 * A state file remembers the links this app created. Only remembered aliases
 * are ever replaced (when the v3 file itself was replaced and the link went
 * stale); a canonical file the app did not create — e.g. a pre-migration
 * original kept beside a migrated v3 copy — is never touched, so no session
 * is ever counted twice. Volumes without hard links fall back to a copy that
 * is re-copied whenever the source moves on.
 */

/**
 * Transcript versions recognized by the alias shim, newest first. A session
 * directory can carry several versions side by side (a migrating kernel
 * leaves the old file behind); aliasing more than one would flip the
 * canonical between them on every sweep, so only the highest version present
 * feeds the alias for each canonical name.
 */
const SOURCE_VERSIONS = ['v4', 'v3'] as const

/** Canonical-name suffixes a versioned transcript can alias onto */
const SOURCE_SUFFIXES = ['.jsonl.zstd', '.jsonl'] as const

/** What was created for one alias path; `ino: -1` marks a copy fallback */
interface AliasRecord {
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
async function createAlias(source: string, alias: string, v: Stats): Promise<AliasRecord | null> {
  try {
    await link(source, alias)
    return { ino: v.ino }
  } catch {
    // exFAT/FAT or a race — the copy fallback still beats a frozen card
  }
  try {
    await copyFile(source, alias)
    return { ino: -1, size: v.size, mtimeMs: v.mtimeMs }
  } catch {
    return null
  }
}

/** True when a copy-fallback alias still matches its source */
function copyIsCurrent(rec: AliasRecord | undefined, v: Stats): boolean {
  return rec != null && rec.ino === -1 && rec.size === v.size && rec.mtimeMs === v.mtimeMs
}

/**
 * Make every versioned (`session.vN.*`) transcript visible to tokscale under
 * the canonical name. Best-effort: a missing/unreadable DSH root must never
 * affect the scan.
 *
 * @param dshRoot   DSH home (`DSH_HOME` or `~/.dsh`) — `sessions/` lives inside
 * @param stateFile JSON file remembering the aliases this app created
 */
export async function ensureDshSessionAliases(dshRoot: string, stateFile: string): Promise<void> {
  try {
    let state: AliasState = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed as AliasState
    } catch {
      // missing/corrupt state — every alias is re-examined from scratch
    }

    let dirty = false
    const sessions = join(dshRoot, 'sessions')
    const projects = await readdir(sessions, { withFileTypes: true })
    for (const project of projects) {
      if (!project.isDirectory()) continue
      try {
        const projectDir = join(sessions, project.name)
        const dirs = await readdir(projectDir, { withFileTypes: true })
        for (const dir of dirs) {
          if (!dir.isDirectory()) continue
          const sessionDir = join(projectDir, dir.name)
          // One alias target per canonical suffix, fed by the newest versioned
          // source present — see SOURCE_VERSIONS.
          for (const suffix of SOURCE_SUFFIXES) {
            let source: string | null = null
            let v: Stats | null = null
            for (const version of SOURCE_VERSIONS) {
              const candidate = join(sessionDir, `session.${version}${suffix}`)
              const stats = await statOrNull(candidate)
              if (stats) {
                source = candidate
                v = stats
                break
              }
            }
            if (!source || !v) continue
            const alias = join(sessionDir, `session${suffix}`)
            const a = await statOrNull(alias)
            const rec = state[alias]

            if (!a) {
              const created = await createAlias(source, alias, v)
              if (created) {
                state[alias] = created
                dirty = true
              }
              continue
            }
            // A live hard link to the current source — ours or pre-existing, adopt it
            if (a.ino !== 0 && a.ino === v.ino) {
              if (rec?.ino !== v.ino) {
                state[alias] = { ino: v.ino }
                dirty = true
              }
              continue
            }
            if (copyIsCurrent(rec, v)) continue
            if (!rec) continue // a canonical file we did not create — never touch it
            // Our alias, but the source moved on (replaced) — refresh the link.
            await unlink(alias).catch(() => {})
            const created = await createAlias(source, alias, v)
            if (created) state[alias] = created
            else delete state[alias]
            dirty = true
          }
        }
      } catch {
        // one unreadable project must not stop the sweep
      }
    }

    // Prune: forgotten aliases (session dir gone) and orphaned ones (every
    // versioned source was deleted while our hard link kept the old data
    // alive).
    for (const alias of Object.keys(state)) {
      const dir = dirname(alias)
      const suffix = alias.endsWith('.zstd') ? '.jsonl.zstd' : '.jsonl'
      let source: string | null = null
      for (const version of SOURCE_VERSIONS) {
        const candidate = join(dir, `session.${version}${suffix}`)
        if (await statOrNull(candidate)) {
          source = candidate
          break
        }
      }
      if (!source) {
        await unlink(alias).catch(() => {})
        delete state[alias]
        dirty = true
        continue
      }
      if (!(await statOrNull(alias))) {
        delete state[alias]
        dirty = true
      }
    }

    if (dirty) await writeFile(stateFile, JSON.stringify(state), 'utf8')
  } catch {
    // best-effort — the scan itself reports what it can read
  }
}
