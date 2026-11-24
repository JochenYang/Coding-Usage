import { describe, expect, it } from 'vitest'
import { antigravityCardSpan, narrowAntigravityQuota, summarizeAntigravityQuota } from './antigravity-quota'

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

describe('install state', () => {
  const groups = [
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1 }] },
  ]

  it('is carried with a reading, whatever the verdict was', () => {
    const reading = { available: true, body: JSON.stringify({ groups }) }
    expect(summarizeAntigravityQuota({ ...reading, installed: false }).installed).toBe(false)
    expect(summarizeAntigravityQuota({ ...reading, installed: true }).installed).toBe(true)
    expect(
      summarizeAntigravityQuota({ available: false, reason: 'no-credentials', installed: false }).installed,
    ).toBe(false)
  })

  it('stays unknown when the probe said nothing, or said something else', () => {
    // A stored snapshot carries no install state, and junk must never be read
    // as "the client is gone": only an explicit false says that.
    for (const installed of [undefined, null, 'false', 0, {}]) {
      expect(
        summarizeAntigravityQuota({ available: true, body: JSON.stringify({ groups }), installed }).installed,
      ).toBeNull()
    }
  })
})

describe('narrowAntigravityQuota', () => {
  /** Two pools as the service sends them, with every member type the card may meet */
  const pools = [
    {
      displayName: 'Gemini Models',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          window: 'weekly',
          remainingFraction: 0.5,
          resetTime: '2026-12-01T00:25:57Z',
          description: 'Your quota will fully refresh in 6 days.',
        },
        // No fraction: the allowance is used up, which the card must still read as 0
        { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-11-24T05:25:57Z' },
        { bucketId: 'gemini-unused', window: 'weekly', remainingFraction: 0.1, disabled: true },
      ],
    },
    // Wrong types: a fraction that is a string, a reset time that is a number
    { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: '0.9', resetTime: 7 }] },
  ]
  const narrowed = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2026-12-01T00:25:57Z', description: 'Your quota will fully refresh in 6 days.' },
          { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-11-24T05:25:57Z' },
          { bucketId: 'gemini-unused', window: 'weekly', remainingFraction: 0.1, disabled: true },
        ],
      },
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', window: 'weekly' }] },
    ],
  }

  it('keeps the pools and drops everything the service put around them', () => {
    const raw = { groups: pools, project: 'acct-project', user: { email: 'ACCT-HOLDER-MARKER' }, description: 'Quota summary.' }
    expect(narrowAntigravityQuota(raw)).toEqual(narrowed)
    expect(JSON.stringify(narrowAntigravityQuota(raw))).not.toContain('ACCT-HOLDER-MARKER')
  })

  it.each(['response', 'summary'])('flattens the %s envelope the other route answers with', (key) => {
    const kept = narrowAntigravityQuota({ [key]: { groups: pools, user: { email: 'ACCT-HOLDER-MARKER' } } })
    expect(kept).toEqual(narrowed)
  })

  it('answers null when there is no pool to keep', () => {
    for (const raw of [null, 'junk', {}, { groups: 'not a list' }, { response: { user: {} } }]) {
      expect(narrowAntigravityQuota(raw)).toBeNull()
    }
  })

  it('shows the card exactly what it showed before narrowing', () => {
    const body = JSON.stringify({ response: { groups: pools, user: { email: 'ACCT-HOLDER-MARKER' } } })
    const before = summarizeAntigravityQuota({ available: true, body })
    const after = summarizeAntigravityQuota({
      available: true,
      body: JSON.stringify(narrowAntigravityQuota(JSON.parse(body))),
    })
    expect({ ...after, fetchedAt: 0 }).toEqual({ ...before, fetchedAt: 0 })
    // And the card really had something to show, so this compared real content:
    // the first pool's disabled bucket is dropped on both sides alike
    expect(before.groups.map((group) => group.buckets.length)).toEqual([2, 1])
  })
})

describe('antigravityCardSpan', () => {
  it('gives a lone card with two model groups two tracks', () => {
    expect(antigravityCardSpan(1, true)).toBe(2)
  })

  it('keeps every other case on one track', () => {
    const cases = [
      [1, false],
      [2, true],
      [2, false],
      [3, true],
      [0, true],
    ] as const
    for (const [shown, twoGroups] of cases) {
      expect(antigravityCardSpan(shown, twoGroups), `${shown} shown / two groups: ${twoGroups}`).toBe(1)
    }
  })
})
