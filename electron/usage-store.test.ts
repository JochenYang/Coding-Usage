import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeScan } from '@/lib/agent-usage'
import {
  closeUsageStore,
  extractContributions,
  getUsageStoreStats,
  initUsageStore,
  mergeScanIntoStore,
  purgeUsageBefore,
  readSessionCursors,
  readStoredClientRows,
  readStoredContributions,
  saveSessionCursors,
  storedClients,
} from './usage-store'

/**
 * The store's contract is "history outlives the session files", which lives
 * entirely in the merge rule: a scan that no longer mentions a client or a day
 * must not shrink what is already saved. These tests pin that down, plus the
 * purge predicate the settings page drives.
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coding-usage-store-'))
  initUsageStore(dir)
})

afterEach(async () => {
  closeUsageStore()
  await rm(dir, { recursive: true, force: true })
})

interface Row {
  client: string
  input: number
  output?: number
  messages?: number
  cost?: number
  credits?: number
}

/** Build one day's contribution in the shape `tokscale graph` produces */
function contribution(date: string, rows: Row[]) {
  const clients = rows.map((row) => ({
    client: row.client,
    modelId: `${row.client}-model`,
    providerId: `${row.client}-provider`,
    tokens: { input: row.input, output: row.output ?? 0, cacheRead: 0, cacheWrite: 0 },
    cost: row.cost ?? 0,
    messages: row.messages ?? 0,
    credits: row.credits ?? 0,
  }))
  const input = clients.reduce((sum, c) => sum + c.tokens.input, 0)
  const output = clients.reduce((sum, c) => sum + c.tokens.output, 0)
  return {
    date,
    totals: {
      tokens: input + output,
      cost: clients.reduce((sum, c) => sum + c.cost, 0),
      messages: clients.reduce((sum, c) => sum + c.messages, 0),
      credits: clients.reduce((sum, c) => sum + c.credits, 0),
    },
    tokenBreakdown: { input, output, cacheRead: 0, cacheWrite: 0 },
    clients,
    intensity: 0,
    activeTimeMs: 0,
  }
}

