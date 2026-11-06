import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeScan } from '@/lib/agent-usage'
import { cindyBuilds, parseSessionTranscript, readCindyUsage } from './cindy-usage'

/**
 * Cindy's reader has two contracts worth pinning down:
 *
 * 1. Only files that open with the Pi session header contribute usage — the
 *    agent home also holds extension caches and exports, and a stray `.jsonl`
 *    must never inflate the dashboard.
 * 2. One generation is counted once. A fork/clone replays the same entries
 *    (ids included) into a second transcript, so the reader deduplicates by
 *    entry id rather than by file.
 * 3. Every installed Cindy build is read, and each build is its own row: the
 *    domestic build (`Cindy`) and the international one (`CindyGlobal`) each
 *    keep their own agent home, and a session migrated between them still
 *    counts once.
 *
 * The aggregation assertions go through `summarizeScan` because that is the
 * only consumer of the payload shape: a payload that does not survive it is
 * not "correct" in any useful sense.
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coding-usage-cindy-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Epoch ms of a moment in the current visit's local day */
function nowMs(): number {
  return Date.now()
}

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

function header(id: string): unknown {
  return { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: 'D:\\repo' }
}

interface AssistantArgs {
  id: string
  model: string
  provider: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cost: number
  tsMs?: number
}

function assistant(a: AssistantArgs): unknown {
  return {
    type: 'message',
    id: a.id,
    parentId: null,
    timestamp: new Date(a.tsMs ?? nowMs()).toISOString(),
    message: {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: a.provider,
      model: a.model,
      usage: {
        input: a.input,
        output: a.output,
        cacheRead: a.cacheRead ?? 0,
        cacheWrite: a.cacheWrite ?? 0,
        // Pi accounts reasoning as part of output; it must not be added again.
        reasoning: 42,
        totalTokens: a.input + a.output + (a.cacheRead ?? 0) + (a.cacheWrite ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: a.cost },
      },
      stopReason: 'stop',
      timestamp: a.tsMs ?? nowMs(),
    },
  }
}

