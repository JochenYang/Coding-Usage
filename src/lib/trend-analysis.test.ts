import { describe, expect, it } from 'vitest'
import type { DayPointVM, ModelDailySeriesVM } from './agent-usage'
import {
  bucketize,
  bucketWidthDays,
  buildCumulative,
  buildModelRows,
  computeTotals,
  densifySeries,
  filterByModels,
  modelSlots,
  selectTrendSource,
  sliceRange,
} from './trend-analysis'

const DAY_MS = 86_400_000

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10)
}

function day(dayKey: string, output = 1): DayPointVM {
  return {
    day: dayKey,
    label: dayKey.slice(5),
    value: output,
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    activeTimeMs: 1000,
    messages: 1,
  }
}

/** A contiguous run of `days` calendar days, one entry each */
function denseSeries(from: string, days: number, output = 1): DayPointVM[] {
  return Array.from({ length: days }, (_, i) => day(addDays(from, i), output))
}

function modelRow(
  model: string,
  output: number[],
  messages: number[],
  total: number[],
  input?: number[],
): ModelDailySeriesVM {
  return {
    model,
    tokens: total.reduce((s, v) => s + v, 0),
    // Defaults to `total - output` (input plus cache); pass `input` explicitly
    // when a test needs the no-cache口径 to be exact.
    input: input ?? total.map((v, i) => Math.max(0, v - (output[i] ?? 0))),
    output,
    messages,
    total,
  }
}

describe('densifySeries', () => {
  it('inserts zero rows for days the scan never reported', () => {
    const sparse = [day('2026-01-01', 10), day('2026-01-05', 20)]
    const models = [modelRow('glm', [1, 2], [1, 1], [10, 20])]

    const { points, models: dense } = densifySeries(sparse, models)

    expect(points.map((p) => p.day)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ])
    expect(points.map((p) => p.value)).toEqual([10, 0, 0, 0, 20])
    expect(points[1]!.messages).toBe(0)
    expect(points[1]!.label).toBe('01-02')
    // The model rows must be expanded by the same insertion map, or every
    // per-model figure shifts onto the wrong day.
    expect(dense[0]!.total).toEqual([10, 0, 0, 0, 20])
    expect(dense[0]!.output).toEqual([1, 0, 0, 0, 2])
    expect(dense[0]!.tokens).toBe(30)
  })

  it('leaves a series without day keys untouched instead of inventing dates', () => {
    const legacy: DayPointVM[] = [
      { label: '01-01', value: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, activeTimeMs: 0, messages: 0 },
      { label: '01-09', value: 2, input: 2, output: 0, cacheRead: 0, cacheWrite: 0, activeTimeMs: 0, messages: 0 },
    ]

    const { points } = densifySeries(legacy)

    expect(points).toHaveLength(2)
  })

  it('returns the rows untouched when the series is already dense', () => {
    const dense = denseSeries('2026-01-01', 5)

    const { points } = densifySeries(dense)

    expect(points).toHaveLength(5)
    expect(points[0]).toBe(dense[0])
  })

  it('refuses a series that is not strictly ascending', () => {
    // The span guard must not be what rejects this: total would be 5 (> 3 rows),
    // so only the ascending check can catch it.
    const outOfOrder = [day('2026-01-01'), day('2026-01-10'), day('2026-01-05')]

    const { points } = densifySeries(outOfOrder)

    expect(points.map((p) => p.day)).toEqual(['2026-01-01', '2026-01-10', '2026-01-05'])
  })

  it('refuses a calendar-invalid day instead of letting Date.parse normalise it', () => {
    // Date.parse("2026-02-30T00:00:00Z") resolves to 2026-03-02, so a shape-only
    // check would drop the 02-30 contribution and invent a 03-02 day in its
    // place — the same silent misalignment W2 exists to remove.
    const bogus = [day('2026-02-28', 5), day('2026-02-30', 9)]

    const { points } = densifySeries(bogus)

    expect(points.map((p) => p.day)).toEqual(['2026-02-28', '2026-02-30'])
    expect(points.reduce((s, p) => s + p.value, 0)).toBe(14)
  })

  it('refuses a span beyond the grid budget instead of allocating it', () => {
    // Unbounded, this would build ~2.9M rows times every model row during render.
    const absurd = [day('2026-01-01', 5), day('9999-12-31', 7)]

    const { points } = densifySeries(absurd)

    expect(points).toHaveLength(2)
    expect(points.reduce((s, p) => s + p.value, 0)).toBe(12)
  })

  it('crosses a leap day without drifting', () => {
    const sparse = [day('2028-02-27', 1), day('2028-03-02', 1)]

    const { points } = densifySeries(sparse)

    expect(points.map((p) => p.day)).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-02',
    ])
  })

  it('crosses a year boundary', () => {
    const sparse = [day('2025-12-30', 1), day('2026-01-02', 1)]

    const { points } = densifySeries(sparse)

    expect(points.map((p) => p.day)).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])
  })

  it('does not mutate the caller rows or their arrays', () => {
    const sparse = [day('2026-01-01'), day('2026-01-03')]
    const models = [modelRow('glm', [1, 1], [1, 1], [1, 1])]

    densifySeries(sparse, models)

    expect(sparse).toHaveLength(2)
    expect(models[0]!.total).toEqual([1, 1])
  })
})

