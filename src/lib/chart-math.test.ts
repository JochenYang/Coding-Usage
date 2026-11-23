import { describe, expect, it } from 'vitest'
import { contiguousRuns } from './chart-math'

describe('contiguousRuns', () => {
  it('returns one run for a series without gaps, keeping the original indexes', () => {
    expect(contiguousRuns([5, 6, 7])).toEqual([
      [
        { index: 0, value: 5 },
        { index: 1, value: 6 },
        { index: 2, value: 7 },
      ],
    ])
  })

  it('splits at a missing value and never bridges the gap', () => {
    expect(contiguousRuns([1, null, 3])).toEqual([[{ index: 0, value: 1 }], [{ index: 2, value: 3 }]])
    expect(contiguousRuns([null, 1, 2, null, null, 3])).toEqual([
      [
        { index: 1, value: 1 },
        { index: 2, value: 2 },
      ],
      [{ index: 5, value: 3 }],
    ])
  })

  it('keeps a measured zero inside a run', () => {
    // Zero is a value — a day with a usable clock and no output; only a
    // missing value is a gap
    expect(contiguousRuns([0, 1])).toEqual([
      [
        { index: 0, value: 0 },
        { index: 1, value: 1 },
      ],
    ])
  })

  it('returns nothing for an empty or an all-missing series', () => {
    expect(contiguousRuns([])).toEqual([])
    expect(contiguousRuns([null, null])).toEqual([])
  })
})
