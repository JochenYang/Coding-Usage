import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSettingsMirror, writeSettingsMirror } from './settings-mirror'

// Only `open`, `rename` and `readFile` are wrapped, so a test can make a
// write fail or Windows' "file is in use" refusal happen on demand; everything
// else stays the real filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    readFile: vi.fn(actual.readFile),
  }
})

/**
 * The mirror may be the only copy of the user's accounts, so it must never
 * be seen empty or half-written, and a write must not be lost to a reader
 * that happens to be looking at the same moment.
 */

const tempDirs: string[] = []
async function newUserDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'settings-mirror-'))
  tempDirs.push(dir)
  return dir
}
const mirrorOf = (dir: string): string => join(dir, 'settings-backup.json')
const heldOpen = (): Error => Object.assign(new Error('resource busy'), { code: 'EBUSY' })

beforeEach(() => {
  // Back to the real calls: a test may have left a refusal in place
  vi.mocked(open).mockReset()
  vi.mocked(rename).mockReset()
  vi.mocked(readFile).mockReset()
})
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

describe('readSettingsMirror', () => {
  it('is null before anything was ever saved', async () => {
    expect(await readSettingsMirror(await newUserDataDir())).toBeNull()
  })

  it('returns the saved contents', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, '{"providers":{}}')
    expect(await readSettingsMirror(dir)).toBe('{"providers":{}}')
  })

  it('rejects when the mirror exists but cannot be read', async () => {
    // A directory in the mirror's place stands in for any read failure
    const dir = await newUserDataDir()
    await mkdir(mirrorOf(dir))
    // Not "no mirror": the caller must not treat this as nothing to restore
    await expect(readSettingsMirror(dir)).rejects.toThrow()
  })

  it('retries while another process holds the mirror open', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, '{"providers":{}}')
    vi.mocked(readFile).mockRejectedValueOnce(heldOpen())

    expect(await readSettingsMirror(dir)).toBe('{"providers":{}}')
    expect(vi.mocked(readFile).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('gives up after a few refusals and rejects rather than reporting no mirror', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, '{"providers":{}}')
    vi.mocked(readFile).mockRejectedValue(heldOpen())

    // Not null: a mirror that will not open may well be intact
    await expect(readSettingsMirror(dir)).rejects.toThrow('resource busy')
  })
})

describe('writeSettingsMirror', () => {
  it('creates the mirror and leaves no staged copy behind', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, 'first')
    expect(await readFile(mirrorOf(dir), 'utf8')).toBe('first')
    expect(await readdir(dir)).toEqual(['settings-backup.json'])
  })

  it('replaces the previous copy', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, 'previous')
    await writeSettingsMirror(dir, 'next')
    expect(await readFile(mirrorOf(dir), 'utf8')).toBe('next')
    expect(await readdir(dir)).toEqual(['settings-backup.json'])
  })

  it('rejects when the mirror cannot be written, and leaves nothing behind', async () => {
    const dir = await newUserDataDir()
    await expect(writeSettingsMirror(join(dir, 'missing'), 'x')).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })

  it('leaves nothing behind when the staged copy itself cannot be written', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, 'previous')
    const staged = `${mirrorOf(dir)}.${process.pid}.tmp`
    vi.mocked(open).mockResolvedValueOnce({
      // A real partial file, and then the disk reports it is full
      writeFile: async () => {
        await writeFile(staged, 'ne')
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      },
      sync: async () => {},
      close: async () => {},
    } as unknown as FileHandle)

    await expect(writeSettingsMirror(dir, 'next')).rejects.toThrow('no space left on device')

    expect(await readFile(mirrorOf(dir), 'utf8')).toBe('previous')
    expect(await readdir(dir)).toEqual(['settings-backup.json'])
  })

  it('retries the rename while another process holds the mirror open', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, 'previous')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('file is in use'), { code: 'EPERM' }))

    await writeSettingsMirror(dir, 'next')

    expect(vi.mocked(rename).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await readFile(mirrorOf(dir), 'utf8')).toBe('next')
    expect(await readdir(dir)).toEqual(['settings-backup.json'])
  })

  it('gives up after a few refusals and keeps the previous copy intact', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, 'previous')
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('file is in use'), { code: 'EPERM' }))

    await expect(writeSettingsMirror(dir, 'next')).rejects.toThrow('file is in use')

    expect(await readFile(mirrorOf(dir), 'utf8')).toBe('previous')
    expect(await readdir(dir)).toEqual(['settings-backup.json'])
  })
})