describe('range semantics on a sparse scan', () => {
  // 20 recorded days spread 10 days apart: a real 191-day span, 171 idle days.
  const sparse = Array.from({ length: 20 }, (_, i) => day(addDays('2026-01-01', i * 10), 100))

  it('makes "last 30 days" mean 30 calendar days, not the last 30 recorded days', () => {
    const source = selectTrendSource({ scan: sparse, archive: [], snapshots: [] })
    const windowed = sliceRange(source.points, 30)

    expect(windowed).toHaveLength(30)
    expect(windowed[0]!.day).toBe(addDays('2026-01-01', 190 - 29))
    // Only the 170/180/190-offset days had usage; the other 27 days are zeros.
    expect(windowed.reduce((s, p) => s + p.value, 0)).toBe(300)
  })

  it('keeps every column the same calendar width on a long span', () => {
    const source = selectTrendSource({ scan: sparse, archive: [], snapshots: [] })
    const buckets = bucketize(source.points)

    expect(buckets.length).toBeLessThanOrEqual(30)
    // 191 days -> 7-day columns (28 of them), not 7-row columns spanning 98 days.
    expect(bucketWidthDays(source.points.length)).toBe(7)
    expect(buckets[0]!.label).toBe('01-01')
    expect(buckets[1]!.label).toBe(addDays('2026-01-01', 7).slice(5))
  })
})

describe('bucketWidthDays', () => {
  it('picks the finest width whose column count stays readable', () => {
    expect(bucketWidthDays(7)).toBe(1)
    expect(bucketWidthDays(30)).toBe(1)
    expect(bucketWidthDays(31)).toBe(7)
    expect(bucketWidthDays(90)).toBe(7)
    expect(bucketWidthDays(388)).toBe(14)
    expect(bucketWidthDays(4000)).toBe(180)
  })
})

describe('bucketize', () => {
  it('keeps daily columns for a 30-day window', () => {
    const buckets = bucketize(denseSeries('2026-01-01', 30))

    expect(buckets).toHaveLength(30)
    expect(buckets[0]!.rangeLabel).toBe('01-01')
  })

  it('steps up to weeks for a quarter and spans real dates', () => {
    const buckets = bucketize(denseSeries('2026-01-01', 90))

    expect(buckets).toHaveLength(13)
    expect(buckets[0]!.label).toBe('01-01')
    expect(buckets[0]!.rangeLabel).toBe('01-01–01-07')
    expect(buckets[1]!.label).toBe('01-08')
  })

  it('steps up to fortnights for a multi-year span', () => {
    const buckets = bucketize(denseSeries('2025-01-01', 388))

    expect(buckets).toHaveLength(Math.ceil(388 / 14))
    expect(buckets[1]!.label).toBe(addDays('2025-01-01', 14).slice(5))
  })

  it('sums each bucket without dropping the trailing partial one', () => {
    const buckets = bucketize(denseSeries('2026-01-01', 10, 3))

    expect(buckets).toHaveLength(10)
    expect(buckets.reduce((s, b) => s + b.total, 0)).toBe(30)
  })

  it('does not quote a range for a single-day bucket', () => {
    // 36 days -> 6 columns of 7, the last holding one day; "02-05–02-05" would
    // read as a real span.
    const buckets = bucketize(denseSeries('2026-01-01', 36))

    expect(buckets).toHaveLength(6)
    expect(buckets[5]!.rangeLabel).toBe(buckets[5]!.label)
  })

  it('flags a short trailing bucket as partial', () => {
    // 36 days -> 6 columns of 7, the last holding a single day.
    const buckets = bucketize(denseSeries('2026-01-01', 36))

    expect(buckets).toHaveLength(6)
    expect(buckets.slice(0, 5).every((b) => !b.partial)).toBe(true)
    expect(buckets[5]!.partial).toBe(true)
  })

  it('marks nothing partial when the span divides evenly', () => {
    // 91 days -> 13 columns of exactly 7.
    const buckets = bucketize(denseSeries('2026-01-01', 91))

    expect(buckets).toHaveLength(13)
    expect(buckets.every((b) => !b.partial)).toBe(true)
  })
})

