import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTraeLocalUsage } from './trae-local-usage'

/**
 * Headless tests for the Trae CN local usage reader (P27 / T4), scoped to what
 * the public entry can reach without a running IDE:
 *
 *   - the entry-time `scan-*` sweep (P11): the decrypted plaintext copies must
 *     never outlive a killed process, and the sweep must not touch anything
 *     outside this app's own `scan-` prefix;
 *   - the aggregate cache contract: when the SQLCipher key is unreachable
 *     (no IDE running, no compiler) the reader replays the cached payload and
 *     refuses to invent numbers when the cache is unusable.
 *
 * The per-turn parsing (`readTurns`) and aggregation (`buildPayload`) stay
 * module-private and are only reachable through the compiled keyscan helper
 * against a live IDE process, so they are not exercised here; the SQLCipher
 * page-level decrypt itself is deliberately out of scope per the plan.
 */

const dirs: string[] = []
const originalAppData = process.env.APPDATA

afterEach(async () => {
  // The reader reads process.env.APPDATA; restore whatever the host had
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** mkdtemp for home + userData, and point APPDATA at a fresh empty dir */
async function tempSetup(): Promise<{ home: string; userData: string; appData: string }> {
  const home = await mkdtemp(join(tmpdir(), 'trae-local-'))
  const userData = await mkdtemp(join(tmpdir(), 'trae-local-ud-'))
  const appData = await mkdtemp(join(tmpdir(), 'trae-local-appdata-'))
  dirs.push(home, userData, appData)
  process.env.APPDATA = appData
  return { home, userData, appData }
}

/** Mirrors the `tokscale graph`-shaped payload buildPayload emits */
const CACHED_PAYLOAD = {
  meta: null,
  contributions: [
    {
      date: '2026-11-20',
      totals: { tokens: 1200, cost: 0, messages: 3 },
      tokenBreakdown: { input: 800, output: 300, cacheRead: 50, cacheWrite: 50 },
      clients: [
        {
          client: 'trae',
          modelId: 'kimi-k3',
          providerId: 'trae',
          tokens: { input: 800, output: 300, cacheRead: 50, cacheWrite: 50 },
          cost: 0,
          messages: 3,
        },
      ],
      intensity: 0,
      activeTimeMs: 0,
    },
  ],
}

describe('readTraeLocalUsage', () => {
  it('sweeps leftover scan-* files on entry and touches nothing else', async () => {
    const { home, userData } = await tempSetup()
    const dir = join(userData, 'trae-local')
    await mkdir(join(dir, 'scan-subdir'), { recursive: true })
    // Plaintext copies a killed process left behind — exactly what the sweep exists for
    await writeFile(join(dir, 'scan-123-456-TraeCN.snap'), 'plaintext snapshot leftover')
    await writeFile(join(dir, 'scan-123-456-TraeCN.db'), 'decrypted database leftover')
    // Files and directories the sweep must not touch
    await writeFile(join(dir, 'usage-cache.json'), 'not json yet')
    await writeFile(join(dir, 'trae-keyscan.cs'), 'helper source')
    await writeFile(join(dir, 'unrelated.txt'), 'keep me')

    // No product database under APPDATA and an unusable cache → honest null
    expect(await readTraeLocalUsage(home, userData)).toBeNull()

    expect(existsSync(join(dir, 'scan-123-456-TraeCN.snap'))).toBe(false)
    expect(existsSync(join(dir, 'scan-123-456-TraeCN.db'))).toBe(false)
    // Directories are never removed, whoever created them
    expect(existsSync(join(dir, 'scan-subdir'))).toBe(true)
    expect(existsSync(join(dir, 'usage-cache.json'))).toBe(true)
    expect(existsSync(join(dir, 'trae-keyscan.cs'))).toBe(true)
    expect(existsSync(join(dir, 'unrelated.txt'))).toBe(true)
  })

  it('replays the cached aggregate when no product database exists', async () => {
    const { home, userData } = await tempSetup()
    const dir = join(userData, 'trae-local')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'usage-cache.json'), JSON.stringify(CACHED_PAYLOAD))
    expect(await readTraeLocalUsage(home, userData)).toEqual(CACHED_PAYLOAD)
  })

  it('returns null when the cache file carries no contributions array', async () => {
    const { home, userData } = await tempSetup()
    const dir = join(userData, 'trae-local')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'usage-cache.json'), JSON.stringify({ meta: null, unrelated: true }))
    expect(await readTraeLocalUsage(home, userData)).toBeNull()
  })

  it('degrades to the cached aggregate when a database exists but no IDE holds the key', async () => {
    const { home, userData } = await tempSetup()
    const dir = join(userData, 'trae-local')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'usage-cache.json'), JSON.stringify(CACHED_PAYLOAD))
    await writeFile(join(dir, 'scan-stale.snap'), 'leftover from a killed process')

    // A database file exists, so the reader commits to the full pipeline; the
    // SQLCipher key lives only in the running IDE's memory, so the keyscan
    // comes back without a key whether or not a csc.exe is available to build
    // the helper (both paths converge on the cached payload below).
    const dbDir = join(process.env.APPDATA as string, 'Trae CN', 'ModularData', 'ai-agent')
    await mkdir(dbDir, { recursive: true })
    await writeFile(join(dbDir, 'database.db'), Buffer.alloc(4096))

    expect(await readTraeLocalUsage(home, userData)).toEqual(CACHED_PAYLOAD)
    // The entry-time sweep also ran on this path
    expect(existsSync(join(dir, 'scan-stale.snap'))).toBe(false)
    // The helper's own files are not scan-* leftovers and must survive
    expect(existsSync(join(dir, 'usage-cache.json'))).toBe(true)
  })
})
