import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_FLAVOURS } from './antigravity-quota'
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

  it('lists the three Antigravity clients under the keys the probe and the snapshot use', () => {
    // One table feeds the registry, the card and the main-process probe, so a
    // card can never ask for a flavour whose key is not registered here.
    const names = new Set<string>()
    for (const flavour of ['ide', 'app', 'cli'] as const) {
      const def = ANTIGRAVITY_FLAVOURS[flavour]
      const card = SUBSCRIPTION_CARDS.find((entry) => entry.key === def.key)
      expect(card?.name, flavour).toBe(def.name)
      expect(isKnownSubscriptionKey(def.key), flavour).toBe(true)
      names.add(card?.name ?? '')
    }
    // Told apart in the manage drawer, where all three sit side by side
    expect(names.size).toBe(3)
  })
})
