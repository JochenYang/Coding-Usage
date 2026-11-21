import { describe, expect, it } from 'vitest'
import { summarizeGrokQuota } from './grok-quota'

/**
 * Grok subscription quota view-model. The main process normalizes the billing
 * endpoint to {percent, resetsAt, plan}; the parser validates that shape
 * and must never throw or fabricate a usable reading from a partial body.
 */

describe('summarizeGrokQuota', () => {
  it('parses a full payload with clamping and field narrowing', () => {
    const vm = summarizeGrokQuota({
      available: true,
      body: JSON.stringify({
        percent: 42,
        resetsAt: 1_800_000_000_000,
        plan: 'SuperGrok Heavy',
        remainingResets: 3,
        resetsExpireAt: 1_900_000_000_000,
      }),
    })
    expect(vm.available).toBe(true)
    expect(vm.reason).toBeNull()
    expect(vm.percent).toBe(42)
    expect(vm.resetsAt).toBe(1_800_000_000_000)
    expect(vm.plan).toBe('SuperGrok Heavy')
    expect(vm.remainingResets).toBe(3)
    expect(vm.resetsExpireAt).toBe(1_900_000_000_000)
    expect(typeof vm.fetchedAt).toBe('number')
  })

  it('clamps the percentage into 0-100', () => {
    expect(summarizeGrokQuota({ available: true, body: '{"percent":150}' }).percent).toBe(100)
    expect(summarizeGrokQuota({ available: true, body: '{"percent":-5}' }).percent).toBe(0)
  })

  it('degrades optional fields to null instead of inventing values', () => {
    const vm = summarizeGrokQuota({ available: true, body: '{"percent":10,"resetsAt":"soon","plan":""}' })
    expect(vm.available).toBe(true)
    expect(vm.resetsAt).toBeNull()
    expect(vm.plan).toBeNull()
    expect(vm.remainingResets).toBeNull()
    expect(vm.resetsExpireAt).toBeNull()
  })

  it('rejects a body without a usable percentage as malformed', () => {
    for (const body of ['{}', '{"percent":"42"}', '{"percent":null}']) {
      expect(summarizeGrokQuota({ available: true, body })).toMatchObject({
        available: false,
        reason: 'malformed-body',
        percent: 0,
        fetchedAt: null,
      })
    }
  })

  it('maps an unparsable body to bad-response', () => {
    expect(summarizeGrokQuota({ available: true, body: '<html>' })).toMatchObject({
      available: false,
      reason: 'bad-response',
      percent: 0,
      fetchedAt: null,
    })
  })

  it('passes the unavailable reason through untouched', () => {
    expect(summarizeGrokQuota({ available: false, reason: 'no-auth' })).toEqual({
      available: false,
      reason: 'no-auth',
      percent: 0,
      resetsAt: null,
      plan: null,
      remainingResets: null,
      resetsExpireAt: null,
      fetchedAt: null,
    })
    // No reason at all stays null rather than becoming a fake label
    expect(summarizeGrokQuota({ available: false }).reason).toBeNull()
    // An available flag without a body is not a usable reading either
    expect(summarizeGrokQuota({ available: true })).toMatchObject({ available: false, reason: null })
  })
})
