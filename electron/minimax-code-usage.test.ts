import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeScan } from '@/lib/agent-usage'
import { readMiniMaxCodeUsage } from './minimax-code-usage'

/**
 * MiniMax Code keeps usage in two generations: the v2 session store (one
 * `ledger.jsonl` or `messages.jsonl` per session) and the pre-v2 `sqlite.db`.
 * The reader must fold both into one `tokscale graph` payload without double
 * counting — the sqlite side drops everything at or after the session store's
 * first record, and exact repeats collapse. These tests pin the two layouts,
 * the `.minimax`/`.mavis` single-count rule and the era boundary through the
 * renderer's own consumer (`summarizeScan`).
 */

const dirs: string[] = []
let home = ''

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(async () => {
  home = await tempDir('minimax-home-')
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Fixed moment for era-boundary tests (sqlite vs session store) */
const T = Date.parse('2026-01-15T10:00:00Z')

/** Local calendar day, the bucketing the reader and the renderer agree on */
function localDayOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** One assistant message carrying usage, as the agent writes it */
function assistantMsg(args: {
  responseId?: string
  model: string
  provider: string
  tsMs?: number
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}): Record<string, unknown> {
  return {
    role: 'assistant',
    responseId: args.responseId,
    model: args.model,
    provider: args.provider,
    timestamp: args.tsMs ?? T,
    usage: {
      input: args.input,
      output: args.output,
      cacheRead: args.cacheRead ?? 0,
      cacheWrite: args.cacheWrite ?? 0,
    },
    // Content the reader promises never to touch
    content: [{ type: 'text', text: 'CHAT-CONTENT-SENTINEL-7c21' }],
  }
}

function ledgerEvent(messages: unknown[], createdAtMs = T): string {
  return JSON.stringify({ kind: 'message.pi_history_appended', createdAtMs, messages })
}

/** Session dir in the documented `<YYYY>/<MM>/<DD>/<HH-MM-SS-mmm>-<sid>` layout */
async function session(sid: string, at: Date, root = join(home, '.minimax')): Promise<string> {
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  const dir = join(
    root,
    'v2',
    'sessions',
    `${at.getFullYear()}`,
    pad(at.getMonth() + 1),
    pad(at.getDate()),
    `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}-${`${at.getMilliseconds()}`.padStart(3, '0')}-${sid}`,
  )
  await mkdir(dir, { recursive: true })
  return dir
}

async function putLedger(dir: string, lines: string[]): Promise<void> {
  await writeFile(join(dir, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf8')
}

async function putMessages(dir: string, lines: unknown[]): Promise<void> {
  // Raw strings are written verbatim so a fixture can carry a torn line.
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  await writeFile(join(dir, 'messages.jsonl'), text, 'utf8')
}

/** messages-layout line: one `{ message_id, turn_id, message }` per line */
function messageLine(args: {
  messageId?: string
  turnId?: string
  message: Record<string, unknown>
}): Record<string, unknown> {
  return { message_id: args.messageId, turn_id: args.turnId, message: args.message }
}

async function putSqlite(root: string, rows: Array<[string, string, string, number, number, number, number, number]>): Promise<void> {
  await mkdir(root, { recursive: true })
  const db = new DatabaseSync(join(root, 'sqlite.db'))
  try {
    db.exec(
      'CREATE TABLE token_usage (session_id TEXT, turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER)',
    )
    const insert = db.prepare('INSERT INTO token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of rows) insert.run(...row)
  } finally {
    db.close()
  }
}

interface Payload {
  contributions: Array<{
    date: string
    totals: { tokens: number; messages: number }
    tokenBreakdown: Record<string, number>
    clients: Array<{ client: string; modelId: string; providerId: string; tokens: Record<string, number>; messages: number }>
  }>
}

describe('readMiniMaxCodeUsage — session store', () => {
  it('reads the ledger layout, ignoring foreign events, non-assistant entries and torn lines', async () => {
    const dir = await session('s1', new Date(T))
    await putLedger(dir, [
      ledgerEvent([assistantMsg({ responseId: 'r1', model: 'MiniMax-M2.5', provider: 'minimax', input: 100, output: 10 })]),
      // wrong event kind: never contributes, even with usage inside
      JSON.stringify({ kind: 'message.appended', messages: [assistantMsg({ responseId: 'x', model: 'MiniMax-M2.5', provider: 'minimax', input: 500, output: 5 })] }),
      // user message with usage — only assistant entries count
      ledgerEvent([{ role: 'user', timestamp: T, usage: { input: 999, output: 999 } }]),
      ledgerEvent([assistantMsg({ responseId: 'r2', model: 'MiniMax-M2.5', provider: 'minimax', input: 50, output: 5 })]),
      // torn trailing line while the agent appends
      '{"kind":"message.pi_history_appended","messages":[{"role":"assistant"',
    ])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions).toHaveLength(1)
    const day = payload.contributions[0]!
    expect(day.date).toBe(localDayOf(T))
    expect(day.totals.messages).toBe(2)
    expect(day.totals.tokens).toBe(100 + 10 + 50 + 5)
    expect(day.clients[0]).toMatchObject({ client: 'mcode', modelId: 'MiniMax-M2.5', providerId: 'minimax' })
    expect(JSON.stringify(payload)).not.toContain('CHAT-CONTENT-SENTINEL-7c21')
  })

  it('collapses a replayed event within a session but keeps distinct sessions', async () => {
    // Same responseId replayed inside one session (fork/retry) — once.
    const dir = await session('s1', new Date(T))
    await putLedger(dir, [
      ledgerEvent([assistantMsg({ responseId: 'dup-1', model: 'MiniMax-M2.5', provider: 'minimax', input: 40, output: 4 })]),
      ledgerEvent([assistantMsg({ responseId: 'dup-1', model: 'MiniMax-M2.5', provider: 'minimax', input: 40, output: 4 })]),
    ])
    // Same responseId in a different session is a different generation — twice.
    const other = await session('s2', new Date(T))
    await putLedger(other, [
      ledgerEvent([assistantMsg({ responseId: 'dup-1', model: 'MiniMax-M2.5', provider: 'minimax', input: 40, output: 4 })]),
    ])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions[0]!.totals.messages).toBe(2)
    expect(payload.contributions[0]!.totals.tokens).toBe(88)
  })

  it('reads the messages layout and deduplicates by message_id', async () => {
    const dir = await session('s1', new Date(T))
    await putMessages(dir, [
      messageLine({ messageId: 'm1', turnId: 't1', message: assistantMsg({ model: 'MiniMax-M2.5', provider: 'minimax', input: 10, output: 1 }) }),
      // replayed message_id — counted once
      messageLine({ messageId: 'm1', turnId: 't1', message: assistantMsg({ model: 'MiniMax-M2.5', provider: 'minimax', input: 10, output: 1 }) }),
      // no message_id: the turn_id stands in as the dedup key
      messageLine({ turnId: 't2', message: assistantMsg({ model: 'MiniMax-M2.5', provider: 'minimax', input: 20, output: 2 }) }),
      // torn trailing line is skipped
      '{"message_id":"torn"',
    ])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    const day = payload.contributions[0]!
    expect(day.totals.messages).toBe(2)
    expect(day.totals.tokens).toBe(33)
  })

  it('prefers ledger.jsonl when a session carries both carriers', async () => {
    const dir = await session('s1', new Date(T))
    await putLedger(dir, [ledgerEvent([assistantMsg({ responseId: 'r1', model: 'MiniMax-M2.5', provider: 'minimax', input: 10, output: 1 })])])
    await putMessages(dir, [messageLine({ messageId: 'm1', message: assistantMsg({ model: 'MiniMax-M2.5', provider: 'minimax', input: 500, output: 50 }) })])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions[0]!.totals.tokens).toBe(11)
  })

  it('normalizes provider channels and splits vendor-prefixed models', async () => {
    const dir = await session('s1', new Date(T))
    await putLedger(dir, [
      ledgerEvent([
        // internal routing channels all collapse onto the vendor
        assistantMsg({ responseId: 'a', model: 'MiniMax-M2.5', provider: 'custom_provider:minimax-legacy', input: 10, output: 1 }),
        assistantMsg({ responseId: 'b', model: 'MiniMax-M2.5', provider: 'minimax_api', input: 20, output: 2 }),
        // a third-party channel keeps its own row
        assistantMsg({ responseId: 'c', model: 'deepseek-v4.1', provider: 'deepseek', input: 30, output: 3 }),
        // vendor-prefixed model id is kept verbatim on the jsonl path
        assistantMsg({ responseId: 'd', model: 'minimax/MiniMax-M3', provider: 'minimax', input: 40, output: 4 }),
      ]),
    ])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    const rows = payload.contributions[0]!.clients.map((c) => `${c.providerId}/${c.modelId}:${c.tokens.input}`).sort()
    // the two internal channels share one vendor slice (10 + 20)
    expect(rows).toEqual(['deepseek/deepseek-v4.1:30', 'minimax/MiniMax-M2.5:30', 'minimax/minimax/MiniMax-M3:40'])
  })
})

describe('readMiniMaxCodeUsage — .minimax vs .mavis', () => {
  it('counts a symlinked pair once (first root with usage wins)', async () => {
    const dir = await session('s1', new Date(T))
    await putLedger(dir, [ledgerEvent([assistantMsg({ responseId: 'r1', model: 'MiniMax-M2.5', provider: 'minimax', input: 10, output: 1 })])])
    // The identical store under .mavis must never be counted on top.
    const mavisDir = join(home, '.mavis', 'v2', 'sessions', '2026', '01', '15', '10-00-00-000-s1')
    await mkdir(mavisDir, { recursive: true })
    await putLedger(mavisDir, [ledgerEvent([assistantMsg({ responseId: 'r1', model: 'MiniMax-M2.5', provider: 'minimax', input: 10, output: 1 })])])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions[0]!.totals.tokens).toBe(11)
  })

  it('reads .mavis when .minimax holds nothing', async () => {
    const dir = await session('s1', new Date(T), join(home, '.mavis'))
    await putLedger(dir, [ledgerEvent([assistantMsg({ responseId: 'r1', model: 'MiniMax-M2.5', provider: 'minimax', input: 10, output: 1 })])])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions[0]!.totals.tokens).toBe(11)
  })
})

