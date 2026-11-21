import { describe, expect, it } from 'vitest'
import { summarizeOpendesignQuota } from './opendesign-quota'

describe('summarizeOpendesignQuota', () => {
  it('parses windows and the wallet enhancement, clamping percentages', () => {
    const vm = summarizeOpendesignQuota({
      available: true,
      body: JSON.stringify({
        plan: null,
        windows: [
          { id: 'fiveHour', percent: 250, resetsAt: null },
          { id: 'weekly', percent: 40.5, resetsAt: 1_800_000_000_000 },
        ],
        walletUsd: 12.5,
      }),
    })
    expect(vm.available).toBe(true)
    expect(vm.reason).toBeNull()
    expect(vm.windows).toEqual([
      { id: 'fiveHour', percent: 100, resetsAt: null },
      { id: 'weekly', percent: 40.5, resetsAt: 1_800_000_000_000 },
    ])
    expect(vm.walletUsd).toBe(12.5)
    expect(vm.fetchedAt).not.toBeNull()
  })

  it('treats a missing wallet as absent and drops unknown window ids', () => {
    const vm = summarizeOpendesignQuota({
      available: true,
      body: JSON.stringify({ windows: [{ id: 'brandNewWindow', percent: 10 }, { id: 'weekly', percent: 5 }] }),
    })
    expect(vm.available).toBe(true)
    expect(vm.walletUsd).toBeNull()
    expect(vm.windows).toEqual([{ id: 'weekly', percent: 5, resetsAt: null }])
  })

  it('degrades to unavailable instead of painting a partial payload', () => {
    const malformed = summarizeOpendesignQuota({ available: true, body: '{"windows":"no"}' })
    expect(malformed).toMatchObject({ available: false, reason: 'malformed-body', windows: [], walletUsd: null })
    const empty = summarizeOpendesignQuota({ available: true, body: '{"windows":[]}' })
    expect(empty.available).toBe(false)
    const unparsable = summarizeOpendesignQuota({ available: true, body: 'not json' })
    expect(unparsable.reason).toBe('malformed-body')
  })

  it('passes the unavailable reason through untouched', () => {
    const vm = summarizeOpendesignQuota({ available: false, reason: 'reauth' })
    expect(vm).toEqual({
      available: false,
      reason: 'reauth',
      windows: [],
      walletUsd: null,
      fetchedAt: null,
    })
    // No reason at all stays null rather than becoming a fake label
    expect(summarizeOpendesignQuota({ available: false }).reason).toBeNull()
  })
})
