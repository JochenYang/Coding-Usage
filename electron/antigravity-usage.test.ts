import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { closeUsageStore, extractContributions, initUsageStore, mergeScanIntoStore, readSessionCursors } from './usage-store'
import { antigravityKnown, firstScanPlan, readAntigravityUsage } from './antigravity-usage'

/**
 * The app and the CLI stores carry no per-generation timestamp (a recursive
 * scan of every field finds none), so this reader dates a generation by when a
 * scan first sees it: each scan counts the rows past a per-conversation
 * high-water mark on the day it runs, then advances the mark. These tests pin
 * that arrival dating — a conversation keeps reporting only what it added since
 * the previous scan, and each flavour is its own client row.
 */

const dirs: string[] = []
let storeDir = ''

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  closeUsageStore()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// ===== minimal unlabeled-protobuf encoder (mirrors the reader's map) =====

function varint(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

const tag = (field: number, wire: number): Buffer => varint((field << 3) | wire)
const vint = (field: number, value: number): Buffer => Buffer.concat([tag(field, 0), varint(value)])
const ldel = (field: number, body: Buffer): Buffer => Buffer.concat([tag(field, 2), varint(body.length), body])
const text = (field: number, value: string): Buffer => ldel(field, Buffer.from(value, 'utf8'))

interface RowOptions {
  responseId: string
  outputText?: number
  thinking?: number
  /** Store an output total that disagrees with #9 + #10 (a format change) */
  drift?: boolean
}

function generationBlob(options: RowOptions): Buffer {
  const outputText = options.outputText ?? 100
  const thinking = options.thinking ?? 50
  const usage = Buffer.concat([
    vint(1, 10),
    vint(2, 5),
    vint(3, outputText + thinking + (options.drift ? 1 : 0)),
    vint(9, outputText),
    vint(10, thinking),
    text(11, options.responseId),
  ])
  return ldel(1, Buffer.concat([ldel(4, usage), text(21, 'Gemini 3.8 Flash')]))
}

/** Create a conversation database under one flavour root */
async function writeConversation(
  home: string,
  flavour: 'antigravity' | 'antigravity-cli' | 'antigravity-ide',
  name: string,
  blobs: Buffer[],
): Promise<string> {
  const dir = join(home, '.gemini', flavour, 'conversations')
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await createDatabase(file, blobs)
  return file
}

async function createDatabase(file: string, blobs: Buffer[]): Promise<void> {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)')
  const insert = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
  blobs.forEach((blob, index) => insert.run(index, blob))
  db.close()
}

/** Append generations to an existing conversation (the next indexes) */
async function appendGenerations(file: string, blobs: Buffer[]): Promise<void> {
  const db = new DatabaseSync(file)
  try {
    const top = db.prepare('SELECT COALESCE(MAX(idx), -1) AS idx FROM gen_metadata').get() as { idx: number }
    let next = Number(top.idx) + 1
    const insert = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
    for (const blob of blobs) insert.run(next++, blob)
  } finally {
    db.close()
  }
}

/** Replace a conversation with a fresh database at the same path */
async function recreateConversation(file: string, blobs: Buffer[]): Promise<void> {
  await rm(file)
  await createDatabase(file, blobs)
}

/** Same bucketing rule the module uses for day labels */
function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface UsagePayload {
  contributions: Array<{
    date: string
    totals: { tokens: number; messages: number }
    clients: Array<{ client: string; modelId: string }>
  }>
}

/** The reader returns the tokscale-graph shape the main process parses */
function parsePayload(raw: unknown): UsagePayload {
  return raw as UsagePayload
}

async function newStore(): Promise<void> {
  storeDir = await mkdtemp(join(tmpdir(), 'antigravity-store-'))
  dirs.push(storeDir)
  initUsageStore(storeDir)
}

/**
 * Read and commit the marks the way the main process does after the payload is
 * persisted. The reader itself no longer writes them, so a scan whose merge
 * fails cannot lose the usage it found.
 */
async function scan(home: string): Promise<unknown | null> {
  const result = await readAntigravityUsage(home)
  result.commit()
  return result.payload
}