describe('readMiniMaxCodeUsage — pre-v2 sqlite generation', () => {
  it('keeps rows older than the session store and drops rows inside its window', async () => {
    const dir = await session('s1', new Date(T))
    await putLedger(dir, [ledgerEvent([assistantMsg({ responseId: 'r1', model: 'MiniMax-M2.5', provider: 'minimax', input: 10, output: 1 })])])
    await putSqlite(join(home, '.minimax'), [
      ['vs-old', 't1', 'minimax/MiniMax-M2.5', T - 1000, 100, 10, 5, 0], // pre-v2 era: counted
      ['vs-edge', 't2', 'minimax/MiniMax-M2.5', T, 999, 99, 0, 0], // at the floor: already in the jsonl window
      ['vs-new', 't3', 'minimax/MiniMax-M2.5', T + 1000, 888, 88, 0, 0], // after: dropped
      ['vs-zero', 't4', 'minimax/MiniMax-M2.5', 0, 777, 7, 0, 0], // unusable timestamp: dropped
    ])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    const day = payload.contributions[0]!
    expect(day.totals.messages).toBe(2)
    expect(day.totals.tokens).toBe(11 + 115)
    // sqlite rows go through the vendor split the jsonl path skips
    expect(day.clients.find((c) => c.modelId === 'MiniMax-M2.5')!.providerId).toBe('minimax')
  })

  it('collapses exact duplicate sqlite rows', async () => {
    await putSqlite(join(home, '.minimax'), [
      ['s1', 't1', 'MiniMax-M2.5', T - 5000, 50, 5, 0, 0],
      ['s1', 't1', 'MiniMax-M2.5', T - 4999, 50, 5, 0, 0], // same session/turn/counters ~1s apart
      ['s1', 't2', 'MiniMax-M2.5', T - 4000, 60, 6, 0, 0],
    ])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions[0]!.totals.tokens).toBe(121)
    expect(payload.contributions[0]!.totals.messages).toBe(2)
  })

  it('counts every sqlite row when no session store exists (infinite floor)', async () => {
    await putSqlite(join(home, '.minimax'), [
      ['s1', 't1', 'MiniMax-M2.5', T - 1000, 10, 1, 0, 0],
      ['s1', 't2', 'MiniMax-M2.5', T + 1000, 20, 2, 0, 0],
    ])

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions[0]!.totals.tokens).toBe(33)
  })

  it('reads sqlite from .mavis when .minimax has no database, and never counts both', async () => {
    const rows: Array<[string, string, string, number, number, number, number, number]> = [
      ['s1', 't1', 'MiniMax-M2.5', T - 1000, 10, 1, 0, 0],
    ]
    await putSqlite(join(home, '.minimax'), rows)
    await putSqlite(join(home, '.mavis'), rows)

    const payload = (await readMiniMaxCodeUsage(home)) as Payload
    expect(payload.contributions[0]!.totals.tokens).toBe(11)
  })
})

describe('readMiniMaxCodeUsage — payload', () => {
  it('survives the renderer consumer with nothing in the unclassified bucket', async () => {
    const dir = await session('s1', new Date(T))
    await putLedger(dir, [
      ledgerEvent([
        assistantMsg({ responseId: 'r1', model: 'MiniMax-M2.5', provider: 'minimax', input: 100, output: 10, cacheRead: 40, cacheWrite: 6 }),
      ]),
    ])

    const payload = await readMiniMaxCodeUsage(home)
    const vm = summarizeScan({ daily: payload })
    const row = vm.clients.find((c) => c.client === 'mcode')!
    expect(row.exists).toBe(true)
    // The fixture date is not "today" on every machine — the all-time column
    // is the date-independent one.
    expect(row.allTime.tokens).toBe(100 + 10 + 40 + 6)
    expect(vm.other).toBeNull()
  })

  it('returns null when the agent is not installed', async () => {
    expect(await readMiniMaxCodeUsage(home)).toBeNull()
  })
})
