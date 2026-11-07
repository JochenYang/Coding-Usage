import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeScan } from '@/lib/agent-usage'
import { decodeZstdFrames, parseDshTranscript, readDshUsage } from './dsh-usage'

/**
 * DSH's reader has three contracts worth pinning down:
 *
 * 1. Usage comes from `assistant/message` events (`data.usage`, camelCase) — the
 *    shape tokscale's own reader handles, minus its fail-closed behaviour.
 * 2. `.jsonl.zstd` transcripts are append-only *multi-frame* files: every frame
 *    must be decoded, not just the first, and one undecodable frame must not
 *    void the session (the whole reason this module exists).
 * 3. A session directory holds several versions (v3/v4) plus a hard-linked
 *    alias; exactly one transcript per directory is counted.
 *
 * Aggregation assertions go through `summarizeScan` — the only consumer of the
 * payload shape.
 */

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'coding-usage-dsh-'))
  delete process.env.DSH_HOME
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Epoch ms of a moment in the current visit's local day */
function nowMs(): number {
  return Date.now()
}

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n'
}

function header(seedLength?: number): unknown {
  return { type: 'session', version: 4, id: 'session-1', createdAt: new Date(nowMs()).toISOString(), ...(seedLength ? { seedLength } : {}) }
}

interface EventArgs {
  id: string
  input?: number
  output?: number
  cacheRead?: number
  provider?: string
  model?: string
  seq?: number
  tsMs?: number
}

function message(a: EventArgs): unknown {
  return {
    type: 'assistant/message',
    seq: a.seq ?? 1,
    time: a.tsMs ?? nowMs(),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: a.id,
        role: 'assistant',
        source: { kind: 'model', provider: a.provider ?? 'big-jochen', model: a.model ?? 'group/auto-deepseek-v4-1-flash' },
      },
      usage: {
        inputTokens: a.input ?? 0,
        outputTokens: a.output ?? 0,
        cacheReadTokens: a.cacheRead ?? 0,
        totalTokens: (a.input ?? 0) + (a.output ?? 0) + (a.cacheRead ?? 0),
      },
    },
  }
}

async function writeSession(project: string, session: string, file: string, content: string | Buffer): Promise<void> {
  const dir = join(home, '.dsh', 'sessions', project, session)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), content)
}

/** Two zstd frames, the way DSH appends: decoder must read both */
function multiFrame(...chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => zstdCompressSync(Buffer.from(chunk))))
}

describe('decodeZstdFrames', () => {
  it('decodes every concatenated frame, not just the first', () => {
    const decoded = decodeZstdFrames(multiFrame('{"a":1}\n', '{"b":2}\n', '{"c":3}\n'))
    expect(decoded.text).toBe('{"a":1}\n{"b":2}\n{"c":3}\n')
    expect(decoded.droppedFrames).toBe(0)
  })

  it('keeps the decodable frames around a corrupt one', () => {
    // How a junk byte run is classified differs between zstd builds (Node 22 and
    // 24 disagree on whether it is a dropped frame or an empty one), so this
    // asserts the part that must hold everywhere: the readable frames survive.
    const good1 = zstdCompressSync(Buffer.from('one\n'))
    const corrupt = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03])
    const good2 = zstdCompressSync(Buffer.from('two\n'))
    expect(decodeZstdFrames(Buffer.concat([good1, corrupt, good2])).text).toBe('one\ntwo\n')
  })

  it('reports a non-empty input with no frame at all as undecodable', () => {
    // Deterministic on every build: nothing here is a zstd frame
    expect(decodeZstdFrames(Buffer.from('broken-without-magic'))).toEqual({ text: '', droppedFrames: 1 })
    expect(decodeZstdFrames(Buffer.alloc(0))).toEqual({ text: '', droppedFrames: 0 })
  })
})

