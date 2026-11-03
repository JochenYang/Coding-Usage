import { describe, expect, it } from 'vitest'
import { applyPlanOrder, mergeVisibleOrder, moveKey } from './plan-order'

const card = (key: string): { key: string } => ({ key })

describe('applyPlanOrder', () => {
  it('orders cards by the saved key list', () => {
    const cards = [card('a'), card('b'), card('c')]
    expect(applyPlanOrder(cards, ['c', 'a', 'b']).map((c) => c.key)).toEqual(['c', 'a', 'b'])
  })

  it('keeps cards the saved order does not know yet, in their natural order', () => {
    const cards = [card('a'), card('new-1'), card('b'), card('new-2')]
    expect(applyPlanOrder(cards, ['b', 'a']).map((c) => c.key)).toEqual([
      'b',
      'a',
      'new-1',
      'new-2',
    ])
  })

  it('returns the natural order when nothing has been saved', () => {
    const cards = [card('a'), card('b')]
    expect(applyPlanOrder(cards, []).map((c) => c.key)).toEqual(['a', 'b'])
  })
})

describe('mergeVisibleOrder', () => {
  it('reorders only the visible keys, leaving hidden slots untouched', () => {
    const full = ['a', 'b', 'c', 'd', 'e']
    // b and d are visible; the user dragged d above b
    expect(mergeVisibleOrder(full, ['d', 'b'])).toEqual(['a', 'd', 'c', 'b', 'e'])
  })

  it('is a no-op when the visible order is unchanged', () => {
    const full = ['a', 'b', 'c']
    expect(mergeVisibleOrder(full, ['a', 'c'])).toEqual(full)
  })
})

describe('moveKey', () => {
  it('moves a key forward and backward', () => {
    expect(moveKey(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveKey(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('ignores out-of-range or identical moves', () => {
    expect(moveKey(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(moveKey(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
    expect(moveKey(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
  })
})
