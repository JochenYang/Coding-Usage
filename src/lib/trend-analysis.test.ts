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
  groupModelDaily,
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
    credits: 0,
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
  cacheRead?: number[],
): ModelDailySeriesVM {
  const resolvedInput = input ?? total.map((v, i) => Math.max(0, v - (output[i] ?? 0)))
  return {
    model,
    tokens: total.reduce((s, v) => s + v, 0),
    // Input defaults to `total - output` and cache reads to what is left after
    // input and output, so the four parts always add up to the total; pass
    // them explicitly when a test needs the split to be exact.
    input: resolvedInput,
    cacheRead: cacheRead ?? total.map((v, i) => Math.max(0, v - (resolvedInput[i] ?? 0) - (output[i] ?? 0))),
    output,
    messages,
    total,
  }
}

/** `selectTrendSource` over the scan alone, with the grid ending on `today` */
function scanSource(scan: DayPointVM[], models: ModelDailySeriesVM[], today: string) {
  return selectTrendSource({ scan, models, archive: [], snapshots: [], today })
}

describe('densifySeries', () => {
  it('inserts zero rows for days the scan never reported', () => {
    const sparse = [day('2026-01-01', 10), day('2026-01-05', 20)]
    const models = [modelRow('glm', [1, 2], [1, 1], [10, 20], [3, 6], [5, 11])]

    const { points, models: dense } = densifySeries(sparse, models, '2026-01-05')

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
    expect(dense[0]!.input).toEqual([3, 0, 0, 0, 6])
    expect(dense[0]!.cacheRead).toEqual([5, 0, 0, 0, 11])
    expect(dense[0]!.tokens).toBe(30)
  })

  it('carries the grid up to today when the last record is older', () => {
    // Five idle days after the last record: without the tail, "last 7 days"
    // was the week before them.
    const sparse = [day('2026-01-01', 10), day('2026-01-03', 20)]
    const models = [modelRow('glm', [1, 2], [1, 1], [10, 20])]

    const { points, models: dense } = densifySeries(sparse, models, '2026-01-08')

    expect(points.map((p) => p.day)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'])
    expect(points.map((p) => p.value)).toEqual([10, 0, 20, 0, 0, 0, 0, 0])
    expect(dense[0]!.total).toEqual([10, 0, 20, 0, 0, 0, 0, 0])
    // A grid that already ends on the last record is extended by exactly one
    // day when today is the day after
    expect(densifySeries(denseSeries('2026-01-01', 3), [], '2026-01-04').points.map((p) => p.value)).toEqual([1, 1, 1, 0])
  })

  it('does not extend a series that already reaches past today', () => {
    // A record dated ahead of the local clock is neither truncated nor padded:
    // the gaps inside the span are still filled, the span ends at the record.
    const ahead = [day('2026-01-01'), day('2026-01-10')]

    const { points } = densifySeries(ahead, [], '2026-01-05')

    expect(points).toHaveLength(10)
    expect(points.at(-1)!.day).toBe('2026-01-10')
  })

  it('leaves a series without day keys untouched instead of inventing dates', () => {
    const legacy: DayPointVM[] = [
      { label: '01-01', value: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, activeTimeMs: 0, messages: 0, credits: 0 },
      { label: '01-09', value: 2, input: 2, output: 0, cacheRead: 0, cacheWrite: 0, activeTimeMs: 0, messages: 0, credits: 0 },
    ]

    const { points } = densifySeries(legacy, [], '2026-01-09')

    expect(points).toHaveLength(2)
  })

  it('returns the rows untouched when the series is already dense', () => {
    const dense = denseSeries('2026-01-01', 5)

    const { points } = densifySeries(dense, [], '2026-01-05')

    expect(points).toHaveLength(5)
    expect(points[0]).toBe(dense[0])
  })

  it('refuses a series that is not strictly ascending', () => {
    // The span guard must not be what rejects this: total would be 5 (> 3 rows),
    // so only the ascending check can catch it.
    const outOfOrder = [day('2026-01-01'), day('2026-01-10'), day('2026-01-05')]

    const { points } = densifySeries(outOfOrder, [], '2026-01-10')

    expect(points.map((p) => p.day)).toEqual(['2026-01-01', '2026-01-10', '2026-01-05'])
  })

  it('refuses a calendar-invalid day instead of letting Date.parse normalise it', () => {
    // Date.parse("2026-02-30T00:00:00Z") resolves to 2026-03-02, so a shape-only
    // check would drop the 02-30 contribution and invent a 03-02 day in its
    // place — the same silent misalignment W2 exists to remove.
    const bogus = [day('2026-02-28', 5), day('2026-02-30', 9)]

    const { points } = densifySeries(bogus, [], '2026-02-28')

    expect(points.map((p) => p.day)).toEqual(['2026-02-28', '2026-02-30'])
    expect(points.reduce((s, p) => s + p.value, 0)).toBe(14)
  })

  it('refuses a span beyond the grid budget instead of allocating it', () => {
    // Unbounded, this would build ~2.9M rows times every model row during render.
    const absurd = [day('2026-01-01', 5), day('9999-12-31', 7)]

    const { points } = densifySeries(absurd, [], '2026-01-01')

    expect(points).toHaveLength(2)
    expect(points.reduce((s, p) => s + p.value, 0)).toBe(12)
  })

  it('refuses a span that only the tail to today pushes past the grid budget', () => {
    // Thirty years of zero rows times every model row is the same allocation
    // whether a record or the calendar asked for it.
    const old = [day('1996-06-01', 5), day('1996-06-03', 7)]

    const { points } = densifySeries(old, [], '2026-11-23')

    expect(points).toHaveLength(2)
    expect(points.reduce((s, p) => s + p.value, 0)).toBe(12)
  })

  it('crosses a leap day without drifting', () => {
    const sparse = [day('2028-02-27', 1), day('2028-03-02', 1)]

    const { points } = densifySeries(sparse, [], '2028-03-02')

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

    const { points } = densifySeries(sparse, [], '2026-01-02')

    expect(points.map((p) => p.day)).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])
  })

  it('does not mutate the caller rows or their arrays', () => {
    const sparse = [day('2026-01-01'), day('2026-01-03')]
    const models = [modelRow('glm', [1, 1], [1, 1], [1, 1])]

    densifySeries(sparse, models, '2026-01-03')

    expect(sparse).toHaveLength(2)
    expect(models[0]!.total).toEqual([1, 1])
  })
})