describe('parseSessionTranscript', () => {
  it('ignores files that do not open with the pi session header', () => {
    expect(parseSessionTranscript('')).toBeNull()
    expect(parseSessionTranscript(JSON.stringify({ type: 'other' }))).toBeNull()
    expect(parseSessionTranscript('not json')).toBeNull()
  })

  it('reads assistant usage, the recorded cost and the entry id', () => {
    const records = parseSessionTranscript(
      jsonl(header('s1'), assistant({ id: 'a1', model: 'deepseek/deepseek-v4-flash', provider: 'cindy', input: 1000, output: 100, cacheRead: 500, cost: 0.25 })),
    )
    expect(records).toHaveLength(1)
    expect(records![0]).toMatchObject({
      key: 'a1',
      providerId: 'cindy',
      modelId: 'deepseek/deepseek-v4-flash',
      input: 1000,
      output: 100,
      cacheRead: 500,
      cacheWrite: 0,
      costUsd: 0.25,
    })
  })

  it('counts usage entries outside the message list and attributes them to the last model', () => {
    const records = parseSessionTranscript(
      jsonl(
        header('s1'),
        assistant({ id: 'a1', model: 'moonshotai/kimi-k3.1-pro', provider: 'cindy', input: 10, output: 2, cost: 0.01 }),
        { type: 'usage', id: 'u1', kind: 'cache_warm', timestamp: new Date().toISOString(), usage: { input: 0, output: 0, cacheRead: 50000, cacheWrite: 0, cost: { total: 0.5 } } },
        { type: 'compaction', id: 'c1', timestamp: new Date().toISOString(), summary: 'x', usage: { input: 100, output: 20, cost: { total: 0.02 } } },
      ),
    )
    expect(records!.map((r) => r.key)).toEqual(['a1', 'u1', 'c1'])
    expect(records![1]).toMatchObject({ modelId: 'moonshotai/kimi-k3.1-pro', cacheRead: 50000, costUsd: 0.5 })
    expect(records![2]).toMatchObject({ modelId: 'moonshotai/kimi-k3.1-pro', input: 100, output: 20, costUsd: 0.02 })
  })

  it('skips entries without counters and torn trailing lines', () => {
    const records = parseSessionTranscript(
      jsonl(
        header('s1'),
        { type: 'message', id: 'a0', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
        assistant({ id: 'a1', model: 'm', provider: 'cindy', input: 5, output: 1, cost: 0 }),
        '{"type":"message","id":"torn"',
      ),
    )
    expect(records!.map((r) => r.key)).toEqual(['a1'])
  })
})

/** Agent home of one installed build (`Cindy` = domestic, `CindyGlobal` = international) */
function agentHome(root: string, build = 'Cindy'): string {
  return join(root, build, 'pi-agent-home')
}

describe('cindyBuilds', () => {
  it('resolves one row and one agent home per installed build under <appData>', async () => {
    // Both directory names are Cindy's, not this app's. Pinned literally: a
    // renamed level would make the reader find nothing and the agent row would
    // vanish with no error anywhere.
    await mkdir(agentHome(dir, 'Cindy'), { recursive: true })
    await mkdir(agentHome(dir, 'CindyGlobal'), { recursive: true })
    expect(await cindyBuilds(dir)).toEqual([
      { client: 'cindy', agentHome: agentHome(dir, 'Cindy') },
      { client: 'cindy-global', agentHome: agentHome(dir, 'CindyGlobal') },
    ])
  })

  it('gives an unknown Cindy-family directory the domestic row instead of dropping it', async () => {
    await mkdir(agentHome(dir, 'CindyNext'), { recursive: true })
    expect((await cindyBuilds(dir)).map((b) => `${b.client}:${b.agentHome}`)).toEqual([
      `cindy:${agentHome(dir, 'CindyNext')}`,
    ])
  })

  it('falls back to the known build names when appData cannot be listed', async () => {
    const missing = join(dir, 'missing')
    expect(await cindyBuilds(missing)).toEqual([
      { client: 'cindy', agentHome: join(missing, 'Cindy', 'pi-agent-home') },
      { client: 'cindy-global', agentHome: join(missing, 'CindyGlobal', 'pi-agent-home') },
    ])
  })

  it('reads the sessions placed in a build home', async () => {
    // End-to-end through the path the main process builds: the test never names
    // the two directory levels below `dir` itself.
    const home = agentHome(dir)
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(
      join(home, 'sessions', 'chat.jsonl'),
      jsonl(
        header('s1'),
        assistant({ id: 'a1', model: 'deepseek/deepseek-v4-flash', provider: 'cindy', input: 30, output: 3, cost: 0.01 }),
      ),
      'utf8',
    )

    const payload = (await readCindyUsage(dir)) as {
      contributions: Array<{ totals: { tokens: number; messages: number } }>
    }
    expect(payload.contributions).toHaveLength(1)
    expect(payload.contributions[0]!.totals).toMatchObject({ tokens: 33, messages: 1 })
  })
})

describe('readCindyUsage', () => {
  it('returns null when no build home has sessions', async () => {
    expect(await readCindyUsage(dir)).toBeNull()
  })

  it('aggregates chat and subagent sessions, ignoring non-session jsonl', async () => {
    const home = agentHome(dir)
    const sessions = join(home, 'sessions')
    const subagent = join(home, 'runtime', 'pi-subagent-runs', 'task', 'run')
    await mkdir(sessions, { recursive: true })
    await mkdir(subagent, { recursive: true })

    await writeFile(
      join(sessions, 'chat.jsonl'),
      jsonl(
        header('s1'),
        assistant({ id: 'a1', model: 'deepseek/deepseek-v4-flash', provider: 'cindy', input: 1000, output: 100, cacheRead: 500, cost: 0.25 }),
      ),
      'utf8',
    )
    await writeFile(
      join(subagent, 'run.jsonl'),
      jsonl(
        header('s2'),
        assistant({ id: 'a2', model: 'z-ai/glm-5.3-flash', provider: 'cindy', input: 200, output: 20, cost: 0.05 }),
      ),
      'utf8',
    )
    // Not a pi session: must not be summed
    await writeFile(join(sessions, 'export.jsonl'), jsonl({ type: 'export', usage: { input: 9999, output: 9999 } }), 'utf8')

    const payload = await readCindyUsage(dir)
    expect(payload).not.toBeNull()

    const root = payload as { contributions: Array<{ date: string; totals: { tokens: number; cost: number }; activeTimeMs: number; clients: Array<Record<string, unknown>> }> }
    expect(root.contributions).toHaveLength(1)
    const day = root.contributions[0]
    expect(day.totals.tokens).toBe(1000 + 100 + 500 + 200 + 20)
    expect(day.totals.cost).toBeCloseTo(0.3, 6)
    // No fabricated duration: Pi records no session span, and a guessed one
    // would both distort the tok/s rate and push a shared day past 24 h.
    expect(day.activeTimeMs).toBe(0)
    expect(day.clients).toHaveLength(2)
    expect(day.clients.map((c) => `${c.providerId}/${c.modelId}`).sort()).toEqual([
      'deepseek/deepseek-v4-flash',
      'zhipu/glm-5.3-flash',
    ])

    // The payload must survive the real consumer unchanged
    const vm = summarizeScan({ daily: payload })
    const row = vm.clients.find((c) => c.client === 'cindy')!
    expect(row.exists).toBe(true)
    expect(row.today.tokens).toBe(1820)
    expect(row.today.costUsd).toBeCloseTo(0.3, 6)
    expect(row.models.map((m) => m.model).sort()).toEqual(['deepseek-v4-flash', 'glm-5.3-flash'])
    // Nothing leaks into the "unclassified" bucket
    expect(vm.other).toBeNull()
  })

  it('counts a generation replayed by a forked transcript once', async () => {
    const home = agentHome(dir)
    const sessions = join(home, 'sessions')
    await mkdir(sessions, { recursive: true })
    const shared = assistant({ id: 'shared-1', model: 'deepseek/deepseek-v4-flash', provider: 'cindy', input: 400, output: 40, cost: 0.1 })
    await writeFile(join(sessions, 'parent.jsonl'), jsonl(header('s1'), shared), 'utf8')
    await writeFile(join(sessions, 'fork.jsonl'), jsonl(header('s2'), shared), 'utf8')

    const payload = await readCindyUsage(dir)
    const vm = summarizeScan({ daily: payload })
    const row = vm.clients.find((c) => c.client === 'cindy')!
    expect(row.allTime.tokens).toBe(440)
    expect(row.allTime.costUsd).toBeCloseTo(0.1, 6)
  })

  it('gives the domestic and the international build a row each', async () => {
    // The international build installs beside the domestic one and keeps its own
    // agent home; a reader that only knew `Cindy` reported nothing at all for a
    // user who moved to the international build, and folding the two together
    // made "which build spent this" unanswerable.
    const cn = join(agentHome(dir, 'Cindy'), 'sessions')
    const global = join(agentHome(dir, 'CindyGlobal'), 'sessions')
    await mkdir(cn, { recursive: true })
    await mkdir(global, { recursive: true })
    await writeFile(
      join(cn, 'cn.jsonl'),
      jsonl(
        header('s1'),
        assistant({ id: 'cn-1', model: 'deepseek/deepseek-v4-flash', provider: 'cindy', input: 100, output: 10, cost: 0.02 }),
      ),
      'utf8',
    )
    await writeFile(
      join(global, 'global.jsonl'),
      jsonl(
        header('s2'),
        assistant({ id: 'g-1', model: 'openai/gpt-6-sol', provider: 'openai-codex', input: 200, output: 20, cost: 0.5 }),
      ),
      'utf8',
    )

    const payload = await readCindyUsage(dir)
    const vm = summarizeScan({ daily: payload })
    const domestic = vm.clients.find((c) => c.client === 'cindy')!
    const international = vm.clients.find((c) => c.client === 'cindy-global')!
    expect(domestic.today.tokens).toBe(110)
    expect(domestic.today.costUsd).toBeCloseTo(0.02, 6)
    expect(domestic.models.map((m) => m.model)).toEqual(['deepseek-v4-flash'])
    expect(international.today.tokens).toBe(220)
    expect(international.today.costUsd).toBeCloseTo(0.5, 6)
    expect(international.models.map((m) => m.model)).toEqual(['gpt-6-sol'])
    // The day total still equals the sum of its rows: a split that leaked into
    // the "unclassified" bucket would quietly inflate every headline figure.
    expect(vm.todayTotal.tokens).toBe(110 + 220)
    expect(vm.other).toBeNull()
  })

  it('attributes a routing-prefixed gateway model to its channel', async () => {
    // The international build records gateway models as `auto/<model>` on the
    // provider that served them; `auto` is a routing directive, not a vendor, so
    // it must not become a provider row — and the prefix is stripped so the same
    // model priced and named identically to the domestic build's reports.
    const sessions = join(agentHome(dir, 'CindyGlobal'), 'sessions')
    await mkdir(sessions, { recursive: true })
    await writeFile(
      join(sessions, 'gateway.jsonl'),
      jsonl(
        header('s1'),
        assistant({
          id: 'g-1',
          model: 'auto/deepseek-v4.1-flash',
          provider: 'little-jochen',
          input: 10,
          output: 2,
          cost: 0,
        }),
      ),
      'utf8',
    )

    const payload = (await readCindyUsage(dir)) as {
      contributions: Array<{ clients: Array<{ providerId: string; modelId: string }> }>
    }
    expect(payload.contributions[0]!.clients).toHaveLength(1)
    expect(payload.contributions[0]!.clients[0]).toMatchObject({
      providerId: 'little-jochen',
      modelId: 'deepseek-v4.1-flash',
    })
  })

  it('counts a session migrated between builds once, on the build that ran it', async () => {
    // The international build copies the domestic profile over on first run, so
    // the same transcript can sit in both agent homes; the dedup must span them
    // (once, not twice) and the domestic home is walked first so the generation
    // stays on the row that actually produced it.
    const shared = assistant({ id: 'migrated-1', model: 'deepseek/deepseek-v4-flash', provider: 'cindy', input: 70, output: 7, cost: 0.01 })
    for (const build of ['Cindy', 'CindyGlobal']) {
      const sessions = join(agentHome(dir, build), 'sessions')
      await mkdir(sessions, { recursive: true })
      await writeFile(join(sessions, 'chat.jsonl'), jsonl(header(`s-${build}`), shared), 'utf8')
    }

    const payload = await readCindyUsage(dir)
    const vm = summarizeScan({ daily: payload })
    const domestic = vm.clients.find((c) => c.client === 'cindy')!
    const international = vm.clients.find((c) => c.client === 'cindy-global')!
    expect(domestic.allTime.tokens).toBe(77)
    expect(domestic.allTime.costUsd).toBeCloseTo(0.01, 6)
    expect(international.exists).toBe(false)
    expect(vm.allTimeTotal.tokens).toBe(77)
  })
})
