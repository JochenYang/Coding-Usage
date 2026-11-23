import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCachedAgentUsage } from './startup-cache'

const KEY = 'coding-usage.agent-usage.v1'
const period = (tokens: number) => ({
  tokens,
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  messages: 0,
  credits: 0,
})

// Node test environment has no localStorage; a Map-backed stub is the whole
// surface the loader touches.
beforeEach(() => {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** A cached summary in the shape a build writes it, with fields a load checks */
function cachedSummary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    clients: [
      { client: 'kimi', exists: true, today: period(1), month: period(2), allTime: period(3), models: [] },
    ],
    other: null,
    todayTotal: period(1),
    monthTotal: period(2),
    allTimeTotal: period(3),
    todayByModel: [],
    monthCostByProvider: [],
    monthCostByModel: [],
    dailySeries: [],
    modelDaily: [],
    skippedClients: null,
    scannedAt: 1,
    error: null,
    pricing: null,
    priceCoverage: { monthUnknownTokens: 0, monthFallbackTokens: 0 },
    ...overrides,
  })
}

/**
 * The agent-usage cache is what the overview paints from on launch, before the
 * first scan returns. A cache written by an older build lacks the week windows
 * the overview now shows; those have to load as "unknown", never as zero.
 */
describe('cached agent usage summary', () => {
  it('keeps the week figures a current build cached', () => {
    localStorage.setItem(
      KEY,
      cachedSummary({
        weekTotal: period(10),
        last7Total: period(20),
        last7ByAgent: [{ label: 'Kimi Code', tokens: 20, input: 20, output: 0, cacheRead: 0, costUsd: 0, priced: true }],
        clients: [
          {
            client: 'kimi',
            exists: true,
            today: period(1),
            month: period(2),
            week: period(10),
            last7: period(15),
            allTime: period(3),
            models: [{ model: 'm', today: period(1), month: period(1), week: period(10), allTime: period(3) }],
          },
        ],
      }),
    )

    const vm = loadCachedAgentUsage()

    expect(vm?.weekTotal?.tokens).toBe(10)
    expect(vm?.last7Total?.tokens).toBe(20)
    expect(vm?.last7ByAgent?.[0]?.label).toBe('Kimi Code')
    expect(vm?.clients[0]?.week?.tokens).toBe(10)
    expect(vm?.clients[0]?.last7?.tokens).toBe(15)
    expect(vm?.clients[0]?.models[0]?.week?.tokens).toBe(10)
  })

  it('leaves the week figures absent on a cache written before they existed', () => {
    // A zero in their place would read as "nothing used this week"; absent,
    // the card shows a dash until the next scan fills the column in
    localStorage.setItem(
      KEY,
      cachedSummary({
        clients: [
          {
            client: 'kimi',
            exists: true,
            today: period(1),
            month: period(2),
            week: null,
            last7: null,
            allTime: period(3),
            models: [{ model: 'm', today: period(1), month: period(1), allTime: period(3) }],
          },
        ],
        other: { today: period(1), month: period(1), all: period(1), week: null },
      }),
    )

    const vm = loadCachedAgentUsage()

    expect(vm).not.toBeNull()
    expect('week' in (vm?.clients[0] ?? {})).toBe(false)
    expect('last7' in (vm?.clients[0] ?? {})).toBe(false)
    expect('week' in (vm?.clients[0]?.models[0] ?? {})).toBe(false)
    expect('week' in (vm?.other ?? {})).toBe(false)
    expect(vm?.weekTotal).toBeUndefined()
    expect(vm?.last7Total).toBeUndefined()
    expect(vm?.last7ByAgent).toBeUndefined()
    // Everything the older build did cache still loads
    expect(vm?.clients[0]?.month.tokens).toBe(2)
    expect(vm?.allTimeTotal.tokens).toBe(3)
  })

  it('still rejects a payload that is not a summary', () => {
    localStorage.setItem(KEY, JSON.stringify({ hello: 'world' }))

    expect(loadCachedAgentUsage()).toBeNull()
  })
})