describe('computeTotals', () => {
  const points = denseSeries('2026-01-01', 3).map((p) => ({
    ...p,
    input: 10,
    output: 5,
    cacheRead: 20,
    cacheWrite: 0,
    value: 35,
  }))

  it('keeps the headline total and the hit rate self-consistent per display mode', () => {
    const buckets = bucketize(points)
    const all = computeTotals(buckets, 'all')
    const noCache = computeTotals(buckets, 'no-cache')

    expect(all.tokens).toBe(105)
    expect(noCache.tokens).toBe(45)
    // Cache hit rate describes the prompt side, so it does not follow the
    // display mode — the split itself is unchanged.
    expect(all.hitRatePct).toBeCloseTo((60 / 90) * 100)
    expect(noCache.hitRatePct).toBeCloseTo((60 / 90) * 100)
  })
})
describe('filterByModels', () => {
  it('recomputes the day series from the selected models only', () => {
    const points = denseSeries('2026-01-01', 3)
    const models = [
      modelRow('a', [1, 2, 3], [1, 1, 1], [10, 20, 30]),
      modelRow('b', [4, 5, 6], [2, 2, 2], [40, 50, 60]),
    ]

    const only = filterByModels(points, models, ['b'])

    expect(only.map((p) => p.output)).toEqual([4, 5, 6])
    expect(only.map((p) => p.messages)).toEqual([2, 2, 2])
    expect(only.map((p) => p.value)).toEqual([40, 50, 60])
    // Input is derived and the cache split collapses: the scan reports the
    // breakdown per day, never per model.
    expect(only.map((p) => p.input)).toEqual([36, 45, 54])
    expect(only.every((p) => p.cacheRead === 0 && p.cacheWrite === 0)).toBe(true)
    // The day identity survives the recomputation, so the axis stays right.
    expect(only.map((p) => p.day)).toEqual(points.map((p) => p.day))
  })

  it('returns the series untouched when nothing is selected', () => {
    const points = denseSeries('2026-01-01', 3)

    expect(filterByModels(points, [], [])).toEqual(points)
  })

  it('returns nothing when the selection matches no model', () => {
    const points = denseSeries('2026-01-01', 3)

    expect(filterByModels(points, [], ['ghost'])).toEqual([])
  })
})

describe('buildModelRows', () => {
  it('attributes each day of active time to the models used that day', () => {
    const points = denseSeries('2026-01-01', 3)
    points[2] = { ...points[2]!, activeTimeMs: 10_000, messages: 2 }
    const models = [
      modelRow('a', [0, 0, 100], [0, 0, 1], [0, 0, 1]),
      modelRow('b', [0, 0, 50], [0, 0, 1], [0, 0, 1]),
    ]

    const rows = buildModelRows(
      models,
      points.length,
      points.map((p) => p.activeTimeMs),
      points.map((p) => p.messages),
      new Map(),
    )

    const a = rows.find((r) => r.model === 'a')!
    expect(a.activeTimeMs).toBe(5000)
    expect(a.tokPerSec).toBe(20)
  })

  it('keeps every model row exactly as long as the day series', () => {
    const scan = [day('2026-01-01', 5), day('2026-01-31', 7)]
    const models = [modelRow('glm', [1, 2], [1, 1], [5, 7])]

    const source = selectTrendSource({ scan, models, archive: [], snapshots: [] })

    expect(source.points).toHaveLength(31)
    for (const row of source.models) {
      expect(row.total).toHaveLength(source.points.length)
      expect(row.output).toHaveLength(source.points.length)
      expect(row.messages).toHaveLength(source.points.length)
    }
    // The two recorded days land on their real dates, not at the array's head.
    expect(source.models[0]!.total[0]).toBe(5)
    expect(source.models[0]!.total[30]).toBe(7)
  })
})

