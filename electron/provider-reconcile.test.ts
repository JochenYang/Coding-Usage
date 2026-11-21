import { describe, expect, it } from 'vitest'
import { reconcileProviderAttribution, reconcileProviderId } from './provider-reconcile'

/**
 * The kimi session parser stamps every Kimi session with provider `moonshot`
 * even when the traffic actually routed through another channel; the real
 * route is recorded in the model id's `channel/model` prefix. Only the
 * hardcoded default may be rewritten — session-derived providerIds are facts.
 */

describe('reconcileProviderId', () => {
  it('rewrites the hardcoded moonshot stamp from a routed model id', () => {
    expect(reconcileProviderId('moonshot', 'opencode/deepseek-v4-flash-free')).toBe('opencode')
  })

  it('keeps the stamp for bare Moonshot model ids', () => {
    expect(reconcileProviderId('moonshot', 'kimi-for-coding')).toBe('moonshot')
    expect(reconcileProviderId('moonshot', 'kimi-k2.5')).toBe('moonshot')
  })

  it('trims the prefix and falls back to the stamp when it is empty', () => {
    expect(reconcileProviderId('moonshot', ' opencode / model ')).toBe('opencode')
    expect(reconcileProviderId('moonshot', '   /model')).toBe('moonshot')
  })

  it('ignores a slash at position zero (no prefix)', () => {
    expect(reconcileProviderId('moonshot', '/deepseek')).toBe('moonshot')
  })

  it('never touches session-derived or missing providerIds', () => {
    expect(reconcileProviderId('opencode', 'moonshot/kimi-k2.5')).toBe('opencode')
    expect(reconcileProviderId('dsh', 'anything/model')).toBe('dsh')
    expect(reconcileProviderId(undefined, 'opencode/deepseek')).toBeUndefined()
    expect(reconcileProviderId('', 'opencode/deepseek')).toBe('')
  })

  it('keeps the stamp when the model id is not a usable string', () => {
    expect(reconcileProviderId('moonshot', undefined)).toBe('moonshot')
    expect(reconcileProviderId('moonshot', '')).toBe('moonshot')
  })
})

describe('reconcileProviderAttribution', () => {
  it('rewrites only the hardcoded default across every client entry', () => {
    const daily = {
      contributions: [
        {
          clients: [
            { client: 'kimi', providerId: 'moonshot', modelId: 'opencode/deepseek-v4-flash-free' },
            { client: 'kimi', providerId: 'moonshot', modelId: 'kimi-for-coding' },
            { client: 'opencode', providerId: 'opencode', modelId: 'anything/model' },
            { client: 'noid', providerId: 'moonshot' },
          ],
        },
        { clients: [{ client: 'kimi', providerId: 'moonshot', modelId: 'zai/chat' }] },
      ],
    }
    const out = reconcileProviderAttribution(daily) as typeof daily
    const [first, second] = out.contributions
    expect(first?.clients?.[0]?.providerId).toBe('opencode')
    // Bare Kimi model id: genuinely Moonshot, stamp kept
    expect(first?.clients?.[1]?.providerId).toBe('moonshot')
    // Session-derived providerId trusted as-is even with a routed model id
    expect(first?.clients?.[2]?.providerId).toBe('opencode')
    expect(first?.clients?.[3]?.providerId).toBe('moonshot')
    expect(second?.clients?.[0]?.providerId).toBe('zai')
  })

  it('returns the payload unchanged when nothing needed rewriting', () => {
    const daily = { contributions: [{ clients: [{ client: 'codex', providerId: 'openai', modelId: 'gpt-5.2' }] }] }
    expect(reconcileProviderAttribution(daily)).toEqual(daily)
  })

  it('passes through malformed payloads and shapeless entries without throwing', () => {
    const noClients = { contributions: [{ clients: 'not-an-array' }, null, { clients: [null, 42, {}] }] }
    expect(reconcileProviderAttribution(noClients)).toEqual(noClients)
    expect(reconcileProviderAttribution({ contributions: 'not-an-array' })).toEqual({ contributions: 'not-an-array' })
    expect(reconcileProviderAttribution(null)).toBeNull()
    expect(reconcileProviderAttribution('string')).toBe('string')
    expect(reconcileProviderAttribution(undefined)).toBeUndefined()
    // Entries without a usable providerId stay that way
    const sparse = { contributions: [{ clients: [{ client: 'x' }, { providerId: 'moonshot', modelId: null }] }] }
    expect(reconcileProviderAttribution(sparse)).toEqual(sparse)
  })
})