describe('firstScanPlan', () => {
  const mark = (maxIdx: number, fileId = 'file-1'): { maxIdx: number; fileId: string } => ({ maxIdx, fileId })
  const now = new Date(2026, 10, 25, 12).getTime()
  const plan = (over: Partial<Parameters<typeof firstScanPlan>[0]> = {}) =>
    firstScanPlan({
      stored: undefined,
      skipBackCatalogue: false,
      current: mark(9),
      mtimeMs: now,
      nowMs: now,
      ...over,
    })

  it('counts a back catalogue whole when there is no history to bridge', () => {
    // No Antigravity history at all, or a conversation that appeared after this
    // build's first scan: nothing has counted it yet
    expect(plan({ skipBackCatalogue: false })).toEqual({ cursor: -1, date: localDay(now) })
  })

  it('starts at the current end while bridging an upgrade', () => {
    // An older build already counted this disk content under a rule and a
    // client id the split cannot separate, so re-counting would double a day
    expect(plan({ skipBackCatalogue: true })).toEqual({ cursor: 9, date: null })
  })

  it('resumes from a stored mark, booking what is new to today', () => {
    expect(plan({ stored: mark(4), skipBackCatalogue: true })).toEqual({ cursor: 4, date: localDay(now) })
  })

  it('counts a different file at the same path whole, dated by its last write', () => {
    // The file number identifies the file: a new conversation replaced the old
    expect(plan({ stored: mark(4, 'file-1'), current: mark(9, 'file-2') })).toEqual({
      cursor: -1,
      date: localDay(now),
    })
  })

  it('counts a database whose indexes went backwards whole', () => {
    expect(plan({ stored: mark(40), current: mark(3) })).toEqual({ cursor: -1, date: localDay(now) })
  })

  it('falls back to the index rule when the platform reports no file number', () => {
    expect(plan({ stored: mark(40, ''), current: mark(3, '') })).toEqual({ cursor: -1, date: localDay(now) })
    // A file number appearing later is not a change of identity by itself
    expect(plan({ stored: mark(40, ''), current: mark(41, 'file-2') })).toEqual({
      cursor: 40,
      date: localDay(now),
    })
  })
})

describe('antigravityKnown', () => {
  it('is true for any flavour the store already holds', () => {
    expect(antigravityKnown(new Set(['codex']))).toBe(false)
    expect(antigravityKnown(new Set(['antigravity-ide']))).toBe(true)
    expect(antigravityKnown(new Set(['antigravity']))).toBe(true)
    expect(antigravityKnown(new Set(['antigravity-cli']))).toBe(true)
  })
})

