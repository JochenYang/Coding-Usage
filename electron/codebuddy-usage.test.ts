import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeScan } from '@/lib/agent-usage'
import { hasClientEntries, mergeGraphPayloads } from './tokscale-merge'
import { readCodeBuddyUsage } from './codebuddy-usage'

/**
 * The CN IDE reader is the `mergeAlways` half of the codebuddy row: tokscale
 * already scans the CLI transcripts under `~/.codebuddy/projects`, so this
 * reader must count ONLY the IDE store under
 * `%LOCALAPPDATA%/CodeBuddyExtension` — any overlap between the two stores
 * would double count the same generations, which is the highest-risk failure
 * mode of an unconditional merge. These tests pin the disjoint origins, the
 * statsSnapshot → counter mapping and the payload arithmetic through the
 * renderer's own consumer (`summarizeScan`).
 */

const dirs: string[] = []
let localAppData = ''
let homeDir = ''
let savedLocalAppData: string | undefined

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(async () => {
  localAppData = await tempDir('codebuddy-local-')
  homeDir = await tempDir('codebuddy-home-')
  savedLocalAppData = process.env.LOCALAPPDATA
  // The reader resolves its root from LOCALAPPDATA before falling back to
  // <home>/AppData/Local — on Windows the variable is always set, so tests
  // must control it explicitly to reach either branch deterministically.
  process.env.LOCALAPPDATA = localAppData
})

afterEach(async () => {
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = savedLocalAppData
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Local calendar day, same bucketing the reader and the renderer use */
function localDayOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const NOW = new Date()
const today = localDayOf(NOW.getTime())
const createdAt = NOW.toISOString()

/** `statsSnapshot` with only the fields a fixture wants (absent ≠ zero) */
function snapshot(fields: Record<string, number>): Record<string, number> {
  return fields
}

/**
 * One IDE message file. `extra` is itself a JSON string inside the envelope —
 * that nesting is the shape the reader must navigate, and `message` (the chat
 * body) is a string the reader promises never to touch.
 */
function ideMessage(args: {
  id: string
  createdAt?: string
  modelId?: string
  body?: string
  stats?: Record<string, number> | null
}): string {
  const extra: Record<string, unknown> = {}
  if (args.modelId !== undefined) extra.modelId = args.modelId
  if (args.stats) extra.statsSnapshot = args.stats
  return JSON.stringify({
    id: args.id,
    role: 'assistant',
    message: args.body ?? JSON.stringify({ role: 'assistant', content: [`body of ${args.id}`] }),
    extra: JSON.stringify(extra),
    createdAt: args.createdAt ?? createdAt,
  })
}

/**
 * Drop one conversation (with its `index.json` leaf marker and `messages`
 * dir) into the IDE store under `base`; returns the messages directory.
 */
async function putConversation(
  conv: string,
  files: Record<string, string>,
  base = localAppData,
  userId = 'user-1',
  ideUserId = 'user-1',
): Promise<string> {
  const convDir = join(base, 'CodeBuddyExtension', 'Data', userId, 'CodeBuddyIDE', ideUserId, 'history', 'ws-hash', conv)
  await mkdir(join(convDir, 'messages'), { recursive: true })
  await writeFile(join(convDir, 'index.json'), '{}', 'utf8')
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(convDir, 'messages', name), content, 'utf8')
  }
  return join(convDir, 'messages')
}

interface Payload {
  contributions: Array<{
    date: string
    totals: { tokens: number; cost: number; messages: number }
    tokenBreakdown: Record<string, number>
    clients: Array<{ client: string; modelId: string; providerId: string; tokens: Record<string, number>; cost: number; messages: number }>
  }>
}

