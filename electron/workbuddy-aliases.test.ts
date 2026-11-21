import { appendFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureWorkbuddyAliases } from './workbuddy-aliases'

/**
 * The international WorkBuddy AI app writes transcripts under
 * `~/.workbuddy-ai/projects`, which tokscale never scans — the module mirrors
 * them into `~/.workbuddy/projects` with a hard link so one inode keeps
 * append-only writes visible. Contract pinned here:
 *   - only the scanner's extension (.jsonl, case-insensitive) is mirrored;
 *   - a file already sitting in the scanned home is never touched (a real
 *     domestic session can never be clobbered);
 *   - a pre-existing hard link is adopted, a replaced source is refreshed,
 *     and vanished sources prune both the alias and the state record.
 */

const dirs: string[] = []
let home = ''
let aiHome = ''
let stateFile = ''

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(async () => {
  home = await tempDir('wb-home-')
  aiHome = await tempDir('wb-ai-')
  stateFile = join(await tempDir('wb-state-'), 'workbuddy-aliases.json')
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function putTranscript(project: string, name: string, content: string, base = aiHome): Promise<string> {
  const dir = join(base, 'projects', project)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

async function readState(): Promise<Record<string, { src: string; ino: number }>> {
  return JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, { src: string; ino: number }>
}

async function inoOf(path: string): Promise<number> {
  return (await stat(path)).ino
}

describe('ensureWorkbuddyAliases', () => {
  it('hard-links international transcripts into the scanned home, one inode with live appends', async () => {
    const source = await putTranscript('proj-1', 'session-1.jsonl', '{"type":"session"}\n')

    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    const target = join(home, 'projects', 'proj-1', 'session-1.jsonl')
    expect(await readFile(target, 'utf8')).toBe('{"type":"session"}\n')
    // One inode, not a copy: the two names share the file's index.
    expect(await inoOf(target)).toBe(await inoOf(source))
    // The state remembers exactly what this app created.
    const state = await readState()
    expect(state[target]).toEqual({ src: source, ino: await inoOf(source) })

    // Append-only writes stay visible through the alias — the reason this is
    // a link and not a snapshot copy.
    await appendFile(source, '{"type":"message"}\n', 'utf8')
    expect(await readFile(target, 'utf8')).toBe('{"type":"session"}\n{"type":"message"}\n')
  })

  it('mirrors every project but only transcript files', async () => {
    await putTranscript('proj-1', 'a.jsonl', 'a')
    // case-insensitive extension, same as tokscale's own matcher
    await putTranscript('proj-1', 'B.JSONL', 'b')
    // sidecar and non-transcript files are ignored
    await putTranscript('proj-1', 'sidecar.json', 'not-a-transcript')
    // a directory inside a project is not a transcript file
    await mkdir(join(aiHome, 'projects', 'proj-1', 'nested'), { recursive: true })
    await writeFile(join(aiHome, 'projects', 'proj-1', 'nested', 'deep.jsonl'), 'deep', 'utf8')
    // a second project mirrors on its own
    await putTranscript('proj-2', 'c.jsonl', 'c')
    // a stray file at the projects root is not a project
    await writeFile(join(aiHome, 'projects', 'loose.jsonl'), 'loose', 'utf8')

    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    expect(await readFile(join(home, 'projects', 'proj-1', 'a.jsonl'), 'utf8')).toBe('a')
    expect(await readFile(join(home, 'projects', 'proj-1', 'B.JSONL'), 'utf8')).toBe('b')
    expect(await readFile(join(home, 'projects', 'proj-2', 'c.jsonl'), 'utf8')).toBe('c')
    await expect(readFile(join(home, 'projects', 'proj-1', 'sidecar.json'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(home, 'projects', 'proj-1', 'nested', 'deep.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('never touches a file that was already in the scanned home', async () => {
    const domesticDir = join(home, 'projects', 'proj-1')
    await mkdir(domesticDir, { recursive: true })
    const domestic = join(domesticDir, 'session-1.jsonl')
    await writeFile(domestic, '{"note":"real domestic session"}\n', 'utf8')
    await putTranscript('proj-1', 'session-1.jsonl', '{"note":"international session"}\n')

    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    // The domestic session survives verbatim, and the state records no claim
    // on it (nothing was created → nothing was written).
    expect(await readFile(domestic, 'utf8')).toBe('{"note":"real domestic session"}\n')
    await expect(readState()).rejects.toThrow()
  })

  it('adopts a pre-existing hard link to the same inode instead of replacing it', async () => {
    const source = await putTranscript('proj-1', 'session-1.jsonl', '{"type":"session"}\n')
    const target = join(home, 'projects', 'proj-1', 'session-1.jsonl')
    await mkdir(join(home, 'projects', 'proj-1'), { recursive: true })
    await link(source, target)

    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    // Still the same inode, now owned by the state file.
    expect(await readFile(target, 'utf8')).toBe('{"type":"session"}\n')
    expect(await readState()).toEqual({ [target]: { src: source, ino: await inoOf(source) } })
  })

  it('refreshes our alias when the source moves on', async () => {
    const source = await putTranscript('proj-1', 'session-1.jsonl', 'first generation\n')
    await ensureWorkbuddyAliases(home, aiHome, stateFile)
    const target = join(home, 'projects', 'proj-1', 'session-1.jsonl')
    expect(await readFile(target, 'utf8')).toBe('first generation\n')

    // The app rewrote the transcript in place (new inode, same path).
    await unlink(source)
    await writeFile(source, 'second generation\n', 'utf8')
    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    expect(await readFile(target, 'utf8')).toBe('second generation\n')
    expect(await readState()).toEqual({ [target]: { src: source, ino: await inoOf(source) } })
  })

  it('prunes the alias and the record when its source transcript is deleted', async () => {
    const source = await putTranscript('proj-1', 'session-1.jsonl', 'gone soon\n')
    await ensureWorkbuddyAliases(home, aiHome, stateFile)
    const target = join(home, 'projects', 'proj-1', 'session-1.jsonl')
    expect(await stat(target)).toBeTruthy()

    await unlink(source)
    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    await expect(stat(target)).rejects.toThrow()
    expect(await readState()).toEqual({})
  })

  it('cleans stale state records without touching unrelated files', async () => {
    // A record whose target was removed elsewhere (project folder deleted on
    // another run) and one whose source is gone, pointing at an orphan file
    // this app created earlier.
    const orphanSrc = join(aiHome, 'projects', 'proj-1', 'session-1.jsonl')
    await putTranscript('proj-1', 'session-1.jsonl', 'live\n')
    const orphanTarget = join(home, 'projects', 'proj-9', 'session-9.jsonl')
    await mkdir(join(home, 'projects', 'proj-9'), { recursive: true })
    await writeFile(orphanTarget, 'orphan\n', 'utf8')
    await writeFile(
      stateFile,
      JSON.stringify({
        [join(home, 'projects', 'proj-x', 'session-x.jsonl')]: { src: orphanSrc, ino: 1 },
        [orphanTarget]: { src: join(aiHome, 'projects', 'proj-9', 'session-9.jsonl'), ino: 2 },
      }),
      'utf8',
    )

    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    // The orphan target whose source vanished is unlinked; the record whose
    // target is already gone is simply dropped. The live project still counts.
    await expect(stat(orphanTarget)).rejects.toThrow()
    const state = await readState()
    expect(Object.keys(state)).toEqual([join(home, 'projects', 'proj-1', 'session-1.jsonl')])
  })

  it('is a no-op when the international home is missing', async () => {
    await rm(aiHome, { recursive: true, force: true })
    const projects = join(home, 'projects')
    await mkdir(projects, { recursive: true })

    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    expect(await readdir(projects)).toEqual([])
    await expect(readState()).rejects.toThrow()
  })

  it('recovers from a corrupt state file by re-examining every alias', async () => {
    const source = await putTranscript('proj-1', 'session-1.jsonl', 'recoverable\n')
    await mkdir(join(home, 'projects', 'proj-1'), { recursive: true })
    await writeFile(stateFile, '{corrupt', 'utf8')

    await ensureWorkbuddyAliases(home, aiHome, stateFile)

    const target = join(home, 'projects', 'proj-1', 'session-1.jsonl')
    expect(await readFile(target, 'utf8')).toBe('recoverable\n')
    expect(await inoOf(target)).toBe(await inoOf(source))
    expect(await readState()).toEqual({ [target]: { src: source, ino: await inoOf(source) } })
  })
})
