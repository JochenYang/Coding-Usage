import { describe, expect, it } from 'vitest'
import { summarizeTraeQuota } from './trae-quota'

/**
 * Trae CN credits view-model. The main process decrypts the local login and
 * normalizes the credits endpoint to {percent, consumed, total, resetsAt,
 * plan, packs}; the parser validates that shape and keeps a partial body
 * unavailable instead of turning it into 0%.
 */

describe('summarizeTraeQuota', () => {
  it('parses the full payload including packs', () => {
    const vm = summarizeTraeQuota({
      available: true,
      body: JSON.stringify({
        percent: 64,
        consumed: 320,
        total: 500,
        resetsAt: 1_800_000_000_000,
        plan: 'Pro',
        packs: [
          { name: 'monthly bonus', credits: 50, resetsAt: 1_900_000_000_000 },
          { name: 'free tier', credits: null, resetsAt: null },
        ],
      }),
    })
    expect(vm.available).toBe(true)
    expect(vm.reason).toBeNull()
    expect(vm.percent).toBe(64)
    expect(vm.consumed).toBe(320)
    expect(vm.total).toBe(500)
    expect(vm.resetsAt).toBe(1_800_000_000_000)
    expect(vm.plan).toBe('Pro')
    expect(vm.packs).toEqual([
      { name: 'monthly bonus', credits: 50, resetsAt: 1_900_000_000_000 },
      { name: 'free tier', credits: null, resetsAt: null },
    ])
    expect(typeof vm.fetchedAt).toBe('number')
  })

  it('clamps the percentage and drops unusable packs', () => {
    const vm = summarizeTraeQuota({
      available: true,
      body: JSON.stringify({
        percent: 150,
        consumed: 1,
        total: 2,
        packs: [null, 42, {}, { name: '' }, { name: 'ok', credits: 'x' }],
      }),
    })
    expect(vm.percent).toBe(100)
    expect(vm.packs).toEqual([{ name: 'ok', credits: null, resetsAt: null }])
  })

  it('treats a non-array packs field as no packs', () => {
    const vm = summarizeTraeQuota({
      available: true,
      body: JSON.stringify({ percent: 1, consumed: 0, total: 10, packs: 'nope' }),
    })
    expect(vm.packs).toEqual([])
  })

  it('rejects a body missing any of the three core numbers as malformed', () => {
    for (const body of [
      '{}',
      '{"percent":1}',
      '{"percent":1,"consumed":2}',
      '{"percent":"1","consumed":2,"total":3}',
    ]) {
      expect(summarizeTraeQuota({ available: true, body })).toMatchObject({
        available: false,
        reason: 'malformed-body',
        percent: 0,
        consumed: 0,
        total: 0,
        packs: [],
        fetchedAt: null,
      })
    }
  })

  it('maps an unparsable body to bad-response', () => {
    expect(summarizeTraeQuota({ available: true, body: '<html>' })).toMatchObject({
      available: false,
      reason: 'bad-response',
    })
  })

  it('passes the unavailable reason through with a default label', () => {
    expect(summarizeTraeQuota({ available: false, reason: 'no-auth' })).toMatchObject({
      available: false,
      reason: 'no-auth',
    })
    // No reason at all falls back to the honest generic label
    expect(summarizeTraeQuota({ available: false }).reason).toBe('unavailable')
    expect(summarizeTraeQuota({ available: true })).toMatchObject({ available: false, reason: 'unavailable' })
  })
})
