import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { conversationStartMs, readAntigravityUsage } from './antigravity-usage'

/**
 * Regression: a conversation database that stores no per-row timestamps used to
 * date every one of its rows to "the last day Antigravity was opened" — the file
 * mtime, and both SQLite sidecars, are rewritten by a checkpoint on open/close.
 * A dormant account therefore showed fresh usage every day.
 */

const dirs: string[] = []

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
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
  seconds?: number
  responseId: string
  outputText?: number
  thinking?: number
}

function generationBlob(options: RowOptions): Buffer {
  const outputText = options.outputText ?? 100
  const thinking = options.thinking ?? 50
  const usage = Buffer.concat([
    vint(1, 10),
    vint(2, 5),
    vint(3, outputText + thinking),
    vint(9, outputText),
    vint(10, thinking),
    text(11, options.responseId),
  ])
  const parts = [ldel(4, usage), text(21, 'Gemini 3.8 Flash')]
  if (options.seconds !== undefined) {
    parts.push(ldel(9, ldel(4, vint(1, options.seconds))))
  }
  return ldel(1, Buffer.concat(parts))
}

async function writeConversation(home: string, name: string, blobs: Buffer[]): Promise<string> {
  const dir = join(home, '.gemini', 'antigravity', 'conversations')
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)')
  const insert = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
  blobs.forEach((blob, index) => insert.run(index, blob))
  db.close()
  return file
}

/** Same bucketing rule the module uses for day labels */
function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface Payload {
  contributions: Array<{ date: string; totals: { tokens: number; messages: number } }>
}

describe('conversationStartMs', () => {
  it('prefers the creation time over an mtime that a checkpoint refreshed', () => {
    const created = Date.UTC(2026, 2, 5, 10)
    const mtime = Date.UTC(2026, 4, 20, 10) // later "open"
    expect(conversationStartMs({ birthtimeMs: created, mtimeMs: mtime })).toBe(created)
  })

  it('falls back to mtime only when the filesystem reports no creation time', () => {
    const mtime = Date.UTC(2026, 4, 20, 10)
    expect(conversationStartMs({ birthtimeMs: 0, mtimeMs: mtime })).toBe(mtime)
  })
})

describe('readAntigravityUsage', () => {
  it('uses each row\'s own timestamp and ignores the file times', async () => {
    const home = await tempHome()
    const seconds = 1791424009 // 2026-10-08
    const file = await writeConversation(home, 'a.db', [
      generationBlob({ seconds, responseId: 'r1' }),
      generationBlob({ seconds, responseId: 'r2' }),
    ])
    // Pretend a checkpoint touched the file long after the rows were written
    const later = new Date(Date.UTC(2026, 10, 6, 5, 0, 0))
    await utimes(file, later, later)

    const payload = (await readAntigravityUsage(home)) as Payload
    expect(payload.contributions.map((c) => c.date)).toEqual([localDay(seconds * 1000)])
    expect(payload.contributions[0].totals.messages).toBe(2)
  })

  it('dates timestamp-less rows to the conversation creation date, not the file mtime', async () => {
    const home = await tempHome()
    const file = await writeConversation(home, 'legacy.db', [
      generationBlob({ responseId: 'l1' }),
      generationBlob({ responseId: 'l2' }),
    ])
    const createdMs = (await stat(file)).birthtimeMs
    // A checkpoint on open would set mtime (and the sidecars) to "now"; make that
    // unmistakable by moving mtime two days past creation.
    const bumped = new Date(createdMs + 2 * 24 * 60 * 60 * 1000)
    await utimes(file, bumped, bumped)
    await writeFile(`${file}-wal`, '')
    await writeFile(`${file}-shm`, '')

    const payload = (await readAntigravityUsage(home)) as Payload
    expect(payload.contributions).toHaveLength(1)
    const [contribution] = payload.contributions
    expect(contribution.date).toBe(localDay(createdMs))
    expect(contribution.date).not.toBe(localDay(bumped.getTime()))
    // The rows are still real usage: they must be counted, only dated honestly.
    expect(contribution.totals.messages).toBe(2)
    expect(contribution.totals.tokens).toBe(2 * (15 + 150))
  })

  it('counts a repeated response id once', async () => {
    const home = await tempHome()
    const seconds = 1791424009
    await writeConversation(home, 'dup.db', [
      generationBlob({ seconds, responseId: 'same' }),
      generationBlob({ seconds, responseId: 'same' }),
    ])
    const payload = (await readAntigravityUsage(home)) as Payload
    expect(payload.contributions[0].totals.messages).toBe(1)
  })
})