describe('readCodeBuddyUsage', () => {
  it('maps statsSnapshot counters per provider+model and never touches message bodies', async () => {
    const bodyMarker = 'CHAT-BODY-SENTINEL-9f3a'
    await putConversation('conv-1', {
      'm1.json': ideMessage({
        id: 'm1',
        // cacheMissTokens present: the uncached column is the miss, not the total
        modelId: 'MiniMax-M2.5',
        body: bodyMarker,
        stats: snapshot({ inputTokens: 500, cachedInputTokens: 300, cacheMissTokens: 200, cacheWriteTokens: 50, outputTokens: 100 }),
      }),
      'm2.json': ideMessage({
        id: 'm2',
        // cacheMissTokens absent: input must derive as totalInput − cacheRead
        modelId: 'GLM-5.3',
        stats: snapshot({ inputTokens: 500, cachedInputTokens: 200, outputTokens: 30 }),
      }),
    })

    const payload = (await readCodeBuddyUsage(homeDir)) as Payload
    expect(payload.contributions).toHaveLength(1)
    const day = payload.contributions[0]!
    expect(day.date).toBe(today)

    const byModel = day.clients.map((c) => ({ ...c }))
    expect(byModel).toHaveLength(2)
    const minimax = byModel.find((c) => c.modelId === 'MiniMax-M2.5')!
    expect(minimax).toMatchObject({
      client: 'codebuddy',
      providerId: 'minimax', // bare vendor model name, inferred from the id
      cost: 0, // priced later by the shared price table, never fabricated here
      messages: 1,
    })
    expect(minimax.tokens).toEqual({ input: 200, output: 100, cacheRead: 300, cacheWrite: 50 })

    const glm = byModel.find((c) => c.modelId === 'GLM-5.3')!
    expect(glm.providerId).toBe('zhipu')
    // 500 total prompt − 200 cache hit = 300 uncached: the cache-hit portion
    // must not leak into the input column (the double-count trap).
    expect(glm.tokens).toEqual({ input: 300, output: 30, cacheRead: 200, cacheWrite: 0 })

    // Day totals are the sum of the very entries above, so the renderer's
    // unclassified derivation stays zero.
    expect(day.totals).toEqual({ tokens: 650 + 530, cost: 0, messages: 2 })
    expect(day.tokenBreakdown).toEqual({ input: 500, output: 130, cacheRead: 500, cacheWrite: 50 })

    // Privacy contract: the chat body never enters the payload.
    expect(JSON.stringify(payload)).not.toContain(bodyMarker)

    // The payload must survive the only real consumer unchanged.
    const vm = summarizeScan({ daily: payload })
    const row = vm.clients.find((c) => c.client === 'codebuddy')!
    expect(row.exists).toBe(true)
    expect(row.today.tokens).toBe(650 + 530)
    expect(vm.other).toBeNull()
  })

  it('skips messages without usage, unreadable payloads and non-usage files', async () => {
    await putConversation('conv-1', {
      // user message: no statsSnapshot, no model call behind it
      'u1.json': JSON.stringify({ id: 'u1', role: 'user', message: 'hi', extra: '', createdAt }),
      // all-zero counters
      'z1.json': ideMessage({ id: 'z1', modelId: 'MiniMax-M2.5', stats: snapshot({ inputTokens: 0, outputTokens: 0 }) }),
      // extra is not valid JSON
      'b1.json': JSON.stringify({ id: 'b1', role: 'assistant', message: 'x', extra: '{not-json', createdAt }),
      // createdAt unparseable → the record has no day to land in
      'b2.json': JSON.stringify({
        id: 'b2',
        role: 'assistant',
        message: 'x',
        extra: JSON.stringify({ modelId: 'MiniMax-M2.5', statsSnapshot: { inputTokens: 99 } }),
        createdAt: 'not-a-date',
      }),
      // zero-byte file
      'empty.json': '',
      // not a .json file at all
      'notes.txt': ideMessage({ id: 'n', modelId: 'MiniMax-M2.5', stats: snapshot({ inputTokens: 99999 }) }),
    })

    expect(await readCodeBuddyUsage(homeDir)).toBeNull()
  })

  it('counts every installed account and requires the index.json conversation marker', async () => {
    await putConversation('conv-1', {
      'm1.json': ideMessage({ id: 'm1', modelId: 'MiniMax-M2.5', stats: snapshot({ inputTokens: 10, outputTokens: 1 }) }),
    })
    await putConversation(
      'conv-2',
      { 'm2.json': ideMessage({ id: 'm2', modelId: 'MiniMax-M2.5', stats: snapshot({ inputTokens: 20, outputTokens: 2 }) }) },
      localAppData,
      'user-2',
      'user-2',
    )
    // No index.json: not a conversation leaf, its messages must not count —
    // otherwise a half-written conversation would contribute mid-write.
    const orphan = join(localAppData, 'CodeBuddyExtension', 'Data', 'user-3', 'CodeBuddyIDE', 'user-3', 'history', 'ws', 'conv-orphan', 'messages')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'm3.json'), ideMessage({ id: 'm3', modelId: 'MiniMax-M2.5', stats: snapshot({ inputTokens: 500, outputTokens: 5 }) }), 'utf8')

    const payload = (await readCodeBuddyUsage(homeDir)) as Payload
    const day = payload.contributions[0]!
    expect(day.totals.messages).toBe(2)
    expect(day.totals.tokens).toBe(10 + 1 + 20 + 2)
  })

  it('never reads the CLI transcript store tokscale already scans (mergeAlways disjointness)', async () => {
    // tokscale's codebuddy half lives at ~/.codebuddy/projects (Claude-Code-
    // shaped jsonl). If this reader ever walked it, the unconditional merge in
    // main.ts would count the CLI half twice — parse errors included.
    const cliStore = join(homeDir, '.codebuddy', 'projects', 'proj-1')
    await mkdir(cliStore, { recursive: true })
    await writeFile(
      join(cliStore, 'session.jsonl'),
      [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 999999, output_tokens: 888888 } } }),
      ].join('\n'),
      'utf8',
    )

    // CLI store alone → nothing: this reader's origin is the IDE store only.
    expect(await readCodeBuddyUsage(homeDir)).toBeNull()

    // CLI store present alongside the IDE store → only the IDE half is read.
    await putConversation('conv-1', {
      'm1.json': ideMessage({ id: 'm1', modelId: 'MiniMax-M2.5', stats: snapshot({ inputTokens: 100, outputTokens: 10 }) }),
    })
    const payload = (await readCodeBuddyUsage(homeDir)) as Payload
    expect(payload.contributions[0]!.totals.tokens).toBe(110)
  })

  it('falls back to <home>/AppData/Local when LOCALAPPDATA is unset', async () => {
    delete process.env.LOCALAPPDATA
    // The fallback root is <home>/AppData/Local, not <home> itself.
    await putConversation('conv-1', {
      'm1.json': ideMessage({ id: 'm1', modelId: 'kimi-k3.1', stats: snapshot({ inputTokens: 30, outputTokens: 3 }) }),
    }, join(homeDir, 'AppData', 'Local'), 'user-1', 'user-1')

    const payload = (await readCodeBuddyUsage(homeDir)) as Payload
    const clients = payload.contributions[0]!.clients
    expect(clients).toHaveLength(1)
    // bare non-vendor id falls back to the gateway owner
    expect(clients[0]).toMatchObject({ providerId: 'moonshot', modelId: 'kimi-k3.1', messages: 1 })
  })

  it('returns null when the IDE is not installed', async () => {
    expect(await readCodeBuddyUsage(homeDir)).toBeNull()
  })
})