describe('usage history store', () => {
  it('keeps a client the fresh scan no longer reports', () => {
    mergeScanIntoStore([
      contribution('2026-01-01', [
        { client: 'codex', input: 100 },
        { client: 'kimi', input: 50 },
      ]),
    ])

    const merged = mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 120 }])])
    const day = merged.find((d) => d.date === '2026-01-01')!
    const codex = day.clients.find((c) => c.client === 'codex')!
    const kimi = day.clients.find((c) => c.client === 'kimi')!

    // The client still reported takes the fresh value; the vanished one is kept
    expect(codex.tokens?.input).toBe(120)
    expect(kimi.tokens?.input).toBe(50)
    // Day totals include the carried row, so the renderer's "other" bucket
    // (totals minus client rows) cannot hide it from the headline figures
    expect(day.totals.tokens).toBe(170)
    expect(day.tokenBreakdown.input).toBe(170)
  })

  it('carries a vanished credits-billed row into the day total, not just its tokens', () => {
    // Qoder global reports credits and zero tokens. A day carried over from the
    // store must keep its credits in `totals` as well, or the renderer derives
    // the missing amount as "unclassified" and the headline under-reports.
    mergeScanIntoStore([
      contribution('2026-01-01', [
        { client: 'codex', input: 10 },
        { client: 'qoder-global', input: 0, credits: 4, messages: 2 },
      ]),
    ])

    const merged = mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 12 }])])
    const day = merged.find((d) => d.date === '2026-01-01')!
    expect(day.totals.credits).toBe(4)
    expect(day.totals.tokens).toBe(12)
  })

  it('serves days the fresh scan stopped reporting', () => {
    mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 100 }])])
    const merged = mergeScanIntoStore([contribution('2026-01-02', [{ client: 'codex', input: 10 }])])
    expect(merged.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-02'])
  })

  it('returns stored history for an empty scan instead of wiping it', () => {
    mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 100 }])])
    const merged = mergeScanIntoStore([])
    expect(merged).toHaveLength(1)
    expect(readStoredContributions()).toHaveLength(1)
  })

  it('keeps the stored view when the fresh scan reports less for a client', () => {
    // A deleted, archived or rewritten session shrinks what a later scan sees;
    // history must not follow it down — that is what this store exists for
    mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 100 }])])
    const merged = mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 40 }])])
    expect(merged[0]!.clients[0]!.tokens?.input).toBe(100)
    expect(merged[0]!.totals.tokens).toBe(100)
    expect(merged[0]!.tokenBreakdown.input).toBe(100)
  })

  it('takes the fresh view where it is larger, and keeps the stored one where it shrank', () => {
    mergeScanIntoStore([
      contribution('2026-01-01', [
        { client: 'codex', input: 100 },
        { client: 'kimi', input: 50 },
      ]),
    ])
    const merged = mergeScanIntoStore([
      contribution('2026-01-01', [
        { client: 'codex', input: 120 },
        { client: 'kimi', input: 30 },
      ]),
    ])
    const day = merged[0]!
    expect(day.clients.find((c) => c.client === 'codex')!.tokens?.input).toBe(120)
    expect(day.clients.find((c) => c.client === 'kimi')!.tokens?.input).toBe(50)
    expect(day.totals.tokens).toBe(170)
    expect(day.tokenBreakdown.input).toBe(170)
  })

  it('breaks a token tie by calls, then by credits', () => {
    // Same tokens but fewer calls, or fewer credits, is the less complete view
    mergeScanIntoStore([
      contribution('2026-01-01', [{ client: 'codex', input: 100, messages: 9 }]),
      contribution('2026-01-02', [{ client: 'qoder-global', input: 0, credits: 6, messages: 4 }]),
    ])
    const merged = mergeScanIntoStore([
      contribution('2026-01-01', [{ client: 'codex', input: 100, messages: 5 }]),
      contribution('2026-01-02', [{ client: 'qoder-global', input: 0, credits: 2, messages: 4 }]),
    ])
    expect(merged[0]!.clients[0]!.messages).toBe(9)
    expect(merged[1]!.clients[0]!.credits).toBe(6)
    expect(merged[1]!.totals.credits).toBe(6)
  })

  it('lets an equal view refresh what it carries, such as a corrected cost', () => {
    mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 100, cost: 1 }])])
    const merged = mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 100, cost: 2 }])])
    expect(merged[0]!.clients[0]!.cost).toBe(2)
    expect(merged[0]!.totals.cost).toBe(2)
  })

  it('purges days older than the cutoff and keeps the rest', () => {
    mergeScanIntoStore([
      contribution('2026-01-01', [{ client: 'codex', input: 1 }]),
      contribution('2026-01-02', [{ client: 'codex', input: 2 }]),
      contribution('2026-01-03', [{ client: 'codex', input: 3 }]),
    ])

    const result = purgeUsageBefore('2026-01-02')
    expect(result.removed).toBe(1)
    expect(result.stats).toEqual({ days: 2, oldest: '2026-01-02', newest: '2026-01-03' })
  })

  it('wipes everything when the cutoff is null', () => {
    mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 1 }])])

    const result = purgeUsageBefore(null)
    expect(result.removed).toBe(1)
    expect(result.stats.days).toBe(0)
    expect(getUsageStoreStats()).toEqual({ days: 0, oldest: null, newest: null })
  })

  it('drops rows without a usable date and keeps fields it does not model', () => {
    const rows = extractContributions({
      contributions: [
        { date: '2026-01-01', totals: { tokens: 5 }, somethingNew: 'kept' },
        { date: '', totals: {} },
        { totals: {} },
        null,
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.date).toBe('2026-01-01')
    expect((rows[0] as unknown as { somethingNew?: string }).somethingNew).toBe('kept')
  })

  it('drops rows whose date is not a calendar day', () => {
    const rows = extractContributions({
      contributions: [
        { date: '2026-02-30', totals: {} },
        { date: 'not-a-date', totals: {} },
        { date: '2026-01-01T00:00:00Z', totals: {} },
        { date: '2026-01-01', totals: {} },
      ],
    })
    expect(rows.map((r) => r.date)).toEqual(['2026-01-01'])
  })

  it('refuses a malformed cutoff instead of deleting everything', () => {
    mergeScanIntoStore([contribution('2026-01-01', [{ client: 'codex', input: 1 }])])
    // "NaN-NaN-NaN" sorts above every real day in a plain string comparison, so
    // an unvalidated predicate would match the whole store
    expect(purgeUsageBefore('NaN-NaN-NaN').removed).toBe(0)
    expect(purgeUsageBefore('2026-1-1').removed).toBe(0)
    expect(getUsageStoreStats().days).toBe(1)
  })

  it('leaves the renderer unclassified bucket empty after a client is carried over', () => {
    // The renderer derives `other` as day totals minus the client rows, so a
    // carried row added to `clients` but not to `totals` would distort it.
    // Feeding the merged day back through summarizeScan is what proves the
    // recomputed totals really close that gap.
    const now = new Date()
    const day = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`
    mergeScanIntoStore([
      contribution(day, [
        { client: 'codex', input: 100 },
        { client: 'kimi', input: 50 },
      ]),
    ])
    const merged = mergeScanIntoStore([contribution(day, [{ client: 'codex', input: 100 }])])
    const vm = summarizeScan({ daily: { contributions: merged } })

    expect(vm.todayTotal.tokens).toBe(150)
    expect(vm.other).toBeNull()
    expect(vm.clients.find((c) => c.client === 'codex')!.today.tokens).toBe(100)
    expect(vm.clients.find((c) => c.client === 'kimi')!.today.tokens).toBe(50)
  })

  it('keeps the day figure a shrink would have lowered, as the card reads it', () => {
    const now = new Date()
    const day = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`
    mergeScanIntoStore([
      contribution(day, [
        { client: 'codex', input: 100 },
        { client: 'kimi', input: 50 },
      ]),
    ])
    // One client's sessions were pruned, the other's numbers fell: neither may
    // lower what the card already showed (1.11B → 712M on this machine)
    const merged = mergeScanIntoStore([contribution(day, [{ client: 'codex', input: 60 }])])
    const vm = summarizeScan({ daily: { contributions: merged } })

    expect(vm.todayTotal.tokens).toBe(150)
    expect(vm.clients.find((c) => c.client === 'codex')!.today.tokens).toBe(100)
    expect(vm.clients.find((c) => c.client === 'kimi')!.today.tokens).toBe(50)
  })
})

