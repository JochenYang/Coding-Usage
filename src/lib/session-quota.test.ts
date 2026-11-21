import { describe, expect, it } from 'vitest'
import { summarizeSessionQuota } from './session-quota'

/**
 * View-model for the Cline Pass / JetBrains AI / Windsurf cards. The main
 * process already reduced the vendor payload to numbers; the parser checks
 * that shape and must keep a partial body unavailable instead of rendering 0%.
 */

const bodyOf = (windows: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ windows, ...extra })

describe('summarizeSessionQuota', () => {
  it('keeps known windows, clamps percentages and preserves resetsAt', () => {
    const vm = summarizeSessionQuota({
      available: true,
      body: bodyOf([
        { id: 'clineFiveHour', percent: 12.5, resetsAt: 1_800_000_000_000 },
        { id: 'windsurfFlow', percent: 110 },
        { id: 'jetbrainsMonthly', percent: -4 },
      ]),
    })
    expect(vm.available).toBe(true)
    expect(vm.reason).toBeNull()
    expect(vm.windows).toEqual([
      { id: 'clineFiveHour', percent: 12.5, resetsAt: 1_800_000_000_000 },
      { id: 'windsurfFlow', percent: 100, resetsAt: null },
      { id: 'jetbrainsMonthly', percent: 0, resetsAt: null },
    ])
  })

  it('drops unknown window ids and unusable percentages', () => {
    const vm = summarizeSessionQuota({
      available: true,
      body: bodyOf([
        { id: 'notAWindow', percent: 50 },
        { id: 'kiroMonthly' },
        { id: 'kiroMonthly', percent: Number.NaN },
        'garbage',
        { id: 'windsurfDaily', percent: 8 },
      ]),
    })
    expect(vm.windows).toEqual([{ id: 'windsurfDaily', percent: 8, resetsAt: null }])
  })

  it('trims the plan name and caps it at 80 chars', () => {
    const vm = summarizeSessionQuota({
      available: true,
      body: bodyOf([{ id: 'clineFiveHour', percent: 1 }], { plan: '  Cline Pass  ' }),
    })
    expect(vm.plan).toBe('Cline Pass')
    const long = summarizeSessionQuota({
      available: true,
      body: bodyOf([{ id: 'clineFiveHour', percent: 1 }], { plan: 'p'.repeat(200) }),
    })
    expect(long.plan).toHaveLength(80)
  })

  it('keeps a valid topUpCredits alone as a usable payload', () => {
    const vm = summarizeSessionQuota({
      available: true,
      body: JSON.stringify({ topUpCredits: 120, plan: 'JetBrains AI' }),
    })
    expect(vm.available).toBe(true)
    expect(vm.windows).toEqual([])
    expect(vm.topUpCredits).toBe(120)
    expect(vm.plan).toBe('JetBrains AI')
    expect(vm.stale).toBe(false)
  })

  it('rejects a negative or non-numeric topUpCredits', () => {
    const noTopUp = summarizeSessionQuota({
      available: true,
      body: JSON.stringify({ topUpCredits: -1 }),
    })
    // Nothing usable: parse-failed, not a fabricated 0%
    expect(noTopUp.available).toBe(false)
    expect(noTopUp.reason).toBe('parse-failed')
    expect(noTopUp.topUpCredits).toBeUndefined()
    expect(
      summarizeSessionQuota({ available: true, body: JSON.stringify({ topUpCredits: 'x' }) }).topUpCredits,
    ).toBeUndefined()
  })

  it('carries the stale flag only as an explicit true', () => {
    const stale = summarizeSessionQuota({
      available: true,
      body: bodyOf([{ id: 'windsurfDaily', percent: 1 }], { stale: true }),
    })
    expect(stale.stale).toBe(true)
    const absent = summarizeSessionQuota({
      available: true,
      body: bodyOf([{ id: 'windsurfDaily', percent: 1 }]),
    })
    expect(absent.stale).toBe(false)
  })

  it('maps malformed shapes to parse-failed and keeps the probe detail', () => {
    // Every parse-failed path reports the probe detail, not just the
    // emptied-payload one
    for (const body of ['not json', 'null', '42', '"text"', '{"windows":"no"}']) {
      expect(summarizeSessionQuota({ available: true, body, detail: 'counts=3' })).toMatchObject({
        available: false,
        reason: 'parse-failed',
        detail: 'counts=3',
      })
    }
  })

  it('passes the unavailable reason and detail through untouched', () => {
    expect(summarizeSessionQuota({ available: false, reason: 'no-auth', detail: 'flags=1' })).toMatchObject({
      available: false,
      reason: 'no-auth',
      detail: 'flags=1',
      plan: null,
      windows: [],
      fetchedAt: null,
    })
    // A missing reason stays null instead of becoming a label
    expect(summarizeSessionQuota({ available: false }).reason).toBeNull()
  })
})
