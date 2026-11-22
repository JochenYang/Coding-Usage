import { describe, expect, it } from 'vitest'
import { DIST_COLORS, DIST_OTHER_COLOR, foldSlices } from './overview'

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
