import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTrendPoints, DIST_COLORS, DIST_OTHER_COLOR, foldSlices } from './overview'
import { selectTrendSource } from './trend-analysis'

/**
 * Provider snapshots are the trends page's last-resort source (no local scan,
 * no daily archive). The page asks for the whole retention window; each point
 * has to keep its day so the calendar gaps between readings come back.
 */
describe('snapshot fallback for the trends page', () => {
  const KEY = 'coding-usage.snapshots.v1'
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  /** Local calendar day key `daysAgo` days before today */
  const localDay = (daysAgo: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - daysAgo)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  /** Noon local time, `daysAgo` days back, so a stamp never straddles midnight */
  const noon = (daysAgo: number): number => {
    const d = new Date()
    d.setDate(d.getDate() - daysAgo)
    d.setHours(12, 0, 0, 0)
    return d.getTime()
  }

  // Node test environment has no localStorage; a Map-backed stub is enough
  beforeEach(() => {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('asks for the whole window and keeps each point on its day', () => {
    // Readings on three consecutive days, then after gaps; one is a quota
    // reset (used drops). A reading taken after a gap carries the consumption
    // of the whole gap; a reset contributes nothing and starts a new baseline.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        'acme-0': [
          { t: noon(20), used: 100, pct: 10, total: 1000 },
          { t: noon(19), used: 150, pct: 15, total: 1000 },
          { t: noon(18), used: 200, pct: 20, total: 1000 },
          { t: noon(10), used: 300, pct: 30, total: 1000 },
          { t: noon(5), used: 100, pct: 10, total: 1000 },
          { t: noon(1), used: 400, pct: 40, total: 1000 },
          { t: noon(0), used: 450, pct: 45, total: 1000 },
        ],
      }),
    )
    const sections = [{ cards: [{ key: 'acme-0' }] }] as unknown as Parameters<typeof buildTrendPoints>[0]

    // The overview's default week: its first reading (day 5) has nothing
    // earlier to compare with inside the window
    expect(buildTrendPoints(sections).map((p) => p.value)).toEqual([300, 50])
    const month = buildTrendPoints(sections, 30)
    expect(month.map((p) => p.value)).toEqual([50, 50, 100, 300, 50])
    expect(month.map((p) => p.day)).toEqual([localDay(19), localDay(18), localDay(10), localDay(1), localDay(0)])

    // On the trends page the idle days between the readings come back as zero
    // days instead of the points sitting side by side
    const source = selectTrendSource({ scan: [], archive: [], snapshots: month, today: localDay(0) })
    expect(source.kind).toBe('snapshots')
    expect(source.points).toHaveLength(20)
    expect(source.points.filter((p) => p.value > 0).map((p) => p.day)).toEqual([
      localDay(19),
      localDay(18),
      localDay(10),
      localDay(1),
      localDay(0),
    ])
    expect(source.points.reduce((s, p) => s + p.value, 0)).toBe(550)
  })
})

/**
 * The donut's legend is a folded view: a handful of named slices plus "other".
 * These pin where the fold falls — a wrong threshold either hides a provider
 * the user does spend on or leaves arcs too small to see.
 */
describe('foldSlices', () => {
  const entry = (label: string, tokens: number) => ({ label, tokens })

  it('keeps every entry that clears the share floor, largest first', () => {
    const slices = foldSlices([entry('b', 30), entry('a', 50), entry('c', 20)], 'other')

    expect(slices.map((s) => s.label)).toEqual(['a', 'b', 'c'])
    expect(slices.map((s) => s.color)).toEqual([DIST_COLORS[0], DIST_COLORS[1], DIST_COLORS[2]])
  })

  it('folds small shares into one muted slice that carries their sum', () => {
    const slices = foldSlices([entry('a', 90), entry('b', 6), entry('c', 3), entry('d', 1)], '其他')

    expect(slices.map((s) => s.label)).toEqual(['a', 'b', 'c', '其他'])
    // 3% is exactly on the floor (kept); 1% is not
    expect(slices[3]).toMatchObject({ value: 1, color: DIST_OTHER_COLOR })
  })

  it('stops naming slices past the cap however large they are', () => {
    const slices = foldSlices(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((label) => entry(label, 10)),
      'other',
    )

    expect(slices).toHaveLength(7)
    expect(slices.slice(0, 6).map((s) => s.label)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(slices[6]).toMatchObject({ label: 'other', value: 20 })
  })

  it('always keeps the biggest entry, even when nothing clears the floor', () => {
    const slices = foldSlices(Array.from({ length: 60 }, (_, i) => entry(`p${i}`, 1)), 'other')

    // 1/60 is under 3%: without the floor override the ring would be all "other"
    expect(slices[0]?.label).toBe('p0')
    expect(slices[1]).toMatchObject({ label: 'other', value: 59 })
  })

  it('returns nothing for an empty ranking', () => {
    expect(foldSlices([], 'other')).toEqual([])
  })
})
