import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_PREFIX, readSnapshot, writeBackup, writeSnapshot } from './agent-config-io'

/**
 * The io layer is what stands between this app and another application's
 * config file: every write carries the hash of the text it was derived from
 * (compare-and-swap) and a recoverable backup is copied aside before the
 * rename — docs/ARCHITECTURE.md promises exactly that pair for the Agent
 * configuration feature. Both guarantees are pinned here against real files in
 * a temporary directory.
 */

const dirs: string[] = []
let filePath = ''

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Directory the config file lives in */
function dirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx > 0 ? p.slice(0, idx) : p
}

beforeEach(async () => {
  const dir = await tempDir('agent-config-io-')
  filePath = join(dir, 'config.toml')
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('readSnapshot', () => {
  it('returns the text, its sha256 and the mtime', async () => {
    await writeFile(filePath, 'hello = "world"\n', 'utf8')
    const snapshot = await readSnapshot(filePath)
    expect(snapshot?.text).toBe('hello = "world"\n')
    expect(snapshot?.hash).toBe(sha('hello = "world"\n'))
    expect(snapshot?.mtimeMs).toBeGreaterThan(0)
  })

  it('returns null for a missing file instead of throwing', async () => {
    await expect(readSnapshot(filePath)).resolves.toBeNull()
  })
})

describe('writeBackup', () => {
  it('copies the file aside under a dated, feature-owned name', async () => {
    await writeFile(filePath, 'original', 'utf8')
    const backupPath = writeBackup(filePath, new Date(2026, 8, 21, 10, 30, 45))
    expect(backupPath).toBe(`${filePath}${BACKUP_PREFIX}20260921-103045`)
    await expect(readFile(backupPath, 'utf8')).resolves.toBe('original')
  })
})

describe('writeSnapshot', () => {
  it('replaces the content and reports the new snapshot', async () => {
    await writeFile(filePath, 'before', 'utf8')
    const expected = await readSnapshot(filePath)
    const outcome = await writeSnapshot(filePath, 'after', expected!)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.snapshot.hash).toBe(sha('after'))
    await expect(readFile(filePath, 'utf8')).resolves.toBe('after')
  })

  it('leaves a byte-for-byte backup of the previous content next to the file', async () => {
    await writeFile(filePath, 'before', 'utf8')
    const expected = await readSnapshot(filePath)
    const outcome = await writeSnapshot(filePath, 'after', expected!)
    expect(outcome.ok).toBe(true)
    const backupPath = outcome.ok ? outcome.backupPath : ''
    expect(backupPath.startsWith(`${filePath}${BACKUP_PREFIX}`)).toBe(true)
    await expect(readFile(backupPath, 'utf8')).resolves.toBe('before')
    const siblings = await readdir(dirOf(filePath))
    expect(siblings.filter((name) => name.includes(BACKUP_PREFIX))).toHaveLength(1)
  })

  it('does not leave a temp file behind', async () => {
    await writeFile(filePath, 'before', 'utf8')
    const expected = await readSnapshot(filePath)
    await writeSnapshot(filePath, 'after', expected!)
    const leftovers = (await readdir(dirOf(filePath))).filter((name) => name.includes('.tmp-agentconfig-'))
    expect(leftovers).toEqual([])
  })

  it('refuses the write and keeps the file when the content drifted', async () => {
    await writeFile(filePath, 'mine', 'utf8')
    const expected = await readSnapshot(filePath)
    // Another process (the agent itself, a hand edit) rewrites the file.
    await writeFile(filePath, 'changed-by-agent', 'utf8')
    const outcome = await writeSnapshot(filePath, 'clobber', expected!)
    expect(outcome).toEqual({
      ok: false,
      reason: 'conflict',
      expectedHash: expected!.hash,
      actualHash: sha('changed-by-agent'),
    })
    await expect(readFile(filePath, 'utf8')).resolves.toBe('changed-by-agent')
  })

  it('reports missing when the file vanished after the read', async () => {
    await writeFile(filePath, 'gone-soon', 'utf8')
    const expected = await readSnapshot(filePath)
    await unlink(filePath)
    const outcome = await writeSnapshot(filePath, 'nope', expected!)
    expect(outcome).toEqual({ ok: false, reason: 'missing' })
  })

  it('serializes two racing writers instead of interleaving their backup/rename pairs', async () => {
    await writeFile(filePath, 'start', 'utf8')
    const expected = await readSnapshot(filePath)
    // Both writers derive from the same snapshot; only the first may land.
    const [first, second] = await Promise.all([
      writeSnapshot(filePath, 'first-write', expected!),
      writeSnapshot(filePath, 'second-write', expected!),
    ])
    expect(first.ok).toBe(true)
    expect(second).toEqual({
      ok: false,
      reason: 'conflict',
      expectedHash: expected!.hash,
      actualHash: sha('first-write'),
    })
    await expect(readFile(filePath, 'utf8')).resolves.toBe('first-write')
  })

  it('rewrites in place when the file still matches the snapshot byte for byte', async () => {
    await writeFile(filePath, 'same', 'utf8')
    const expected = await readSnapshot(filePath)
    // The agent rewrote the identical content between read and write.
    await writeFile(filePath, 'same', 'utf8')
    const outcome = await writeSnapshot(filePath, 'next', expected!)
    expect(outcome.ok).toBe(true)
    await expect(readFile(filePath, 'utf8')).resolves.toBe('next')
  })
})
