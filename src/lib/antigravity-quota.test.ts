import { describe, expect, it } from 'vitest'
import { summarizeAntigravityQuota } from './antigravity-quota'

/**
 * Regression: the quota summary reports REMAINING fractions and omits
 * `remainingFraction` once a pool is used up. Reading an omitted value as "no
 * data" dropped that bucket — an exhausted pool disappeared from the card
 * instead of showing 0%.
 */
function payload(groups: unknown[]): unknown {
  return { available: true, body: JSON.stringify({ groups }) }
}

describe('summarizeAntigravityQuota', () => {
  it('maps the Gemini and third-party pools with their windows', () => {
    const vm = summarizeAntigravityQuota(
      payload([
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2026-11-04T01:47:35Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1 },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.25 }],
        },
      ]),
    )

    expect(vm.available).toBe(true)
    expect(vm.groups.map((g) => g.id)).toEqual(['gemini', 'thirdParty'])
    expect(vm.groups[0].buckets.map((b) => [b.window, b.remainingPct])).toEqual([
      ['weekly', 50],
      ['fiveHour', 100],
    ])
    expect(vm.groups[1].buckets[0].remainingPct).toBe(25)
  })

  it('reads an omitted remainingFraction as an exhausted pool', () => {
    const vm = summarizeAntigravityQuota(
      payload([
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-11-04T01:47:35Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5 },
          ],
        },
      ]),
    )

    expect(vm.available).toBe(true)
    expect(vm.groups[0].buckets[0].remainingPct).toBe(0)
    expect(vm.groups[0].buckets).toHaveLength(2)
  })

  it('drops buckets the plan does not grant', () => {
    const vm = summarizeAntigravityQuota(
      payload([
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4 },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, disabled: true },
          ],
        },
      ]),
    )

    expect(vm.groups[0].buckets.map((b) => b.id)).toEqual(['gemini-weekly'])
  })

  it('accepts the legacy response envelope', () => {
    const body = JSON.stringify({
      response: { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.7 }] }] },
    })
    const vm = summarizeAntigravityQuota({ available: true, body })
    expect(vm.available).toBe(true)
    expect(vm.groups[0].buckets[0].remainingPct).toBe(70)
  })

  it('reports an empty summary instead of rendering a bare frame', () => {
    const vm = summarizeAntigravityQuota(payload([]))
    expect(vm.available).toBe(false)
    expect(vm.reason).toBe('no-buckets')
  })
})