describe('session cursors', () => {
  const mark = (maxIdx: number, fileId = 'file-1'): { maxIdx: number; fileId: string } => ({ maxIdx, fileId })

  it('round-trips a mark across a reopen, which is what a restart sees', () => {
    saveSessionCursors(new Map([['a.db', mark(12)]]), ['a.db'])
    closeUsageStore()

    const marks = readSessionCursors()
    expect(marks.get('a.db')).toEqual({ maxIdx: 12, fileId: 'file-1' })
  })

  it('replaces the mark of a path it sees again', () => {
    saveSessionCursors(new Map([['a.db', mark(12)]]), ['a.db'])
    saveSessionCursors(new Map([['a.db', mark(20)]]), ['a.db'])

    expect(readSessionCursors().get('a.db')).toEqual({ maxIdx: 20, fileId: 'file-1' })
  })

  it('forgets a conversation the scan no longer finds on disk', () => {
    saveSessionCursors(
      new Map([
        ['a.db', mark(12)],
        ['gone.db', mark(3, 'file-9')],
      ]),
      ['a.db', 'gone.db'],
    )
    // A file that is no longer listed is not in `seen`, so its mark goes
    saveSessionCursors(new Map([['a.db', mark(12)]]), ['a.db'])

    const marks = readSessionCursors()
    expect([...marks.keys()]).toEqual(['a.db'])
  })

  it('keeps the mark of a conversation it found but could not read', () => {
    saveSessionCursors(
      new Map([
        ['a.db', mark(12)],
        ['locked.db', mark(3, 'file-9')],
      ]),
      ['a.db', 'locked.db'],
    )
    // The unreadable file stays in `seen` (it exists) but has no fresh mark
    saveSessionCursors(new Map([['a.db', mark(12)]]), ['a.db', 'locked.db'])

    expect(readSessionCursors().get('locked.db')).toEqual({ maxIdx: 3, fileId: 'file-9' })
  })

  it('clears the table when a scan saw no conversation at all', () => {
    saveSessionCursors(new Map([['a.db', mark(12)]]), ['a.db'])
    saveSessionCursors(new Map(), [])

    expect(readSessionCursors().size).toBe(0)
  })
})

