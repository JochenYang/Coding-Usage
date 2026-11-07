import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { narrowQoderUsage, qoderUserDataDir } from './qoder-quota'

/**
 * The endpoint's schema is undocumented, so the narrowing function is the whole
 * contract: it must either produce honest numbers or refuse to produce any.
 * A guessed zero would show a full pool to an account that has spent it.
 */
describe('qoderUserDataDir', () => {
  it('resolves the IDE userData directory under appData', () => {
    // The directory name belongs to Qoder, not to this app; a wrong level finds
    // no login and the card silently reports "no login".
    expect(qoderUserDataDir('/appdata')).toBe(join('/appdata', 'com.qoder.app.stable'))
  })
})

describe('narrowQoderUsage', () => {
  it('reads the add-on pool, the vendor percentage and the account tier', () => {
    const out = narrowQoderUsage({
      displayMode: 'qoder',
      qoderUsage: {
        userType: 'personal_standard',
        usageType: 'credits',
        totalUsagePercentage: 0.5,
        isQuotaExceeded: false,
        userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
        addOnQuota: { total: 200, used: 100, remaining: 100, percentage: 0.5, unit: 'credits' },
      },
    })
    expect(out).toMatchObject({
      available: true,
      used: 100,
      total: 200,
      remaining: 100,
      percent: 50,
      isQuotaExceeded: false,
      userType: 'personal_standard',
      unit: 'credits',
    })
  })

  it('prefers the pool that carries a size and derives the percentage from it', () => {
    const out = narrowQoderUsage({
      qoderUsage: { userQuota: { total: 40, used: 10 }, addOnQuota: { total: 0, used: 0 } },
    })
    expect(out).toMatchObject({ available: true, used: 10, total: 40, percent: 25 })
  })

  it('derives the percentage from the same pool as the numbers', () => {
    // The vendor's account-level percentage can be 0 while a purchased add-on
    // pool is half spent (and it is computed over every pool, so pairing it with
    // one pool's figures is what produces "100 / 200 credits at 0%").
    const out = narrowQoderUsage({
      qoderUsage: {
        totalUsagePercentage: 0,
        userQuota: { total: 0, used: 0, unit: 'credits' },
        addOnQuota: { total: 200, used: 100, unit: 'credits' },
      },
    })
    expect(out).toMatchObject({ available: true, used: 100, total: 200, percent: 50 })
  })

  it('falls back to the vendor percentage only when no pool carries a size', () => {
    const out = narrowQoderUsage({ qoderUsage: { totalUsagePercentage: 0.3, userQuota: { total: 0, used: 0 } } })
    expect(out).toMatchObject({ available: true, percent: 30 })
    expect(out.used).toBeUndefined()
  })

  it('refuses to guess when the response carries no quota at all', () => {
    expect(narrowQoderUsage({})).toEqual({ available: false, reason: 'malformed-response' })
    expect(narrowQoderUsage({ qoderUsage: {} })).toEqual({ available: false, reason: 'no-quota' })
    expect(narrowQoderUsage(null)).toEqual({ available: false, reason: 'malformed-response' })
  })

  it('clamps a percentage the vendor reports outside 0-100', () => {
    const out = narrowQoderUsage({
      qoderUsage: { totalUsagePercentage: 1.4, addOnQuota: { total: 10, used: 14 } },
    })
    expect(out.percent).toBe(100)
  })
})