describe('readAntigravityUsage', () => {
  it('dates generations by arrival: everything on the day it was first seen', async () => {
    await newStore()
    const home = await tempHome()
    await writeConversation(home, 'antigravity', 'a.db', [
      generationBlob({ responseId: 'r1' }),
      generationBlob({ responseId: 'r2' }),
    ])

    const payload = parsePayload(await scan(home))
    expect(payload.contributions).toHaveLength(1)
    expect(payload.contributions[0].date).toBe(localDay(Date.now()))
    expect(payload.contributions[0].totals.messages).toBe(2)
    expect(payload.contributions[0].totals.tokens).toBe(2 * (15 + 150))
  })

  it('reports the running total so the store keeps what a later scan adds', async () => {
    await newStore()
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'a.db', [generationBlob({ responseId: 'r1' })])
    const first = parsePayload(await scan(home))
    mergeScanIntoStore(extractContributions(first))

    await appendGenerations(file, [generationBlob({ responseId: 'r2' }), generationBlob({ responseId: 'r3' })])
    const second = parsePayload(await scan(home))
    // The day's total, not just this scan's two rows: a bare increment would be
    // smaller than the day already stored and the larger-view merge would drop it
    expect(second.contributions[0].totals.messages).toBe(3)
    const today = mergeScanIntoStore(extractContributions(second)).find((day) => day.date === localDay(Date.now()))!
    expect(today.totals.messages).toBe(3)

    // Nothing new: no payload at all, rather than the same day counted again
    expect(await scan(home)).toBeNull()
  })

  it('counts a database recreated at the same path from the start', async () => {
    await newStore()
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'a.db', [generationBlob({ responseId: 'old' })])
    const first = parsePayload(await scan(home))
    mergeScanIntoStore(extractContributions(first))

    await recreateConversation(file, [generationBlob({ responseId: 'new-1' }), generationBlob({ responseId: 'new-2' })])
    const payload = parsePayload(await scan(home))
    // A whole count describes the file completely, so it is folded against the
    // day with max: the new database's two rows replace the old one's reading
    expect(payload.contributions[0].totals.messages).toBe(2)
  })

  it('counts the first generation of a conversation that was empty when scanned', async () => {
    await newStore()
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'late.db', [])
    expect(await scan(home)).toBeNull()

    // Index 0 must still land after the empty scan's mark
    await appendGenerations(file, [generationBlob({ responseId: 'first' })])
    const payload = parsePayload(await scan(home))
    expect(payload.contributions[0].totals.messages).toBe(1)
  })

  it('books a whole back catalogue on the day its database was last written', async () => {
    await newStore()
    const home = await tempHome()
    const twoDaysAgo = Date.now() - 2 * 86_400_000
    const file = await writeConversation(home, 'antigravity-cli', 'c.db', [generationBlob({ responseId: 'c1' })])
    await utimes(file, new Date(twoDaysAgo), new Date(twoDaysAgo))

    const payload = parsePayload(await scan(home))
    expect(payload.contributions).toHaveLength(1)
    expect(payload.contributions[0].date).toBe(localDay(twoDaysAgo))
  })

  it('reports one contribution per day when two back catalogues were written on different days', async () => {
    await newStore()
    const home = await tempHome()
    const older = Date.now() - 2 * 86_400_000
    const oldFile = await writeConversation(home, 'antigravity-cli', 'old.db', [generationBlob({ responseId: 'o1' })])
    await writeConversation(home, 'antigravity-cli', 'new.db', [generationBlob({ responseId: 'n1' })])
    await utimes(oldFile, new Date(older), new Date(older))

    const payload = parsePayload(await scan(home))
    expect(payload.contributions.map((c) => c.date)).toEqual([localDay(older), localDay(Date.now())])
  })

  it('does not re-count a conversation when any Antigravity history exists', async () => {
    await newStore()
    mergeScanIntoStore([
      {
        date: '2026-11-01',
        totals: { tokens: 100, cost: 0, messages: 2 },
        tokenBreakdown: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
        clients: [
          {
            client: 'antigravity',
            modelId: 'Gemini 3.8 Flash',
            tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
            messages: 2,
          },
        ],
        intensity: 0,
        activeTimeMs: 0,
      },
    ])
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'fresh.db', [generationBlob({ responseId: 'f1' })])

    // An older build already counted this disk content (all three roots under
    // one client id), so the split must start at the end: no duplicate, at the
    // cost of the pre-upgrade part of an existing conversation
    expect(await scan(home)).toBeNull()

    // What arrives after the upgrade is counted
    await appendGenerations(file, [generationBlob({ responseId: 'f2' })])
    const payload = parsePayload(await scan(home))
    expect(payload.contributions[0].totals.messages).toBe(1)
  })

  it('keeps the mark of a conversation it could not read this round', async () => {
    await newStore()
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'a.db', [generationBlob({ responseId: 'r1' })])
    await scan(home)
    expect(readSessionCursors().get(file)?.maxIdx).toBe(0)

    // A transient failure (WAL lock, antivirus) must not drop the mark: the
    // next scan has to continue where this one left off, not from the end
    await writeFile(file, 'not a database')
    expect(await scan(home)).toBeNull()
    expect(readSessionCursors().get(file)?.maxIdx).toBe(0)
  })

  it('keeps a database whose rows all failed verification at its old mark', async () => {
    await newStore()
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'a.db', [generationBlob({ responseId: 'r1' })])
    await scan(home)

    // A format change: every new row disagrees with the verified field map, so
    // nothing can be counted. The mark must stay put — a parser fix should be
    // able to recover the range instead of finding it skipped forever
    await appendGenerations(file, [generationBlob({ responseId: 'bad', drift: true })])
    expect(await scan(home)).toBeNull()
    expect(readSessionCursors().get(file)?.maxIdx).toBe(0)
  })

  it('advances past a drifted row when the rest of the batch is verifiable', async () => {
    await newStore()
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'a.db', [generationBlob({ responseId: 'r1' })])
    const first = parsePayload(await scan(home))
    mergeScanIntoStore(extractContributions(first))

    await appendGenerations(file, [generationBlob({ responseId: 'bad', drift: true }), generationBlob({ responseId: 'r2' })])
    const payload = parsePayload(await scan(home))
    // The good row lands (on top of the day's total); the bad one is dropped
    expect(payload.contributions[0].totals.messages).toBe(2)
  })

  it('reports each flavour as its own client', async () => {
    await newStore()
    const home = await tempHome()
    await writeConversation(home, 'antigravity-ide', 'ide.db', [generationBlob({ responseId: 'i1' })])
    await writeConversation(home, 'antigravity', 'app.db', [generationBlob({ responseId: 'a1' })])
    await writeConversation(home, 'antigravity-cli', 'cli.db', [generationBlob({ responseId: 'c1' })])

    const payload = parsePayload(await scan(home))
    const clients = payload.contributions[0].clients.map((entry) => entry.client).sort()
    expect(clients).toEqual(['antigravity', 'antigravity-cli', 'antigravity-ide'])
  })

  it('counts a repeated response id once', async () => {
    await newStore()
    const home = await tempHome()
    await writeConversation(home, 'antigravity', 'dup.db', [
      generationBlob({ responseId: 'same' }),
      generationBlob({ responseId: 'same' }),
    ])
    const payload = parsePayload(await scan(home))
    expect(payload.contributions[0].totals.messages).toBe(1)
  })

  it('forgets the mark of a conversation whose file is gone', async () => {
    await newStore()
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'gone.db', [generationBlob({ responseId: 'x' })])
    const first = parsePayload(await scan(home))
    mergeScanIntoStore(extractContributions(first))

    // A new conversation at the same path must not inherit the old mark
    await recreateConversation(file, [generationBlob({ responseId: 'fresh' })])
    const payload = parsePayload(await scan(home))
    // A whole count does not add to the day: it replaces that client's reading
    expect(payload.contributions[0].totals.messages).toBe(1)
  })

  it('advances the marks even when it has nothing to report', async () => {
    await newStore()
    mergeScanIntoStore([
      {
        date: '2026-11-01',
        totals: { tokens: 100, cost: 0, messages: 2 },
        tokenBreakdown: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
        clients: [
          {
            client: 'antigravity',
            modelId: 'Gemini 3.8 Flash',
            tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
            messages: 2,
          },
        ],
        intensity: 0,
        activeTimeMs: 0,
      },
    ])
    const home = await tempHome()
    const file = await writeConversation(home, 'antigravity', 'old.db', [generationBlob({ responseId: 'o1' })])

    // The main process only commits for a payload; if the reader waited for it,
    // a machine with nothing new would stay in the upgrade branch forever
    const result = await readAntigravityUsage(home)
    expect(result.payload).toBeNull()
    expect(readSessionCursors().get(file)?.maxIdx).toBe(0)
  })

  it('counts a conversation that appeared after the first scan whole', async () => {
    await newStore()
    mergeScanIntoStore([
      {
        date: '2026-11-01',
        totals: { tokens: 100, cost: 0, messages: 2 },
        tokenBreakdown: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
        clients: [
          {
            client: 'antigravity',
            modelId: 'Gemini 3.8 Flash',
            tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
            messages: 2,
          },
        ],
        intensity: 0,
        activeTimeMs: 0,
      },
    ])
    const home = await tempHome()
    await writeConversation(home, 'antigravity', 'before.db', [generationBlob({ responseId: 'b1' })])
    // The upgrade scan bridges the existing content and writes the marks
    expect(await scan(home)).toBeNull()

    // A conversation that did not exist then was never counted, so its whole
    // database is booked — otherwise every session started while the app was
    // closed would be skipped in full
    await writeConversation(home, 'antigravity', 'after.db', [
      generationBlob({ responseId: 'a1' }),
      generationBlob({ responseId: 'a2' }),
    ])
    const payload = parsePayload(await scan(home))
    expect(payload.contributions[0].totals.messages).toBe(2)
  })
})