describe('storedClients', () => {
  it('lists every client the store holds a day for', () => {
    mergeScanIntoStore([
      contribution('2026-11-01', [{ client: 'codex', input: 10 }]),
      contribution('2026-11-02', [{ client: 'antigravity-cli', input: 5 }]),
    ])

    expect([...storedClients()].sort()).toEqual(['antigravity-cli', 'codex'])
  })

  it('is empty for a store with no days', () => {
    expect(storedClients().size).toBe(0)
  })
})

describe('readStoredClientRows', () => {
  it("flattens a stored day's client rows", () => {
    mergeScanIntoStore([contribution('2026-11-05', [{ client: 'antigravity', input: 10, output: 5, messages: 2 }])])

    expect(readStoredClientRows('2026-11-05')).toEqual([
      {
        client: 'antigravity',
        modelId: 'antigravity-model',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        messages: 2,
      },
    ])
  })

  it('is empty for a day the store does not hold', () => {
    expect(readStoredClientRows('2026-11-06')).toEqual([])
  })

  it('rejects a key that is not a calendar day', () => {
    expect(readStoredClientRows('2026-02-30')).toEqual([])
  })

  it('is empty when the stored day cannot be parsed', () => {
    closeUsageStore()
    const raw = new DatabaseSync(join(dir, 'usage-history.db'))
    raw.exec(
      'CREATE TABLE IF NOT EXISTS usage_day (' +
        'day TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    )
    raw.prepare('INSERT OR REPLACE INTO usage_day (day, payload, updated_at) VALUES (?, ?, ?)').run(
      '2026-11-07',
      '{not json',
      Date.now(),
    )
    raw.close()
    initUsageStore(dir)

    expect(readStoredClientRows('2026-11-07')).toEqual([])
  })
})

describe('legacy Antigravity rows', () => {
  /** A day as an older build wrote it: all three roots under one client id */
  function legacyDay(client: string, day = '2026-11-01'): void {
    const payload = JSON.stringify({
      date: day,
      totals: { tokens: 100, cost: 0, messages: 2 },
      tokenBreakdown: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      clients: [
        {
          client,
          modelId: 'Gemini 3.5 Flash',
          tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          messages: 2,
        },
      ],
      intensity: 7,
      activeTimeMs: 5000,
    })
    const raw = new DatabaseSync(join(dir, 'usage-history.db'))
    raw.exec(
      'CREATE TABLE IF NOT EXISTS usage_day (' +
        'day TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    )
    raw.prepare('INSERT OR REPLACE INTO usage_day (day, payload, updated_at) VALUES (?, ?, ?)').run(day, payload, Date.now())
    raw.close()
    initUsageStore(dir)
  }

  it('are left exactly as written: the split cannot tell which flavour they are', () => {
    // An older build stored all three roots under `antigravity`, so a rename
    // would give the app row the IDE's history (and vice versa). The reader
    // treats their presence as "already counted" instead.
    closeUsageStore()
    legacyDay('antigravity')

    const days = readStoredContributions()
    expect(days).toHaveLength(1)
    expect(days[0]!.clients[0]!.client).toBe('antigravity')
    expect(days[0]!.totals).toEqual({ tokens: 100, cost: 0, messages: 2 })
    expect(days[0]!.intensity).toBe(7)
    expect(days[0]!.activeTimeMs).toBe(5000)
  })
})
