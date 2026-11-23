import { describe, expect, it } from 'vitest'
import { summarizeScan } from './agent-usage'

/**
 * Regression cover for the agent × model cross-cut.
 *
 * These assertions pin the parts of `summarizeScan` that are easy to break
 * silently: the today/month two-pass feeding, the subset invariant between a
 * client's model rows and its own totals, and the ordering the card relies on.
 * A mistake here does not crash — it just shows a plausible-looking number
 * that is wrong, which is exactly what no UI test would catch.
 */

/** Local calendar day, mirroring the module's own `todayKey()` bucketing */
function localDay(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface Entry {
  client?: string
  modelId?: string
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  cost?: number
  messages?: number
  priced?: boolean
}

/** One `tokscale graph` contribution for a day, summing its own entries */
function day(date: string, entries: Entry[]): unknown {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0
  let messages = 0
  for (const e of entries) {
    sum.input += e.tokens?.input ?? 0
    sum.output += e.tokens?.output ?? 0
    sum.cacheRead += e.tokens?.cacheRead ?? 0
    sum.cacheWrite += e.tokens?.cacheWrite ?? 0
    cost += e.cost ?? 0
    messages += e.messages ?? 0
  }
  return {
    date,
    totals: { tokens: sum.input + sum.output + sum.cacheRead + sum.cacheWrite, cost, messages },
    tokenBreakdown: sum,
    clients: entries,
    intensity: 0,
    activeTimeMs: 0,
  }
}

const scan = (contributions: unknown[]) => summarizeScan({ daily: { contributions } })

describe('agent × model cross-cut', () => {
  it('feeds a today entry into both the today and the month bucket', () => {
    const vm = scan([
      day(localDay(0), [
        { client: 'pi', modelId: 'm', tokens: { input: 10, output: 5 }, messages: 1 },
      ]),
    ])
    const row = vm.clients.find((c) => c.client === 'pi')!
    expect(row.models).toHaveLength(1)
    const model = row.models[0]!
    // Today sits inside the current month, so all three agree here.
    expect(model.today.tokens).toBe(15)
    expect(model.month.tokens).toBe(15)
    expect(model.allTime.tokens).toBe(15)
    expect(model.today.messages).toBe(1)
  })

  it('keeps an older in-month day out of today but in month and all-time', () => {
    // Day 1 is inside the current month unless today IS the 1st, in which case
    // "yesterday" belongs to the previous month and month must stay 0.
    const yesterday = localDay(1)
    const firstOfMonth = new Date().getDate() === 1
    const vm = scan([
      day(yesterday, [{ client: 'pi', modelId: 'm', tokens: { input: 7 }, messages: 1 }]),
    ])
    const model = vm.clients.find((c) => c.client === 'pi')!.models[0]!
    expect(model.today.tokens).toBe(0)
    expect(model.allTime.tokens).toBe(7)
    expect(model.month.tokens).toBe(firstOfMonth ? 0 : 7)
  })

  it('excludes a previous-month day from today and month', () => {
    const d = new Date()
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 15)
    const pad = (n: number): string => `${n}`.padStart(2, '0')
    const date = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-15`
    const vm = scan([day(date, [{ client: 'pi', modelId: 'm', tokens: { input: 9 } }])])
    const model = vm.clients.find((c) => c.client === 'pi')!.models[0]!
    expect(model.today.tokens).toBe(0)
    expect(model.month.tokens).toBe(0)
    expect(model.allTime.tokens).toBe(9)
  })

  it('never lets a client model row exceed that client\'s own period totals', () => {
    const vm = scan([
      day(localDay(0), [
        { client: 'pi', modelId: 'a', tokens: { input: 10, output: 1 } },
        // No modelId: counts toward the client, produces no model row.
        { client: 'pi', tokens: { input: 100, output: 100 } },
        { client: 'opencode', modelId: 'b', tokens: { input: 3 } },
      ]),
    ])
    for (const client of vm.clients.filter((c) => c.exists)) {
      const sum = (pick: 'today' | 'month' | 'allTime'): number =>
        client.models.reduce((s, m) => s + m[pick].tokens, 0)
      expect(sum('allTime')).toBeLessThanOrEqual(client.allTime.tokens)
      expect(sum('today')).toBeLessThanOrEqual(client.today.tokens)
      expect(sum('month')).toBeLessThanOrEqual(client.month.tokens)
    }
    // And the placeholder entry really is excluded from the model rows.
    const pi = vm.clients.find((c) => c.client === 'pi')!
    expect(pi.models).toHaveLength(1)
    expect(pi.allTime.tokens).toBe(211)
  })

  it('sorts models by all-time tokens descending and sums to the cross-cut total', () => {
    const vm = scan([
      day(localDay(0), [
        { client: 'pi', modelId: 'small', tokens: { input: 1 } },
        { client: 'pi', modelId: 'big', tokens: { input: 1000 } },
        { client: 'pi', modelId: 'mid', tokens: { input: 50 } },
      ]),
    ])
    const pi = vm.clients.find((c) => c.client === 'pi')!
    expect(pi.models.map((m) => m.model)).toEqual(['big', 'mid', 'small'])
    const crossTotal = vm.clients.reduce((s, c) => s + c.models.reduce((t, m) => t + m.allTime.tokens, 0), 0)
    const flatTotal = vm.modelDaily.reduce((s, r) => s + r.tokens, 0)
    expect(crossTotal).toBe(flatTotal)
  })

  it('routes an entry with no client id to the other bucket, never to a model row', () => {
    const vm = scan([
      day(localDay(0), [{ modelId: 'orphan', tokens: { input: 5 }, messages: 1 }]),
    ])
    expect(vm.clients.every((c) => c.models.length === 0)).toBe(true)
    expect(vm.other).not.toBeNull()
    expect(vm.other!.all.tokens).toBeGreaterThan(0)
  })

  it('every client exposes a models array, even with no data at all', () => {
    const vm = summarizeScan(null)
    for (const client of vm.clients) expect(Array.isArray(client.models)).toBe(true)
  })

  it('keeps the four breakdown parts summing to the headline token figure', () => {
    // cacheWrite is the part that used to be folded into `tokens` only, which
    // made the printed breakdown add up to less than the row's own total.
    const vm = scan([
      day(localDay(0), [
        {
          client: 'pi',
          modelId: 'm',
          tokens: { input: 10, output: 4, cacheRead: 6, cacheWrite: 3 },
          messages: 1,
        },
      ]),
    ])
    const row = vm.clients.find((c) => c.client === 'pi')!
    for (const p of [row.today, row.month, row.allTime, row.models[0]!.allTime]) {
      expect(p.input + p.output + p.cacheRead + p.cacheWrite).toBe(p.tokens)
      expect(p.cacheWrite).toBe(3)
    }
    expect(row.allTime.tokens).toBe(23)
    // The day total carries the same tier, so totals stay reconciled.
    expect(vm.todayTotal.cacheWrite).toBe(3)
    expect(
      vm.todayTotal.input + vm.todayTotal.output + vm.todayTotal.cacheRead + vm.todayTotal.cacheWrite,
    ).toBe(vm.todayTotal.tokens)
  })

  it('defaults cacheWrite to zero when the scan omits the field', () => {
    const vm = scan([day(localDay(0), [{ client: 'pi', modelId: 'm', tokens: { input: 5 } }])])
    const row = vm.clients.find((c) => c.client === 'pi')!
    expect(row.today.cacheWrite).toBe(0)
    expect(Number.isNaN(row.today.cacheWrite)).toBe(false)
  })
})

describe('price coverage', () => {
  const pricedScan = (entries: Entry[]): ReturnType<typeof summarizeScan> =>
    summarizeScan({
      pricing: { source: 'models.dev', fetchedAt: 1, modelCount: 2 },
      daily: { contributions: [day(localDay(0), entries)] },
    })

  it('reports tokens priced outside the official catalogue', () => {
    const vm = pricedScan([
      { client: 'pi', modelId: 'unknown', tokens: { input: 100 }, cost: 1, priced: false },
      { client: 'pi', modelId: 'known', tokens: { input: 50 }, cost: 2, priced: true },
    ])
    expect(vm.priceCoverage.monthFallbackTokens).toBe(100)
    expect(vm.priceCoverage.monthUnknownTokens).toBe(0)
    expect(vm.pricing).toMatchObject({ source: 'models.dev', modelCount: 2 })
  })

  it('counts cost-less tokens as unknown so the total reads as a floor', () => {
    const vm = pricedScan([{ client: 'pi', modelId: 'unknown', tokens: { input: 100 }, cost: 0, priced: false }])
    expect(vm.priceCoverage.monthFallbackTokens).toBe(100)
    expect(vm.priceCoverage.monthUnknownTokens).toBe(100)
  })

  it('does not treat a catalog-priced free model as unknown', () => {
    const vm = pricedScan([{ client: 'pi', modelId: 'free-model', tokens: { input: 100 }, cost: 0, priced: true }])
    expect(vm.priceCoverage.monthFallbackTokens).toBe(0)
    expect(vm.priceCoverage.monthUnknownTokens).toBe(0)
  })
})

describe('week windows', () => {
  /** Local calendar day key `days` away from `base` (negative = earlier) */
  function shiftKey(base: string, days: number): string {
    const [y, m, d] = base.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    date.setDate(date.getDate() + days)
    const pad = (n: number): string => `${n}`.padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  /** Monday of the week today falls in — worked out here, apart from the module */
  function mondayKey(): string {
    const sinceMonday = (new Date().getDay() + 6) % 7
    return shiftKey(localDay(0), -sinceMonday)
  }

  const tokens = (input: number) => ({ input, output: 0 })

  it('counts Monday through today as this week, and nothing from before Monday', () => {
    const monday = mondayKey()
    const vm = scan([
      day(shiftKey(monday, -1), [{ client: 'kimi', modelId: 'm', tokens: tokens(1000) }]),
      day(monday, [{ client: 'kimi', modelId: 'm', tokens: tokens(100) }]),
      day(localDay(0), [{ client: 'kimi', modelId: 'm', tokens: tokens(50) }]),
    ])

    const kimi = vm.clients.find((c) => c.client === 'kimi')
    // On a Monday both dated entries fall on the same day; the sum is the same
    expect(kimi?.week?.tokens).toBe(150)
    expect(kimi?.models[0]?.week?.tokens).toBe(150)
    expect(vm.weekTotal?.tokens).toBe(150)
    // The day before Monday still counts toward the cumulative figure
    expect(kimi?.allTime.tokens).toBe(1150)
  })

  it('takes the rolling week as today plus the six days before it, by agent', () => {
    const vm = scan([
      day(localDay(7), [{ client: 'kimi', modelId: 'm', tokens: tokens(700) }]),
      day(localDay(6), [{ client: 'kimi', modelId: 'm', tokens: tokens(60) }]),
      day(localDay(0), [
        { client: 'opencode', modelId: 'm', tokens: tokens(10) },
        { client: 'kimi', modelId: 'm', tokens: tokens(5) },
      ]),
    ])

    expect(vm.last7Total?.tokens).toBe(75)
    // One slice per agent, named the way the usage table names its rows; an
    // entry without a router id is not left out, so the slices add up to the total
    expect(vm.last7ByAgent).toEqual([
      expect.objectContaining({ label: 'Kimi Code', tokens: 65 }),
      expect.objectContaining({ label: 'OpenCode', tokens: 10 }),
    ])
    expect(vm.last7ByAgent?.reduce((sum, s) => sum + s.tokens, 0)).toBe(75)
    // Each agent carries its own figure for the window, which is what the
    // overview ranks by
    const kimi = vm.clients.find((c) => c.client === 'kimi')
    expect(kimi?.last7?.tokens).toBe(65)
    expect(vm.clients.find((c) => c.client === 'opencode')?.last7?.tokens).toBe(10)
    // The day a week ago counts toward the cumulative figure only
    expect(kimi?.allTime.tokens).toBe(765)
  })

  it('leaves a key from the future out of both week windows', () => {
    const vm = scan([day(localDay(-1), [{ client: 'kimi', modelId: 'm', tokens: tokens(9) }])])

    expect(vm.weekTotal?.tokens).toBe(0)
    expect(vm.last7Total?.tokens).toBe(0)
  })

  it('routes unclassified rows of this week into the other bucket', () => {
    const vm = scan([day(localDay(0), [{ modelId: 'm', tokens: tokens(30) }])])

    expect(vm.other?.week?.tokens).toBe(30)
    expect(vm.weekTotal?.tokens).toBe(30)
  })
})
