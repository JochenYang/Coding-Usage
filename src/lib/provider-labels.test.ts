import { describe, expect, it } from 'vitest'
import { displayProviderName } from './provider-labels'

/**
 * Provider labels reach the user in the overview's provider distribution.
 *
 * Two contracts matter: a mapped id must read as its brand name, and an id the
 * table has not learned yet must still be readable — gateway vendors arrive as
 * slugs (`little-jochen`), and printing one raw is what made the row look like a
 * config key. The fallback must also never invent a name: an id with nothing to
 * split on is left exactly as it is.
 */
describe('displayProviderName', () => {
  it('uses the mapped brand name when the id is known', () => {
    expect(displayProviderName('z-ai')).toBe('Z.ai')
    expect(displayProviderName('cindy')).toBe('Cindy')
  })

  it('reads an unknown slug as words', () => {
    expect(displayProviderName('little-jochen')).toBe('Little Jochen')
    expect(displayProviderName('some_vendor')).toBe('Some Vendor')
  })

  it('leaves an id with no separator untouched', () => {
    expect(displayProviderName('littlejochen')).toBe('littlejochen')
  })
})
