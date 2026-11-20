import { describe, expect, it } from 'vitest'
import { DEFAULT_ENABLED_SUBSCRIPTIONS, SUBSCRIPTION_CARDS, isKnownSubscriptionKey } from './subscription-cards'

describe('subscription card registry', () => {
  it('keeps the Alibaba console cards experimental and out of the default set', () => {
    for (const key of ['alibaba', 'qwen', 'alitoken']) {
      const card = SUBSCRIPTION_CARDS.find((entry) => entry.key === key)
      expect(card?.experimental).toBe(true)
      expect(DEFAULT_ENABLED_SUBSCRIPTIONS).not.toContain(key)
    }
  })

  it('enables every non-experimental card by default', () => {
    const expected = SUBSCRIPTION_CARDS.filter((card) => !card.experimental).map((card) => card.key)
    expect([...DEFAULT_ENABLED_SUBSCRIPTIONS].sort()).toEqual([...expected].sort())
    expect(DEFAULT_ENABLED_SUBSCRIPTIONS).toHaveLength(expected.length)
  })

  it('has unique keys and recognises them', () => {
    const keys = SUBSCRIPTION_CARDS.map((card) => card.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(isKnownSubscriptionKey('cline')).toBe(true)
    expect(isKnownSubscriptionKey('nope')).toBe(false)
  })
})
