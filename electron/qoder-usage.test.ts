import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarizeScan } from '@/lib/agent-usage'
import { readQoderUsage } from './qoder-usage'

/**
 * Qoder's reader has two contracts worth pinning down:
 *
 * 1. One row per installed build. The CN build (`~/.qoder-cn`) and the global
 *    build (`~/.qoder`) are separate products with separate quotas, so their
 *    usage must not be summed into one line.
 * 2. Credits are a unit of their own. The global build reports four zeroed
 *    token counters and a real `credits` figure; folding credits into tokens or
 *    into cost would invent a number the vendor never recorded.
 *
 * The aggregation assertions go through `summarizeScan` because that is the
 * only consumer of the payload shape.
 */

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'coding-usage-qoder-'))
  // The official override wins over every root; a stray value in the test
  // environment would scan the developer's real sessions instead of the fixture.
  delete process.env.QODER_CONFIG_DIR
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Epoch ms of a moment in the current visit's local day */
function nowMs(): number {
  return Date.now()
}

function jsonl(...lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

interface LineArgs {
  id: string
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  credits?: number
  tsMs?: number
}

/** One assistant line in the Claude-Code shape Qoder writes */
function assistantLine(a: LineArgs): unknown {
  return {
    type: 'assistant',
    uuid: a.id,
    timestamp: new Date(a.tsMs ?? nowMs()).toISOString(),
    message: {
      id: a.id,
      role: 'assistant',
      model: a.model ?? 'qfmodel',
      usage: {
        input_tokens: a.input ?? 0,
        output_tokens: a.output ?? 0,
        cache_read_input_tokens: a.cacheRead ?? 0,
        cache_creation_input_tokens: 0,
        credits: a.credits ?? 0,
      },
    },
  }
}

async function writeProject(root: string, project: string, file: string, text: string): Promise<void> {
  const dir = join(root, 'projects', project)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), text, 'utf8')
}