describe('parseDshTranscript', () => {
  it('reads camelCase usage and the serving channel from the message source', () => {
    const { records } = parseDshTranscript(jsonl(header(), message({ id: 'm1', input: 1000, output: 20, cacheRead: 500 })))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      identity: 'id:m1',
      providerId: 'big-jochen',
      modelId: 'auto-deepseek-v4-1-flash',
      input: 1000,
      output: 20,
      cacheRead: 500,
    })
  })

  it('skips the parent prefix a fork copied (seq below seedLength)', () => {
    const { records } = parseDshTranscript(
      jsonl(
        header(10),
        message({ id: 'copied', seq: 5, input: 900 }),
        message({ id: 'own', seq: 11, input: 10 }),
      ),
    )
    expect(records.map((r) => r.identity)).toEqual(['id:own'])
  })

  it('honours the v4 seeded-fork boundary (`session/end-seed` with inherited)', () => {
    // Real DSH v4 data marks the copied prefix this way, not with header.seedLength;
    // ignoring it billed the whole inherited prefix to the child session.
    const { records } = parseDshTranscript(
      jsonl(
        header(),
        message({ id: 'inherited', seq: 1, input: 900 }),
        { type: 'session/end-seed', seq: 5, time: nowMs(), data: { inherited: true } },
        message({ id: 'own', seq: 6, input: 10 }),
      ),
    )
    expect(records.map((r) => r.identity)).toEqual(['id:own'])
  })

  it('counts attempts and compaction summaries, and ignores usage-less events', () => {
    const { records } = parseDshTranscript(
      jsonl(
        header(),
        { type: 'step/start', seq: 1, time: nowMs(), data: { turn: 1, step: 1 } },
        message({ id: 'm1', seq: 2, input: 10 }),
        { type: 'compaction/summary', seq: 3, time: nowMs(), data: { usage: { inputTokens: 50, outputTokens: 5 } } },
        { type: 'user/message', seq: 4, time: nowMs(), data: { message: { id: 'u1' } } },
      ),
    )
    expect(records.map((r) => r.identity)).toEqual(['id:m1', ''])
  })

  it('attributes a compaction summary to the channel on `data`, not `dsh/unknown`', () => {
    const { records } = parseDshTranscript(
      jsonl(header(), {
        type: 'compaction/summary',
        seq: 2,
        time: nowMs(),
        data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', usage: { inputTokens: 407779, outputTokens: 2836 } },
      }),
    )
    expect(records[0]).toMatchObject({ providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' })
  })

  it('keeps the final snapshot when one message id is appended twice', () => {
    const { records } = parseDshTranscript(
      jsonl(header(), message({ id: 'm1', seq: 2, input: 10 }), message({ id: 'm1', seq: 3, input: 100 })),
    )
    expect(records).toHaveLength(1)
    expect(records[0]!.input).toBe(100)
  })

  it('keeps parsing around an unparsable line and claims nothing for it', () => {
    const { records, claimedKeys } = parseDshTranscript(
      `${jsonl(header(), message({ id: 'm1', seq: 2, input: 10 }))}{not json\n` +
        jsonl(message({ id: 'm2', seq: 3, input: 20 })),
      's',
    )
    expect(records.map((r) => r.identity)).toEqual(['id:m1', 'id:m2'])
    expect(claimedKeys).toEqual(['s#2', 's#3'])
  })

  it('does not claim a stub line, so the store can supply the real report', () => {
    const { records, claimedKeys } = parseDshTranscript(
      jsonl(header(), message({ id: 'm1', seq: 2, input: 0, output: 0 })),
      's',
    )
    expect(records).toHaveLength(0)
    expect(claimedKeys).toEqual([])
  })
})