describe('selectTrendSource', () => {
  const models = [modelRow('glm', [1, 2], [1, 1], [5, 7])]

  it('uses the scan series and reports model detail for it', () => {
    const scan = [day('2026-01-01', 5), day('2026-01-04', 7)]

    const source = selectTrendSource({ scan, models, archive: [], snapshots: [] })

    expect(source.kind).toBe('scan')
    expect(source.hasModelDetail).toBe(true)
    expect(source.points).toHaveLength(4)
    expect(source.models[0]!.total).toEqual([5, 0, 0, 7])
  })

  it('never claims model detail for an archive fallback', () => {
    // The W2 regression: one scanned day is not a series, so the page falls
    // back to the local archive — and the model rows describe the scan, not
    // the archive. Offering them would plot the model's first day under the
    // window's last label.
    const scan = [day('2026-10-10')]
    const archive = Array.from({ length: 90 }, (_, i) => ({ label: `d${i}`, value: 1 }))

    // A scan-length model row: it WOULD describe the scan, so the only reason
    // it can be absent from the result is that the archive branch never offers
    // model detail. A shorter fixture would pass even if the branch returned
    // rows and a length check happened to drop them.
    const source = selectTrendSource({
      scan,
      models: [modelRow('glm', [1], [1], [1])],
      archive,
      snapshots: [],
    })

    expect(source.kind).toBe('archive')
    expect(source.hasModelDetail).toBe(false)
    expect(source.models).toEqual([])
    expect(source.points).toHaveLength(90)
  })

  it('uses provider snapshots only when neither scan nor archive has a series', () => {
    const snapshots = [
      { label: '10-01', value: 3 },
      { label: '10-02', value: 4 },
    ]

    expect(selectTrendSource({ scan: [], archive: [], snapshots }).kind).toBe('snapshots')
    expect(selectTrendSource({ scan: [], archive: [], snapshots: [] }).kind).toBe('none')
    expect(selectTrendSource({ scan: [], archive: [], snapshots: [] }).points).toEqual([])
  })

  it('densifies an archive whose points carry real dates', () => {
    const archive = [
      { label: '10-01', value: 3, day: '2026-10-01' },
      { label: '10-04', value: 4, day: '2026-10-04' },
    ]

    const source = selectTrendSource({ scan: [], archive, snapshots: [] })

    expect(source.points.map((p) => p.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(source.points[1]!.value).toBe(0)
  })
  it('drops model rows that do not describe the charted series', () => {
    const scan = [day('2026-01-01', 5), day('2026-01-04', 7)]

    // Shorter: the row cannot cover the days the series has.
    const short = selectTrendSource({ scan, models: [modelRow('glm', [1], [1], [5])], archive: [], snapshots: [] })
    expect(short.hasModelDetail).toBe(false)
    expect(short.models).toEqual([])
    expect(short.points).toHaveLength(4)

    // Longer: the row carries days the series does not, so it is a different
    // series rather than one to trim.
    const long = selectTrendSource({
      scan,
      models: [modelRow('glm', [1, 1, 1], [1, 1, 1], [5, 7, 9])],
      archive: [],
      snapshots: [],
    })
    expect(long.hasModelDetail).toBe(false)
  })
})

describe('modelSlots', () => {
  it('gives every drawn model its own palette slot even when ranked past the palette', () => {
    const ranked = Array.from({ length: 12 }, (_, i) => ({ model: `m${i}` }))
    const drawn = ranked.slice(8)

    const slots = modelSlots(ranked, drawn)
    const used = drawn.map((d) => slots.get(d.model)!)

    expect(new Set(used).size).toBe(drawn.length)
  })
})

describe('buildCumulative', () => {
  it('counts only the days that carry usage and spans the charted series', () => {
    const points = denseSeries('2026-01-01', 5)
    // Zero every representation: a day counts as active only when nothing at
    // all says usage happened.
    points[2] = { ...points[2]!, value: 0, output: 0, messages: 0 }
    points[4] = { ...points[4]!, value: 0, output: 0, messages: 0 }

    const vm = buildCumulative(points, [], 1234, 'all')

    expect(vm.activeDays).toBe(3)
    expect(vm.span).toEqual({ from: '2026-01-01', to: '2026-01-05' })
    expect(vm.tokens).toBe(1234)
    expect(vm.rows).toEqual([])
    expect(vm.rowSum).toBe(0)
  })

  it('ranks models by cumulative tokens and shares them against the row total', () => {
    const points = denseSeries('2026-01-01', 2)
    const models = [
      modelRow('a', [1, 1], [1, 1], [30, 20]),
      modelRow('b', [1, 1], [1, 1], [20, 10]),
      modelRow('c', [1, 1], [1, 1], [15, 5]),
    ]

    const vm = buildCumulative(points, models, 999, 'all')

    expect(vm.rows.map((r) => r.model)).toEqual(['a', 'b', 'c'])
    expect(vm.rowSum).toBe(100)
    expect(vm.rows.map((r) => r.sharePct)).toEqual([50, 30, 20])
    expect(vm.rows[0]!.output).toBe(2)
    expect(vm.rows[0]!.messages).toBe(2)
  })

  it('keeps the headline separate from the per-model total', () => {
    // Unattributable usage lands in the headline only, so the two figures are
    // deliberately not forced to agree.
    const points = denseSeries('2026-01-01', 2)
    const models = [modelRow('a', [1, 1], [1, 1], [40, 40])]

    const vm = buildCumulative(points, models, 100, 'all')

    expect(vm.tokens).toBe(100)
    expect(vm.rowSum).toBe(80)
  })

  it('drops models with no tokens and reports no span for an empty series', () => {
    const vm = buildCumulative(
      [],
      [modelRow('a', [0], [0], [0]), modelRow('b', [1], [1], [5])],
      5,
      'all',
    )

    expect(vm.rows.map((r) => r.model)).toEqual(['b'])
    expect(vm.span).toBeNull()
    expect(vm.activeDays).toBe(0)
  })

  it('keeps a message-only model instead of dropping usage the app still shows', () => {
    const points = denseSeries('2026-01-01', 2)
    const models = [
      modelRow('paid', [0, 0], [3, 4], [0, 0]),
      modelRow('empty', [0, 0], [0, 0], [0, 0]),
    ]

    const vm = buildCumulative(points, models, 10, 'all')

    expect(vm.rows.map((r) => r.model)).toEqual(['paid'])
    expect(vm.rows[0]!.messages).toBe(7)
    expect(vm.rows[0]!.sharePct).toBe(0)
    expect(vm.rowSum).toBe(0)
  })

  it('honours the no-cache mode per model from the stored input tokens', () => {
    const points = denseSeries('2026-01-01', 2)
    // total = input + output + cache; only input and output survive no-cache.
    const models = [modelRow('a', [10, 10], [1, 1], [100, 100], [30, 30])]

    const all = buildCumulative(points, models, 999, 'all')
    const noCache = buildCumulative(points, models, 80, 'no-cache')

    expect(all.rows[0]!.tokens).toBe(200)
    // (30 + 30) input + (10 + 10) output — the cache portion is dropped.
    expect(noCache.rows[0]!.tokens).toBe(80)
    expect(noCache.tokens).toBe(80)
    expect(noCache.rows[0]!.sharePct).toBe(100)
  })

  it('counts a day whose usage shows only in the breakdown', () => {
    const points = denseSeries('2026-01-01', 2).map((p) => ({ ...p, value: 0, output: 0, messages: 0 }))
    points[1] = { ...points[1]!, cacheRead: 7 }

    const vm = buildCumulative(points, [], 0, 'all')

    expect(vm.activeDays).toBe(1)
  })
})

describe('measurable active time', () => {
  it('keeps a day whose clock cannot be a duration out of the rate', () => {
    // 2471 h filed under one calendar day is a session span, not elapsed time —
    // the shape a real scan produced 30 times out of 211.
    const points = denseSeries('2026-01-01', 3, 100)
    points[1] = { ...points[1]!, activeTimeMs: 2471 * 3_600_000 }

    const buckets = bucketize(points)

    // Its tokens still count wherever tokens are counted...
    expect(buckets.reduce((s, b) => s + b.total, 0)).toBe(300)
    // ...but it contributes neither time nor a rate numerator.
    expect(buckets[1]!.activeTimeMs).toBe(0)
    expect(buckets[1]!.measuredOutput).toBe(0)
    expect(buckets[1]!.tokPerSec).toBeNull()
    // The two sane days keep their own second and their own output.
    expect(buckets[0]!.activeTimeMs).toBe(1000)
    expect(buckets[2]!.activeTimeMs).toBe(1000)
  })

  it('pairs the rate numerator with the denominator over the same days', () => {
    const points = denseSeries('2026-01-01', 2, 60)
    points[1] = { ...points[1]!, activeTimeMs: 100 * 3_600_000 }

    const totals = computeTotals(bucketize(points), 'all')

    // Both days' output is still reported...
    expect(totals.output).toBe(120)
    // ...but only the timed day's output is divided by its own second.
    expect(totals.weightedTokPerSec).toBeCloseTo(60)
  })

  it('does not attribute an impossible day to any model', () => {
    const points = denseSeries('2026-01-01', 2)
    points[1] = { ...points[1]!, activeTimeMs: 100 * 3_600_000 }
    const models = [modelRow('a', [10, 10], [1, 1], [10, 10])]

    const rows = buildModelRows(
      models,
      2,
      points.map((p) => p.activeTimeMs),
      points.map((p) => p.messages),
      new Map(),
    )

    // Day 0's second is the only usable time, and only day 0's output pairs
    // with it — otherwise a model's speed would be inflated by a broken clock.
    expect(rows[0]!.activeTimeMs).toBe(1000)
    expect(rows[0]!.tokPerSec).toBe(10)
  })
})
