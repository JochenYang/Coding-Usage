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
    expect(raw.version).toBe(1)
    expect(raw.entries.windsurf.result.body).toBe('{"windows":[]}')

    await writeFile(
      join(dir, 'quota-cache.json'),
      JSON.stringify({ version: 1, entries: { bad: { at: 1, result: { available: false } }, keep: raw.entries.windsurf } }),
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