describe('range semantics on a sparse scan', () => {
  // 20 recorded days spread 10 days apart: a real 191-day span, 171 idle days.
  const sparse = Array.from({ length: 20 }, (_, i) => day(addDays('2026-01-01', i * 10), 100))
  const lastDay = addDays('2026-01-01', 190)

  it('makes "last 30 days" mean 30 calendar days, not the last 30 recorded days', () => {
    const source = scanSource(sparse, [], lastDay)
    const windowed = sliceRange(source.points, 30)

    expect(windowed).toHaveLength(30)
    expect(windowed[0]!.day).toBe(addDays('2026-01-01', 190 - 29))
    // Only the 170/180/190-offset days had usage; the other 27 days are zeros.
    expect(windowed.reduce((s, p) => s + p.value, 0)).toBe(300)
  })

  it('counts the idle days after the last record as part of the window', () => {
    // Usage stopped five days ago: "last 7 days" is those five days plus the
    // two before them, not the last seven recorded ones.
    const source = scanSource(sparse, [], addDays(lastDay, 5))
    const windowed = sliceRange(source.points, 7)

    expect(windowed.at(-1)!.day).toBe(addDays(lastDay, 5))
    // The record five days back (offset 190) is the second of the seven
    expect(windowed.map((p) => p.value)).toEqual([0, 100, 0, 0, 0, 0, 0])
  })

  it('keeps every column the same calendar width on a long span', () => {
    const source = scanSource(sparse, [], lastDay)
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

  it('marks the column holding today as partial', () => {
    // Today is still filling in, so at a daily width it would read as a slump
    // every morning; with weekly columns the whole last week reads low for it.
    const daily = bucketize(denseSeries('2026-01-01', 3), '2026-01-03')
    expect(daily.map((b) => b.partial)).toEqual([false, false, true])

    // 35 days -> five 7-day columns; the last one is a full week by day count
    const weekly = bucketize(denseSeries('2026-01-01', 35), '2026-02-04')
    expect(weekly).toHaveLength(5)
    expect(weekly.map((b) => b.partial)).toEqual([false, false, false, false, true])
  })

  it('leaves a window that ends before today unmarked', () => {
    const buckets = bucketize(denseSeries('2026-01-01', 3), '2026-02-01')

    expect(buckets.every((b) => !b.partial)).toBe(true)
  })
})

describe('computeTotals', () => {
  const points = denseSeries('2026-01-01', 3).map((p) => ({
    ...p,
    input: 10,
    output: 5,
    cacheRead: 20,
    cacheWrite: 7,
    value: 42,
  }))

  it('keeps the headline total and the hit rate self-consistent per display mode', () => {
    const buckets = bucketize(points)
    const all = computeTotals(buckets, 'all')
    const noCache = computeTotals(buckets, 'no-cache')

    expect(all.tokens).toBe(126)
    expect(noCache.tokens).toBe(45)
    // Cache hit rate describes the prompt side, so it does not follow the
    // display mode — the split itself is unchanged.
    expect(all.hitRatePct).toBeCloseTo((60 / 90) * 100)
    expect(noCache.hitRatePct).toBeCloseTo((60 / 90) * 100)
  })

  it('reports every part of the breakdown, so the parts add up to the headline', () => {
    const all = computeTotals(bucketize(points), 'all')

    // The writes used to be counted in the headline and reported nowhere
    expect(all.cacheWrite).toBe(21)
    expect(all.cacheRead + all.cacheWrite + all.input + all.output).toBe(all.tokens)
  })
})
describe('filterByModels', () => {
  const points = denseSeries('2026-01-01', 3)
  // b: reads 10/15/20, writes 6/5/4 — the part of the total the others leave
  const models = [
    modelRow('a', [1, 2, 3], [1, 1, 1], [10, 20, 30], [5, 10, 15], [2, 4, 6]),
    modelRow('b', [4, 5, 6], [2, 2, 2], [40, 50, 60], [20, 25, 30], [10, 15, 20]),
  ]

  it('recomputes the day series from the selected models only, split included', () => {
    const only = filterByModels(points, models, ['b'])

    expect(only.map((p) => p.output)).toEqual([4, 5, 6])
    expect(only.map((p) => p.input)).toEqual([20, 25, 30])
    expect(only.map((p) => p.cacheRead)).toEqual([10, 15, 20])
    expect(only.map((p) => p.cacheWrite)).toEqual([6, 5, 4])
    expect(only.map((p) => p.value)).toEqual([40, 50, 60])
    expect(only.map((p) => p.messages)).toEqual([2, 2, 2])
    // The day identity survives the recomputation, so the axis stays right.
    expect(only.map((p) => p.day)).toEqual(points.map((p) => p.day))
  })

  it('reads a filtered selection in either display mode, hit rate included', () => {
    // The regression: input used to be `total - output`, so the no-cache
    // headline of a filtered page silently carried the cache, and the hit rate
    // had to be reported unavailable.
    const only = bucketize(filterByModels(points, models, ['b']))

    expect(computeTotals(only, 'all').tokens).toBe(150)
    expect(computeTotals(only, 'no-cache').tokens).toBe(90)
    expect(computeTotals(only, 'no-cache').hitRatePct).toBeCloseTo((45 / 120) * 100)
  })

  it('sums the picked models into the same split the day series carries', () => {
    const both = filterByModels(points, models, ['a', 'b'])

    expect(both.map((p) => p.input)).toEqual([25, 35, 45])
    expect(both.map((p) => p.cacheRead)).toEqual([12, 19, 26])
    expect(both.map((p) => p.cacheWrite)).toEqual([8, 9, 10])
    expect(both.map((p) => p.value)).toEqual([50, 70, 90])
  })

  it('returns the series untouched when nothing is selected', () => {
    expect(filterByModels(points, [], [])).toEqual(points)
  })

  it('returns nothing when the selection matches no model', () => {
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
      'all',
    )

    const a = rows.find((r) => r.model === 'a')!
    expect(a.activeTimeMs).toBe(5000)
    expect(a.tokPerSec).toBe(20)
  })

  it('reads the token figure in the requested display mode', () => {
    // total = input + output + cache; the comparison bars used to take the
    // total whichever mode the KPI row above them was read in.
    const models = [modelRow('a', [10, 10], [1, 1], [100, 100], [30, 30])]

    const rows = (mode: 'all' | 'no-cache') =>
      buildModelRows(models, 2, [1000, 1000], [1, 1], new Map(), mode)[0]!

    expect(rows('all').tokens).toBe(200)
    expect(rows('no-cache').tokens).toBe(80)
  })

  it('keeps every model row exactly as long as the day series', () => {
    const scan = [day('2026-01-01', 5), day('2026-01-31', 7)]
    const models = [modelRow('glm', [1, 2], [1, 1], [5, 7])]

    const source = scanSource(scan, models, '2026-01-31')

    expect(source.points).toHaveLength(31)
    for (const row of source.models) {
      expect(row.total).toHaveLength(source.points.length)
      expect(row.output).toHaveLength(source.points.length)
      expect(row.cacheRead).toHaveLength(source.points.length)
      expect(row.messages).toHaveLength(source.points.length)
    }
    // The two recorded days land on their real dates, not at the array's head.
    expect(source.models[0]!.total[0]).toBe(5)
    expect(source.models[0]!.total[30]).toBe(7)
  })
})

describe('groupModelDaily', () => {
  it('merges the provider-qualified rows of one model, every array included', () => {
    const rows = [
      modelRow('prov-a/glm', [1, 0], [1, 0], [10, 0], [3, 0], [5, 0]),
      modelRow('prov-b/glm', [2, 1], [3, 1], [20, 5], [8, 2], [7, 3]),
    ]

    const grouped = groupModelDaily(rows)

    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.model).toBe('glm')
    expect(grouped[0]!.tokens).toBe(35)
    expect(grouped[0]!.input).toEqual([11, 2])
    expect(grouped[0]!.cacheRead).toEqual([12, 3])
    expect(grouped[0]!.output).toEqual([3, 1])
    expect(grouped[0]!.messages).toEqual([4, 1])
    expect(grouped[0]!.total).toEqual([30, 5])
    // The caller's rows stay untouched
    expect(rows[0]!.total).toEqual([10, 0])
  })

  it('decodes percent-encoded ids and ranks by total tokens', () => {
    const grouped = groupModelDaily([
      modelRow('%e6%99%ba%e8%b0%B1/small', [1], [1], [1]),
      modelRow('plain/big', [1], [1], [50]),
    ])

    expect(grouped.map((m) => m.model)).toEqual(['big', 'small'])
  })
})

