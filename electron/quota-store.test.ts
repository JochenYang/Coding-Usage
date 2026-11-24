import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  flushQuotaStore,
  initQuotaStore,
  readQuotaSnapshot,
  resetQuotaStore,
  saveQuotaOutcome,
} from './quota-store'

beforeEach(() => {
  resetQuotaStore()
})

describe('quota store', () => {
  it('returns nothing before the store is initialized', () => {
    expect(readQuotaSnapshot()).toEqual({})
  })

  it('keeps a successful outcome and reports when it was fetched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await initQuotaStore(dir)
    saveQuotaOutcome('cline', { available: true, body: '{"windows":[]}' })
    const snapshot = readQuotaSnapshot()
    expect(snapshot.cline?.result.body).toBe('{"windows":[]}')
    expect(typeof snapshot.cline?.at).toBe('number')
  })

  it('never lets a failure replace the last good reading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await initQuotaStore(dir)
    saveQuotaOutcome('kilo', { available: true, body: '{"windows":[]}' })
    saveQuotaOutcome('kilo', { available: false, reason: 'no-auth' })
    expect(readQuotaSnapshot().kilo?.result.available).toBe(true)
  })

  it('round-trips through disk and drops a malformed entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await initQuotaStore(dir)
    saveQuotaOutcome('windsurf', { available: true, body: '{"windows":[]}' })
    await flushQuotaStore()
    const raw = JSON.parse(await readFile(join(dir, 'quota-cache.json'), 'utf8'))
    expect(raw.version).toBe(2)
    expect(raw.entries.windsurf.result.body).toBe('{"windows":[]}')

    await writeFile(
      join(dir, 'quota-cache.json'),
      JSON.stringify({ version: 2, entries: { bad: { at: 1, result: { available: false } }, keep: raw.entries.windsurf } }),
    )
    resetQuotaStore()
    await initQuotaStore(dir)
    const snapshot = readQuotaSnapshot()
    expect(snapshot.bad).toBeUndefined()
    expect(snapshot.keep?.result.available).toBe(true)
  })

  it('survives a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await writeFile(join(dir, 'quota-cache.json'), 'not json')
    await initQuotaStore(dir)
    expect(readQuotaSnapshot()).toEqual({})
  })

  it('coalesces several writes into one file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await initQuotaStore(dir)
    for (const key of ['a', 'b', 'c']) saveQuotaOutcome(key, { available: true, body: '{}' })
    await flushQuotaStore()
    const raw = JSON.parse(await readFile(join(dir, 'quota-cache.json'), 'utf8'))
    expect(Object.keys(raw.entries).sort()).toEqual(['a', 'b', 'c'])
  })
})

/**
 * The Antigravity card was split into IDE / app / CLI. `antigravity` was the
 * IDE's slot and is the app's from format version 2, so a pre-split file has
 * the IDE's last reading under what the app card now reads.
 */
describe('quota store across the Antigravity split', () => {
  const reading = { at: Date.now() - 1000, result: { available: true, body: '{"groups":["ide"]}' } }
  const slots = (): string[] => Object.keys(readQuotaSnapshot()).sort()

  it.each([
    ['a version 1 file', { version: 1, entries: { antigravity: reading } }],
    ['a file from before the version field', { entries: { antigravity: reading } }],
  ])('moves the IDE reading in %s to the IDE slot', async (_label, file) => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await writeFile(join(dir, 'quota-cache.json'), JSON.stringify(file))
    await initQuotaStore(dir)
    expect(slots()).toEqual(['antigravity-ide'])
    expect(readQuotaSnapshot()['antigravity-ide']?.result.body).toBe('{"groups":["ide"]}')
    // Rewritten at once: nothing can be saved into the moved slot while the
    // file on disk still names it the old way.
    const raw = JSON.parse(await readFile(join(dir, 'quota-cache.json'), 'utf8'))
    expect(raw.version).toBe(2)
    expect(Object.keys(raw.entries)).toEqual(['antigravity-ide'])
  })

  it('leaves the app’s slot alone in a file written since the split', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await writeFile(join(dir, 'quota-cache.json'), JSON.stringify({ version: 2, entries: { antigravity: reading } }))
    await initQuotaStore(dir)
    expect(slots()).toEqual(['antigravity'])
  })

  it('does not touch a slot a newer file format may use differently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    await writeFile(join(dir, 'quota-cache.json'), JSON.stringify({ version: 3, entries: { antigravity: reading } }))
    await initQuotaStore(dir)
    expect(slots()).toEqual(['antigravity'])
  })

  it('after a downgrade and a second upgrade, keeps the IDE’s own reading and drops the older one beside it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-store-'))
    const olderIdeReading = { at: Date.now() - 2000, result: { available: true, body: '{"groups":["older ide"]}' } }
    await writeFile(
      join(dir, 'quota-cache.json'),
      // A build from before the split keeps unknown keys, so it writes its IDE
      // reading under the old name next to the one the newer build had moved.
      JSON.stringify({ version: 1, entries: { antigravity: olderIdeReading, 'antigravity-ide': reading } }),
    )
    await initQuotaStore(dir)
    expect(slots()).toEqual(['antigravity-ide'])
    expect(readQuotaSnapshot()['antigravity-ide']?.result.body).toBe('{"groups":["ide"]}')
  })
})
