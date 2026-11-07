import { describe, expect, it } from 'vitest'
import { summarizeQoderQuota } from './qoder-quota'

/**
 * The card renders whatever this returns, so the guard is what keeps a malformed
 * or absent payload from becoming a fake "0% used" bar.
 */
describe('summarizeQoderQuota', () => {
  it('maps a successful payload and keeps the vendor unit', () => {
    const vm = summarizeQoderQuota({
      available: true,
      used: 100,
      total: 200,
      remaining: 100,
      percent: 50,
      isQuotaExceeded: false,
      userType: 'personal_standard',
      unit: 'credits',
      fetchedAt: 1_700_000_000_000,
    })
    expect(vm).toMatchObject({
      available: true,
      reason: null,
      percent: 50,
      used: 100,
      total: 200,
      remaining: 100,
      exhausted: false,
      userType: 'personal_standard',
      unit: 'credits',
    })
  })

  it('treats a missing or unavailable payload as unavailable with its reason', () => {
    expect(summarizeQoderQuota(null)).toMatchObject({ available: false, reason: null, percent: 0 })
    expect(summarizeQoderQuota({ available: false, reason: 'no-login' })).toMatchObject({
      available: false,
      reason: 'no-login',
    })
  })

  it('clamps the percentage and defaults the unit', () => {
    expect(summarizeQoderQuota({ available: true, percent: -5 })).toMatchObject({ percent: 0, unit: 'credits' })
    expect(summarizeQoderQuota({ available: true, percent: 140 })).toMatchObject({ percent: 100 })
  })
})