describe('reads and writes take turns', () => {
  it('a queued reader never sees an empty or partial mirror, and no write is lost to it', async () => {
    const dir = await newUserDataDir()
    const PREVIOUS = 'p'.repeat(256 * 1024)
    const NEXT = 'n'.repeat(256 * 1024)
    await writeSettingsMirror(dir, PREVIOUS)

    // Read through the mirror's own queue while a run of replacements is in
    // flight. With unqueued access this is where a reader found nothing and
    // the rename was refused.
    const seen = new Set<string>()
    let reading = true
    const reader = (async () => {
      while (reading) {
        seen.add((await readSettingsMirror(dir)) ?? 'NO MIRROR')
      }
    })()
    const failures: unknown[] = []
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        writeSettingsMirror(dir, i % 2 ? NEXT : PREVIOUS).catch((error: unknown) => failures.push(error)),
      ),
    )
    reading = false
    await reader

    expect(failures).toEqual([])
    expect([...seen].sort()).toEqual([NEXT, PREVIOUS].sort())
    expect(await readdir(dir)).toEqual(['settings-backup.json'])
  })

  it('a read queued behind a write sees what that write saved', async () => {
    const dir = await newUserDataDir()
    await writeSettingsMirror(dir, 'previous')
    const [written, read] = await Promise.all([
      writeSettingsMirror(dir, 'next').then(() => 'written'),
      readSettingsMirror(dir),
    ])
    // Both go through the queue in call order, so the read lands after the write
    expect(written).toBe('written')
    expect(read).toBe('next')
  })

  it('a reader that skips the queue never finds the mirror empty or half-written', async () => {
    const dir = await newUserDataDir()
    const PREVIOUS = 'p'.repeat(256 * 1024)
    const NEXT = 'n'.repeat(256 * 1024)
    await writeSettingsMirror(dir, PREVIOUS)

    // Another process — a backup tool, a sync agent — knows nothing of this
    // queue and reads whenever it likes. The one-step replacement has to hold
    // for it too: it gets the whole previous copy, the whole new one, or, in
    // the instant of the move, no file. A plain writeFile would be caught
    // here with the mirror truncated.
    const seen = new Set<string>()
    const refused = new Set<string>()
    let reading = true
    const reader = (async () => {
      while (reading) {
        await readFile(mirrorOf(dir), 'utf8').then(
          (text) => void seen.add(text),
          (error: NodeJS.ErrnoException) => void refused.add(error.code ?? String(error)),
        )
        // An outside reader comes back now and then; it does not spin on the file
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    })()
    const WRITES = 30
    // A write the reader keeps refused for good is not what this test is
    // about: it rejects, as documented, and the next launch writes the mirror
    // again. What must hold is what the reader saw meanwhile.
    const failures: unknown[] = []
    await Promise.all(
      Array.from({ length: WRITES }, (_, i) =>
        writeSettingsMirror(dir, i % 2 ? NEXT : PREVIOUS).catch((error: unknown) => failures.push(error)),
      ),
    )
    reading = false
    await reader

    // The reader did look while replacements were going on, and never found
    // the mirror empty or half-written
    expect(seen.size).toBeGreaterThan(0)
    for (const text of seen) expect([PREVIOUS, NEXT]).toContain(text)
    // No file for the duration of the move, or a refusal to share it
    for (const code of refused) expect(['ENOENT', 'EPERM', 'EACCES', 'EBUSY']).toContain(code)
    // Replacements did go through while the reader was running
    expect(failures.length).toBeLessThan(WRITES)
    expect([PREVIOUS, NEXT]).toContain(await readFile(mirrorOf(dir), 'utf8'))
    expect(await readdir(dir)).toEqual(['settings-backup.json'])
  }, 30_000)
})
