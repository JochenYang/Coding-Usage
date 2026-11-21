import { describe, expect, it } from 'vitest'
import { hasClientEntries, mergeGraphPayloads } from './tokscale-merge'

/**
 * tokscale-merge is the data-integrity core of the local-usage view: merging
 * per-client payloads must not double count or lose numbers. These tests lock
 * the merge arithmetic (per-day totals and tokenBreakdown are summed and every
 * summary field is recomputed from the merged set) and the skip rule callers
 * rely on (hasClientEntries detects a client a tokscale scan already reports).
 */

function contribution(date: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date,
    totals: { tokens: 0, cost: 0 },
    tokenBreakdown: {},
    clients: [],
    intensity: 0,
    activeTimeMs: 0,
    ...overrides,
  }
}

describe('mergeGraphPayloads', () => {
  it('sums the same day across payloads and recomputes totals and tokenBreakdown', () => {
    const a = {
      meta: { source: 'a' },
      contributions: [
        contribution('2026-01-01', {
          totals: { tokens: 100, cost: 1.5 },
          tokenBreakdown: { input: 60, output: 40 },
          clients: [{ client: 'codex', modelId: 'gpt-5.2', tokens: 100, cost: 1.5 }],
          intensity: 2,
          activeTimeMs: 1_000,
        }),
      ],
    }
    const b = {
      meta: { source: 'b' },
      contributions: [
        contribution('2026-01-01', {
          totals: { tokens: 250, cost: 3 },
          tokenBreakdown: { input: 120, output: 130 },
          clients: [{ client: 'claude', modelId: 'claude-opus-4.6', tokens: 250, cost: 3 }],
          intensity: 3,
          activeTimeMs: 2_500,
        }),
      ],
    }
    const merged = mergeGraphPayloads([a, b]) as {
      meta: unknown
      summary: Record<string, unknown>
      years: Array<Record<string, unknown>>
      contributions: Array<Record<string, unknown>>
    }

    // meta comes from the first payload
    expect(merged.meta).toEqual({ source: 'a' })
    // One merged day, both halves present
    expect(merged.contributions).toHaveLength(1)
    expect(merged.contributions[0]?.totals).toEqual({ tokens: 350, cost: 4.5 })
    expect(merged.contributions[0]?.tokenBreakdown).toEqual({ input: 180, output: 170 })
    expect(merged.contributions[0]?.intensity).toBe(5)
    expect(merged.contributions[0]?.activeTimeMs).toBe(3_500)
    expect(merged.contributions[0]?.clients).toHaveLength(2)

    // Summary is recomputed from the merged days, not copied from either payload
    expect(merged.summary).toEqual({
      totalTokens: 350,
      totalCost: 4.5,
      totalDays: 1,
      activeDays: 1,
      averagePerDay: 4.5,
      maxCostInSingleDay: 4.5,
      clients: ['claude', 'codex'],
      models: ['claude-opus-4.6', 'gpt-5.2'],
    })

    // The year row recomputes the same totals
    expect(merged.years).toEqual([
      { year: '2026', totalTokens: 350, totalCost: 4.5, start: '2026-01-01', end: '2026-01-01' },
    ])
  })

  it('keeps distinct days sorted and spans the year row across them', () => {
    const a = { contributions: [contribution('2026-01-05', { totals: { tokens: 10, cost: 1 } })] }
    const b = { contributions: [contribution('2026-01-02', { totals: { tokens: 5, cost: 2 } })] }
    const c = { contributions: [contribution('2025-12-31', { totals: { tokens: 1, cost: 0.5 } })] }
    const merged = mergeGraphPayloads([a, b, c]) as {
      contributions: Array<{ date: string }>
      years: Array<Record<string, unknown>>
      summary: Record<string, unknown>
    }

    // Payload order must not leak into the output order
    expect(merged.contributions.map((c) => c.date)).toEqual(['2025-12-31', '2026-01-02', '2026-01-05'])
    expect(merged.summary).toMatchObject({ totalTokens: 16, totalCost: 3.5, totalDays: 3, activeDays: 3 })
    expect(merged.years).toEqual([
      { year: '2025', totalTokens: 1, totalCost: 0.5, start: '2025-12-31', end: '2025-12-31' },
      { year: '2026', totalTokens: 15, totalCost: 3, start: '2026-01-02', end: '2026-01-05' },
    ])
  })

  it('deduplicates client and model names in the summary sets', () => {
    const a = {
      contributions: [
        contribution('2026-01-01', {
          clients: [
            { client: 'codex', modelId: 'gpt-5.2' },
            { client: 'claude', modelId: 'claude-opus-4.6' },
          ],
        }),
      ],
    }
    const b = {
      contributions: [
        contribution('2026-01-02', {
          clients: [{ client: 'codex', modelId: 'gpt-5.2' }],
        }),
      ],
    }
    const merged = mergeGraphPayloads([a, b]) as { summary: Record<string, unknown> }
    expect(merged.summary).toMatchObject({ clients: ['claude', 'codex'], models: ['claude-opus-4.6', 'gpt-5.2'] })
  })

  it('ignores malformed payloads, non-numeric fields and shapeless contributions', () => {
    const merged = mergeGraphPayloads([
      null,
      'not-an-object',
      { contributions: 'not-an-array' },
      { contributions: [null, 42, { totals: { tokens: 'NaN-string', cost: 7 } }] },
      { contributions: [contribution('2026-01-01', { totals: { tokens: 3, cost: 1, junk: 'text' }, intensity: 'x' })] },
    ]) as {
      meta: unknown
      contributions: Array<Record<string, unknown>>
      summary: Record<string, unknown>
    }

    expect(merged.contributions).toHaveLength(1)
    // Non-finite values sum as zero instead of poisoning the day
    expect(merged.contributions[0]?.totals).toEqual({ tokens: 3, cost: 1 })
    expect(merged.contributions[0]?.intensity).toBe(0)
    expect(merged.summary).toMatchObject({ totalTokens: 3, totalCost: 1, totalDays: 1 })
    // No payload carried meta
    expect(merged.meta).toBeUndefined()
  })

  it('handles empty and absent contributions arrays', () => {
    const merged = mergeGraphPayloads([{ meta: { source: 'empty' }, contributions: [] }, {}]) as {
      meta: unknown
      summary: Record<string, unknown>
      years: unknown[]
      contributions: unknown[]
    }
    expect(merged.meta).toEqual({ source: 'empty' })
    expect(merged.contributions).toEqual([])
    expect(merged.years).toEqual([])
    expect(merged.summary).toEqual({
      totalTokens: 0,
      totalCost: 0,
      totalDays: 0,
      activeDays: 0,
      averagePerDay: 0,
      maxCostInSingleDay: 0,
      clients: [],
      models: [],
    })
  })

  it('keeps two same-client payloads merged side by side when the caller opts in', () => {
    // mergeAlways callers (main.ts) pass a tokscale payload and a local payload
    // that may BOTH report the client (disjoint stores, e.g. Trae CN local vs
    // international cloud sync). The merge itself must simply add both halves.
    const tokscale = {
      contributions: [
        contribution('2026-01-01', {
          totals: { tokens: 100, cost: 1 },
          clients: [{ client: 'trae', tokens: 100, cost: 1 }],
        }),
      ],
    }
    const local = {
      contributions: [
        contribution('2026-01-01', {
          totals: { tokens: 55, cost: 0.5 },
          clients: [{ client: 'trae', tokens: 55, cost: 0.5 }],
        }),
      ],
    }
    const merged = mergeGraphPayloads([tokscale, local]) as {
      contributions: Array<Record<string, unknown>>
      summary: Record<string, unknown>
    }
    expect(merged.contributions[0]?.totals).toEqual({ tokens: 155, cost: 1.5 })
    expect(merged.summary).toMatchObject({ totalTokens: 155, totalCost: 1.5 })
  })
})