describe('selectTrendSource', () => {
  const models = [modelRow('glm', [1, 2], [1, 1], [5, 7])]

  it('uses the scan series and reports model detail for it', () => {
    const scan = [day('2026-01-01', 5), day('2026-01-04', 7)]

    const source = scanSource(scan, models, '2026-01-04')

    expect(source.kind).toBe('scan')
    expect(source.hasModelDetail).toBe(true)
    expect(source.points).toHaveLength(4)
    expect(source.models[0]!.total).toEqual([5, 0, 0, 7])
  })

  it('carries the scan grid up to the given day', () => {
    const scan = [day('2026-01-01', 5), day('2026-01-04', 7)]

    const source = scanSource(scan, models, '2026-01-06')

    expect(source.points.map((p) => p.value)).toEqual([5, 0, 0, 7, 0, 0])
    expect(source.models[0]!.total).toEqual([5, 0, 0, 7, 0, 0])
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
      today: '2026-10-10',
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
    const today = '2026-10-02'

    expect(selectTrendSource({ scan: [], archive: [], snapshots, today }).kind).toBe('snapshots')
    expect(selectTrendSource({ scan: [], archive: [], snapshots: [], today }).kind).toBe('none')
    expect(selectTrendSource({ scan: [], archive: [], snapshots: [], today }).points).toEqual([])
  })

  it('densifies an archive whose points carry real dates', () => {
    const archive = [
      { label: '10-01', value: 3, day: '2026-10-01' },
      { label: '10-04', value: 4, day: '2026-10-04' },
    ]

    const source = selectTrendSource({ scan: [], archive, snapshots: [], today: '2026-10-04' })

    expect(source.points.map((p) => p.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(source.points[1]!.value).toBe(0)
  })
  it('drops model rows that do not describe the charted series', () => {
    const scan = [day('2026-01-01', 5), day('2026-01-04', 7)]
    const today = '2026-01-04'

    // Shorter: the row cannot cover the days the series has.
    const short = scanSource(scan, [modelRow('glm', [1], [1], [5])], today)
    expect(short.hasModelDetail).toBe(false)
    expect(short.models).toEqual([])
    expect(short.points).toHaveLength(4)

    // Longer: the row carries days the series does not, so it is a different
    // series rather than one to trim.
    const long = scanSource(scan, [modelRow('glm', [1, 1, 1], [1, 1, 1], [5, 7, 9])], today)
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
    // the shape a real scan produced 26 times, from one stuck session.
    const points = denseSeries('2026-01-01', 3, 100)
    points[1] = { ...points[1]!, activeTimeMs: 2471 * 3_600_000, messages: 6 }

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

  it('keeps a heavy day whose sessions overlap past 24 hours', () => {
    // Active time is a SUM of session spans, so 29.4 h with 4 458 calls is an
    // ordinary busy day. Dropping it took the month's largest column out of
    // the rate and left the speed line with a hole under the tallest bar.
    const hour = 3_600_000
    const points = denseSeries('2026-01-01', 3, 100)
    points[1] = { ...points[1]!, activeTimeMs: 29.4 * hour, messages: 4458 }

    const buckets = bucketize(points)

    expect(buckets[1]!.activeTimeMs).toBe(29.4 * hour)
    expect(buckets[1]!.tokPerSec).toBeCloseTo(100 / (29.4 * 3600))
  })

  it('judges a day past 24 hours by how much time each call accounts for', () => {
    // Two days of 30 h: one spread over thousands of calls, one over 61. Only
    // the first is overlapping sessions; the second is a stuck session's span.
    // No cut in hours can tell them apart — on a real scan the first stuck day
    // (31.5 h) sat below the heaviest real one (32.3 h).
    const half = 30 * 3_600_000
    const points = denseSeries('2026-01-01', 4, 100)
    points[0] = { ...points[0]!, activeTimeMs: half, messages: 4000 }
    points[1] = { ...points[1]!, activeTimeMs: half, messages: 61 }
    // Past 24 h with no call to account for it at all
    points[2] = { ...points[2]!, activeTimeMs: half, messages: 0 }
    // Exactly 24 h is taken as recorded, calls or none
    points[3] = { ...points[3]!, activeTimeMs: DAY_MS, messages: 0 }

    const buckets = bucketize(points)

    expect(buckets[0]!.tokPerSec).not.toBeNull()
    expect(buckets[1]!.tokPerSec).toBeNull()
    expect(buckets[2]!.tokPerSec).toBeNull()
    expect(buckets[3]!.tokPerSec).not.toBeNull()
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
      'all',
    )

    // Day 0's second is the only usable time, and only day 0's output pairs
    // with it — otherwise a model's speed would be inflated by a broken clock.
    expect(rows[0]!.activeTimeMs).toBe(1000)
    expect(rows[0]!.tokPerSec).toBe(10)
  })
})

describe('credits series (Qoder gateway billing)', () => {
  const creditDay = (dayKey: string, credits: number): DayPointVM => ({ ...day(dayKey, 0), credits })

  it('conserves credits through bucketize and computeTotals without folding them into tokens', () => {
    // A quarter-length window so bucketize steps up to weekly columns; credits
    // land on scattered days, and the fixture zeros elsewhere are the sparse
    // days a Qoder-only account would report.
    const points = denseSeries('2026-01-01', 90).map((p, i) => ({ ...p, credits: i % 7 === 3 ? 12 : 0 }))
    // The odd 7.5 rides on a day that still carries its tokens: credits must
    // not disturb the token headline either way.
    points[40] = { ...points[40]!, credits: 7.5 }

    const buckets = bucketize(points)
    const bucketCredits = buckets.reduce((s, b) => s + b.credits, 0)
    const pointCredits = points.reduce((s, p) => s + p.credits, 0)
    // Conservation: every credit survives bucketing — 13 scattered 12-credit
    // days (i ≡ 3 mod 7) plus the odd 7.5 on day 40
    expect(bucketCredits).toBe(pointCredits)
    expect(pointCredits).toBe(156 + 7.5)

    const totals = computeTotals(buckets, 'all')
    expect(totals.credits).toBe(pointCredits)
    // Credits are an independent unit: the token headline is untouched by them
    const withoutCredits = computeTotals(bucketize(denseSeries('2026-01-01', 90)), 'all')
    expect(totals.tokens).toBe(withoutCredits.tokens)
    // and a credits-less series sums to exactly zero, never NaN
    expect(withoutCredits.credits).toBe(0)
  })

  it('densified zero days carry 0 credits so a pre-credits cache cannot fake a balance', () => {
    // densifySeries inserts zero rows for days the scan never reported; those
    // rows must not invent credits, and a persisted point missing the field
    // (old cache) contributes 0 instead of NaN.
    const sparse = [creditDay('2026-01-01', 30), creditDay('2026-01-09', 5)]
    const dense = densifySeries(sparse, [], '2026-01-09').points
    expect(dense.length).toBe(9)
    expect(dense.reduce((s, p) => s + p.credits, 0)).toBe(35)

    // A persisted point written before the credits field existed has NO key at
    // all — simulate that exact shape (the double cast is the simulation of
    // old JSON, not a production pattern).
    const legacy = dense.map(({ credits: _dropped, ...rest }) => rest) as unknown as DayPointVM[]
    const totals = computeTotals(bucketize(legacy), 'all')
    expect(totals.credits).toBe(0)
    expect(Number.isFinite(totals.credits)).toBe(true)
  })
})