describe('readDshUsage', () => {
  it('returns null without sessions', async () => {
    expect(await readDshUsage(home)).toBeNull()
  })

  it('reads a multi-frame transcript into a dsh payload the renderer accepts', async () => {
    await writeSession(
      '--D-codes-project--',
      'session-a',
      'session.v4.jsonl.zstd',
      multiFrame(
        jsonl(header()),
        jsonl(message({ id: 'm1', seq: 2, input: 100, output: 10, cacheRead: 40 })),
        jsonl(message({ id: 'm2', seq: 3, input: 200, output: 20 })),
      ),
    )

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const row = vm.clients.find((c) => c.client === 'dsh')!
    expect(row.exists).toBe(true)
    expect(row.today.tokens).toBe(100 + 10 + 40 + 200 + 20)
    expect(row.today.messages).toBe(2)
    expect(row.models.map((m) => m.model).sort()).toEqual(['auto-deepseek-v4-1-flash'])
    expect(vm.other).toBeNull()
  })

  it('counts exactly one transcript per session directory (highest version)', async () => {
    const v3 = jsonl(header(), message({ id: 'old', input: 10, output: 1 }))
    const v4 = jsonl(header(), message({ id: 'new', input: 20, output: 2 }))
    await writeSession('p', 's', 'session.v3.jsonl', v3)
    await writeSession('p', 's', 'session.v4.jsonl', v4)
    // The old alias shim's hard-linked name can also be lying around
    await writeSession('p', 's', 'session.jsonl', v3)

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const row = vm.clients.find((c) => c.client === 'dsh')!
    expect(row.today.tokens).toBe(22)
    expect(row.today.messages).toBe(1)
  })

  it('counts a message copied by a fork once', async () => {
    const copied = message({ id: 'shared-1', seq: 2, input: 70, output: 7 })
    await writeSession('p', 'parent', 'session.v4.jsonl', jsonl(header(), copied))
    await writeSession('p', 'fork', 'session.v4.jsonl', jsonl(header(), copied))

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const row = vm.clients.find((c) => c.client === 'dsh')!
    expect(row.today.tokens).toBe(77)
    expect(row.today.messages).toBe(1)
  })

  it('keeps the readable part of a session whose tail frame is damaged', async () => {
    // The reason this reader exists: tokscale drops the whole transcript here.
    const good = zstdCompressSync(Buffer.from(jsonl(header(), message({ id: 'm1', input: 500, output: 50 }))))
    const broken = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not-a-frame'), good.subarray(0, 8)])
    await writeSession('p', 's', 'session.v4.jsonl.zstd', Buffer.concat([good, broken]))

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const row = vm.clients.find((c) => c.client === 'dsh')!
    expect(row.today.tokens).toBe(550)
  })

  it('recovers the events a damaged transcript lost from the usage store', async () => {
    // A torn transcript used to mark the whole session as covered, so the store's
    // complete record of it was discarded: readable 100 + lost 200 + readable 300
    // came out as 400 instead of 600.
    const good1 = zstdCompressSync(Buffer.from(jsonl(header(), message({ id: 'm1', seq: 1, input: 100 }))))
    const broken = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not-a-frame')])
    const good2 = zstdCompressSync(Buffer.from(jsonl(message({ id: 'm3', seq: 3, input: 300 }))))
    await writeSession('p', 's', 'session.v4.jsonl.zstd', Buffer.concat([good1, broken, good2]))

    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    const row = (seq: number, input: number): string =>
      JSON.stringify({ sessionId: 's', seq, time: nowMs(), provider: 'p', model: 'm', inputTokens: input, outputTokens: 0 })
    await writeFile(join(dir, 'usage.jsonl'), `${row(1, 100)}\n${row(2, 200)}\n${row(3, 300)}\n`, 'utf8')

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(600)
    expect(dsh.today.messages).toBe(3)
  })

  it('counts sessions the app deleted, from its own usage store', async () => {
    // DSH prunes session transcripts; its usage plugin keeps the only record.
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    const row = (sessionId: string, seq: number, input: number, output: number): string =>
      JSON.stringify({
        sessionId,
        seq,
        time: nowMs(),
        provider: 'big-jochen',
        model: 'group/auto-deepseek-v4-1-flash',
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    await writeFile(
      join(dir, 'usage.jsonl'),
      `${row('gone-session', 1, 300, 30)}\n${row('gone-session', 2, 30, 3)}\n${row('gone-session', 2, 30, 3)}\n`,
      'utf8',
    )

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    // The duplicated (sessionId, seq) row is folded once
    expect(dsh.today.tokens).toBe(363)
    expect(dsh.today.messages).toBe(2)
    expect(dsh.models.map((m) => m.model)).toEqual(['auto-deepseek-v4-1-flash'])
  })

  it('adds the store rows for events a readable transcript does not hold', async () => {
    // A killed writer leaves a *clean* prefix, not a torn line, so "every line
    // parsed" cannot mean "this session is complete".
    await writeSession('p', 'kept', 'session.v4.jsonl', jsonl(header(), message({ id: 'm1', seq: 1, input: 100 })))
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    const row = (seq: number, input: number): string =>
      JSON.stringify({ sessionId: 'kept', seq, time: nowMs(), provider: 'p', model: 'm', inputTokens: input, outputTokens: 0 })
    await writeFile(join(dir, 'usage.jsonl'), `${row(1, 100)}\n${row(2, 200)}\n`, 'utf8')

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    // seq 1 counted once, seq 2 recovered from the store
    expect(dsh.today.tokens).toBe(300)
    expect(dsh.today.messages).toBe(2)
  })

  it('counts a superseded snapshot once even when the store holds its earlier row', async () => {
    // Two snapshots of one generation (seq 1 = 10, seq 2 = 100) plus a torn tail
    // that forces reconciliation: the store's row for seq 1 must not be added.
    const events = jsonl(
      header(),
      message({ id: 'm1', seq: 1, input: 10 }),
      message({ id: 'm1', seq: 2, input: 100 }),
    )
    await writeSession('p', 'snap', 'session.v4.jsonl', `${events}{torn`)
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    const row = (seq: number, input: number): string =>
      JSON.stringify({ sessionId: 'snap', seq, time: nowMs(), provider: 'p', model: 'm', inputTokens: input, outputTokens: 0 })
    await writeFile(join(dir, 'usage.jsonl'), `${row(1, 10)}\n${row(2, 100)}\n`, 'utf8')

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(100)
    expect(dsh.today.messages).toBe(1)
  })

  it('treats a non-empty .zstd with no frame as undecodable, not as an empty session', async () => {
    await writeSession('p', 'broken', 'session.v4.jsonl.zstd', Buffer.from('broken-without-magic'))
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'usage.jsonl'),
      `${JSON.stringify({ sessionId: 'broken', seq: 1, time: nowMs(), provider: 'p', model: 'm', inputTokens: 100, outputTokens: 0 })}\n`,
      'utf8',
    )

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(100)
    expect(dsh.today.messages).toBe(1)
  })

  it('keeps a forked copy claimed, so the store cannot add it back', async () => {
    const copied = message({ id: 'shared-1', seq: 2, input: 70, output: 7 })
    await writeSession('p', 'parent', 'session.v4.jsonl', jsonl(header(), copied))
    // The fork's transcript is torn, so its session is reconciled with the store
    await writeSession('p', 'fork', 'session.v4.jsonl', `${jsonl(header(), copied)}{torn`)
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    const row = (sessionId: string): string =>
      JSON.stringify({ sessionId, seq: 2, time: nowMs(), provider: 'big-jochen', model: 'group/auto-deepseek-v4-1-flash', inputTokens: 70, outputTokens: 7 })
    await writeFile(join(dir, 'usage.jsonl'), `${row('parent')}\n${row('fork')}\n`, 'utf8')

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(77)
    expect(dsh.today.messages).toBe(1)
  })

  it('claims an early zero-counter snapshot once the same generation reports', async () => {
    // id=m1 has a stub snapshot (seq 1, no counters) and a real one (seq 2). The
    // stub's key must be claimed, or the store's stale row for it is added on top.
    await writeSession(
      'p',
      'snap0',
      'session.v4.jsonl',
      jsonl(header(), message({ id: 'm1', seq: 1, input: 0, output: 0 }), message({ id: 'm1', seq: 2, input: 100 })),
    )
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    const row = (seq: number, input: number): string =>
      JSON.stringify({ sessionId: 'snap0', seq, time: nowMs(), provider: 'p', model: 'm', inputTokens: input, outputTokens: 0 })
    await writeFile(join(dir, 'usage.jsonl'), `${row(1, 10)}\n${row(2, 100)}\n`, 'utf8')

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(100)
    expect(dsh.today.messages).toBe(1)
  })

  it('counts a transcript-only compaction summary (no message id)', async () => {
    // A compaction summary names no message, so its identity is its event key —
    // which used to make it skip itself in the shared claim set.
    await writeSession(
      'p',
      'compact',
      'session.v4.jsonl',
      jsonl(header(), {
        type: 'compaction/summary',
        seq: 2,
        time: nowMs(),
        data: { provider: 'p', model: 'm', usage: { inputTokens: 50, outputTokens: 5 } },
      }),
    )

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(55)
    expect(dsh.today.messages).toBe(1)
  })

  it('lets the store fill an event whose transcript line carries no counters', async () => {
    await writeSession('p', 'stub', 'session.v4.jsonl', jsonl(header(), message({ id: 'm1', seq: 1, input: 0, output: 0 })))
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'usage.jsonl'),
      `${JSON.stringify({ sessionId: 'stub', seq: 1, time: nowMs(), provider: 'p', model: 'm', inputTokens: 100, outputTokens: 0 })}\n`,
      'utf8',
    )

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(100)
    expect(dsh.today.messages).toBe(1)
  })

  it('keeps message ids and event keys in separate namespaces', async () => {
    // `id:foo#3` (a message id) must not swallow session `id:foo`, seq 3
    await writeSession('p', 'ns', 'session.v4.jsonl', jsonl(header(), message({ id: 'foo#3', seq: 1, input: 100 })))
    const dir = join(home, '.dsh', 'storages', 'dsh-app-plugin-usage')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'usage.jsonl'),
      `${JSON.stringify({ sessionId: 'id:foo', seq: 3, time: nowMs(), provider: 'p', model: 'm', inputTokens: 50, outputTokens: 0 })}\n`,
      'utf8',
    )

    const vm = summarizeScan({ daily: await readDshUsage(home) })
    const dsh = vm.clients.find((c) => c.client === 'dsh')!
    expect(dsh.today.tokens).toBe(150)
    expect(dsh.today.messages).toBe(2)
  })
})