describe('hasClientEntries', () => {
  it('finds the client in any contribution', () => {
    const payload = {
      contributions: [
        contribution('2026-01-01', { clients: [{ client: 'codex' }] }),
        contribution('2026-01-02', { clients: [{ client: 'droid' }] }),
      ],
    }
    expect(hasClientEntries(payload, 'codex')).toBe(true)
    expect(hasClientEntries(payload, 'droid')).toBe(true)
    expect(hasClientEntries(payload, 'qoder')).toBe(false)
  })

  it('is false for absent, malformed and empty shapes', () => {
    expect(hasClientEntries(undefined, 'codex')).toBe(false)
    expect(hasClientEntries(null, 'codex')).toBe(false)
    expect(hasClientEntries('string', 'codex')).toBe(false)
    expect(hasClientEntries({}, 'codex')).toBe(false)
    expect(hasClientEntries({ contributions: 'not-an-array' }, 'codex')).toBe(false)
    expect(hasClientEntries({ contributions: [null, { clients: null }, { clients: [] }, {}] }, 'codex')).toBe(false)
    // Only an exact client-id match counts
    expect(hasClientEntries({ contributions: [contribution('2026-01-01', { clients: [{ client: 42 }] })] }, 'codex')).toBe(false)
  })

  it('drives the skip rule the caller composes: dedup by default, mergeAlways unconditionally', () => {
    // Mirrors electron/main.ts withLocalAgents: a local payload is dropped when
    // tokscale already reports the client, unless the entry opts out via
    // mergeAlways (disjoint stores that can never overlap the scan).
    const withLocalAgents = (payload: unknown, localAgents: Array<{ client: string; payload: unknown; mergeAlways?: boolean }>): unknown => {
      const missing = localAgents.filter((entry) => entry.mergeAlways || !hasClientEntries(payload, entry.client))
      return missing.length === 0 ? payload : mergeGraphPayloads([payload, ...missing.map((e) => e.payload)])
    }

    const scan = {
      contributions: [
        contribution('2026-01-01', {
          totals: { tokens: 100, cost: 1 },
          clients: [{ client: 'codex', tokens: 100, cost: 1 }],
        }),
      ],
    }
    const localCodex = {
      contributions: [
        contribution('2026-01-01', {
          totals: { tokens: 500, cost: 5 },
          clients: [{ client: 'codex', tokens: 500, cost: 5 }],
        }),
      ],
    }
    const localTrae = {
      contributions: [
        contribution('2026-01-01', {
          totals: { tokens: 55, cost: 0.5 },
          clients: [{ client: 'trae', tokens: 55, cost: 0.5 }],
        }),
      ],
    }

    // tokscale already reports codex: the local codex payload is dropped so the
    // day is NOT double counted
    const deduped = withLocalAgents(scan, [
      { client: 'codex', payload: localCodex },
      { client: 'trae', payload: localTrae },
    ]) as { contributions: Array<Record<string, unknown>>; summary: Record<string, unknown> }
    expect(deduped.contributions[0]?.totals).toEqual({ tokens: 155, cost: 1.5 })
    expect(deduped.summary).toMatchObject({ totalTokens: 155, totalCost: 1.5 })

    // A mergeAlways entry is merged even when the scan reports the same client
    const withMergeAlways = withLocalAgents(scan, [
      { client: 'codex', payload: localCodex, mergeAlways: true },
    ]) as { summary: Record<string, unknown> }
    expect(withMergeAlways.summary).toMatchObject({ totalTokens: 600, totalCost: 6 })

    // Nothing to merge: the original payload comes back through untouched
    const untouched = withLocalAgents(scan, [
      { client: 'codex', payload: localCodex },
    ])
    expect(untouched).toEqual(scan)
  })
})