describe('mergeAlways composition (mirrors electron/main.ts withLocalAgents)', () => {
  /** Verbatim copy of the composition the main process runs over the scan */
  function withLocalAgents(payload: unknown, localAgents: Array<{ client: string; payload: unknown; mergeAlways?: boolean }>): unknown {
    const missing = localAgents.filter((entry) => entry.mergeAlways || !hasClientEntries(payload, entry.client))
    return missing.length === 0 ? payload : mergeGraphPayloads([payload, ...missing.map((e) => e.payload)])
  }

  /** tokscale-shaped scan reporting the CLI half of the same client id */
  function cliScanPayload(): unknown {
    return {
      meta: null,
      contributions: [
        {
          date: today,
          totals: { tokens: 900, cost: 0, messages: 3 },
          tokenBreakdown: { input: 700, output: 200, cacheRead: 0, cacheWrite: 0 },
          clients: [
            { client: 'codebuddy', modelId: 'claude-sonnet-4', providerId: 'anthropic', tokens: { input: 700, output: 200, cacheRead: 0, cacheWrite: 0 }, cost: 0, messages: 3 },
          ],
          intensity: 0,
          activeTimeMs: 0,
        },
      ],
    }
  }

  async function idePayload(): Promise<unknown> {
    await putConversation('conv-1', {
      'm1.json': ideMessage({ id: 'm1', modelId: 'MiniMax-M2.5', stats: snapshot({ inputTokens: 500, cachedInputTokens: 300, cacheMissTokens: 200, cacheWriteTokens: 50, outputTokens: 100 }) }),
    })
    return await readCodeBuddyUsage(homeDir)
  }

  it('merges the IDE half alongside a scan that already reports codebuddy, without double counting', async () => {
    const scan = cliScanPayload()
    const local = await idePayload()

    // The scan reports the client: a plain local entry would be dropped, so
    // the unconditional merge is what makes the IDE half visible at all.
    expect(hasClientEntries(scan, 'codebuddy')).toBe(true)

    const merged = withLocalAgents(scan, [{ client: 'codebuddy', payload: local, mergeAlways: true }]) as {
      contributions: Array<{ totals: { tokens: number }; clients: Array<{ client: string; modelId: string; tokens: Record<string, number> }> }>
      summary: Record<string, unknown>
    }

    // Both origins survive side by side on the same day: 900 (CLI) + 650 (IDE)
    // — each generation counted exactly once, none lost to the dedup rule.
    expect(merged.contributions[0]!.totals.tokens).toBe(900 + 650)
    expect(merged.contributions[0]!.clients).toHaveLength(2)
    expect(merged.contributions[0]!.clients.map((c) => c.modelId).sort()).toEqual(['MiniMax-M2.5', 'claude-sonnet-4'])
    expect(merged.summary).toMatchObject({ totalTokens: 900 + 650, clients: ['codebuddy'] })
  })

  it('would drop the IDE half without the mergeAlways opt-in', async () => {
    const scan = cliScanPayload()
    const local = await idePayload()

    const deduped = withLocalAgents(scan, [{ client: 'codebuddy', payload: local }]) as {
      contributions: Array<{ totals: { tokens: number } }>
    }
    // The skip rule wins: the local payload is discarded, the day keeps only
    // the tokscale half. This is exactly what main.ts opts out of.
    expect(deduped).toEqual(scan)
    expect(deduped.contributions[0]!.totals.tokens).toBe(900)
  })
})