describe('readQoderUsage', () => {
  it('returns null when neither build has sessions', async () => {
    expect(await readQoderUsage(home)).toBeNull()
  })

  it('gives each build its own row', async () => {
    await writeProject(
      join(home, '.qoder-cn'),
      'cn-project',
      'cn.jsonl',
      jsonl(assistantLine({ id: 'cn-1', model: 'qfmodel', input: 100, output: 10 })),
    )
    await writeProject(
      join(home, '.qoder'),
      'global-project',
      'global.jsonl',
      jsonl(assistantLine({ id: 'g-1', model: 'lmodel', credits: 4 })),
    )

    const vm = summarizeScan({ daily: await readQoderUsage(home) })
    const domestic = vm.clients.find((c) => c.client === 'qoder')!
    const global = vm.clients.find((c) => c.client === 'qoder-global')!
    expect(domestic.exists).toBe(true)
    expect(domestic.today.tokens).toBe(110)
    expect(domestic.today.credits).toBe(0)
    expect(global.exists).toBe(true)
    // The global build reports no tokens at all; the credits are the usage
    expect(global.today.tokens).toBe(0)
    expect(global.today.credits).toBe(4)
    expect(global.today.messages).toBe(1)
    // The two rows still add up to the day total
    expect(vm.todayTotal.credits).toBe(4)
    expect(vm.other).toBeNull()
  })

  it('counts a zero-token generation that bills credits, and drops one that bills nothing', async () => {
    await writeProject(
      join(home, '.qoder'),
      'p',
      's.jsonl',
      jsonl(
        assistantLine({ id: 'billed', credits: 2.5 }),
        assistantLine({ id: 'unbilled' }),
      ),
    )
    const vm = summarizeScan({ daily: await readQoderUsage(home) })
    const global = vm.clients.find((c) => c.client === 'qoder-global')!
    expect(global.today.messages).toBe(1)
    expect(global.today.credits).toBeCloseTo(2.5, 6)
  })

  it('keeps only the final report of a streamed message', async () => {
    // Qoder appends the same assistant id several times with growing counters
    await writeProject(
      join(home, '.qoder-cn'),
      'p',
      's.jsonl',
      jsonl(
        assistantLine({ id: 'streamed', input: 10, output: 1 }),
        assistantLine({ id: 'streamed', input: 100, output: 20 }),
      ),
    )
    const vm = summarizeScan({ daily: await readQoderUsage(home) })
    const domestic = vm.clients.find((c) => c.client === 'qoder')!
    expect(domestic.today.tokens).toBe(120)
    expect(domestic.today.messages).toBe(1)
  })

  it('does not let two sessions collide on a repeated message id', async () => {
    // Message ids are only promised to be unique inside one session (a per-turn
    // counter would do), and the dedupe must not delete a second session's usage
    // because it happens to reuse an id.
    await writeProject(
      join(home, '.qoder-cn'),
      'p',
      'session-a.jsonl',
      jsonl(assistantLine({ id: 'msg_1', input: 10 })),
    )
    await writeProject(
      join(home, '.qoder-cn'),
      'p',
      'session-b.jsonl',
      jsonl(assistantLine({ id: 'msg_1', input: 20 })),
    )

    const vm = summarizeScan({ daily: await readQoderUsage(home) })
    const domestic = vm.clients.find((c) => c.client === 'qoder')!
    expect(domestic.today.tokens).toBe(30)
    expect(domestic.today.messages).toBe(2)
  })

  it('keeps a BYOK model id off the provider distribution', async () => {
    // `byok:qoder-custom-<uuid>/group%2F<model>` is per-user: taking the first
    // path segment would mint a provider row per BYOK profile.
    await writeProject(
      join(home, '.qoder'),
      'p',
      's.jsonl',
      jsonl(
        assistantLine({
          id: 'byok-1',
          model: 'byok:qoder-custom-5554356c/group%2Fauto-deepseek-v4-1-flash',
          input: 10,
          output: 2,
        }),
      ),
    )

    const payload = (await readQoderUsage(home)) as {
      contributions: Array<{ clients: Array<{ client: string; providerId: string; modelId: string }> }>
    }
    const entry = payload.contributions[0]!.clients[0]!
    expect(entry.client).toBe('qoder-global')
    expect(entry.providerId).toBe('qoder')
    expect(entry.modelId).toBe('auto-deepseek-v4-1-flash')
  })

  it('reads only the requested build when a client filter is passed', async () => {
    // The main process registers one payload per client id so the
    // skip-when-tokscale-covers-it rule can differ per build.
    await writeProject(join(home, '.qoder-cn'), 'p', 'cn.jsonl', jsonl(assistantLine({ id: 'cn', input: 5 })))
    await writeProject(join(home, '.qoder'), 'p', 'g.jsonl', jsonl(assistantLine({ id: 'g', credits: 3 })))

    const onlyGlobal = (await readQoderUsage(home, { client: 'qoder-global' })) as {
      contributions: Array<{ clients: Array<{ client: string }> }>
    }
    expect(onlyGlobal.contributions.flatMap((c) => c.clients).map((e) => e.client)).toEqual(['qoder-global'])

    const onlyCn = (await readQoderUsage(home, { client: 'qoder' })) as {
      contributions: Array<{ clients: Array<{ client: string }> }>
    }
    expect(onlyCn.contributions.flatMap((c) => c.clients).map((e) => e.client)).toEqual(['qoder'])
  })

  it('falls back to the pre-discount figure only when the billed one is absent', async () => {
    // A present-but-unparseable `credits` is format drift, not an absent field:
    // falling back there would bill a discounted request at full price.
    const line = (id: string, usage: Record<string, unknown>): unknown => ({
      type: 'assistant',
      uuid: id,
      timestamp: new Date(nowMs()).toISOString(),
      message: { id, role: 'assistant', model: 'lmodel', usage },
    })
    await writeProject(
      join(home, '.qoder'),
      'p',
      's.jsonl',
      jsonl(
        line('absent', { input_tokens: 0, output_tokens: 0, original_credits: 9 }),
        line('unparseable', { input_tokens: 0, output_tokens: 0, credits: '1.5', original_credits: 9 }),
      ),
    )
    const vm = summarizeScan({ daily: await readQoderUsage(home) })
    const global = vm.clients.find((c) => c.client === 'qoder-global')!
    expect(global.today.messages).toBe(1)
    expect(global.today.credits).toBeCloseTo(9, 6)
  })

  it('attributes a QODER_CONFIG_DIR pointing at the global root to the global row', async () => {
    const globalRoot = join(home, '.qoder')
    await writeProject(globalRoot, 'p', 's.jsonl', jsonl(assistantLine({ id: 'g', credits: 2 })))
    process.env.QODER_CONFIG_DIR = globalRoot
    try {
      const vm = summarizeScan({ daily: await readQoderUsage(home) })
      expect(vm.clients.find((c) => c.client === 'qoder')!.exists).toBe(false)
      expect(vm.clients.find((c) => c.client === 'qoder-global')!.today.credits).toBe(2)
    } finally {
      delete process.env.QODER_CONFIG_DIR
    }
  })

  it('counts a session copied into both build roots once', async () => {
    // A profile migration copies the store; identity is what keeps the
    // generation from being counted twice (paths differ between the roots).
    const text = jsonl(assistantLine({ id: 'migrated-1', input: 70, output: 7, credits: 1 }))
    await writeProject(join(home, '.qoder-cn'), 'p', 's.jsonl', text)
    await writeProject(join(home, '.qoder'), 'p', 's.jsonl', text)

    const vm = summarizeScan({ daily: await readQoderUsage(home) })
    const domestic = vm.clients.find((c) => c.client === 'qoder')!
    const global = vm.clients.find((c) => c.client === 'qoder-global')!
    // The CN root is scanned first, so the copy keeps that row
    expect(domestic.today.tokens).toBe(77)
    expect(global.exists).toBe(false)
    expect(vm.todayTotal.tokens).toBe(77)
    expect(vm.todayTotal.credits).toBe(1)
  })
})
