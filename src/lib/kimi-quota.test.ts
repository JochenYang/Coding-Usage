import { describe, expect, it } from 'vitest'
import { summarizeKimiQuota } from './kimi-quota'

/**
 * Kimi Code subscription quota view-model. Numbers are percentages of the plan
 * allowance (never re-derived from used/limit). The window id arrives explicitly
 * and unknown ids downgrade to 'other' so a new upstream window still surfaces
 * instead of vanishing; the display order is part of the contract.
 */

const bodyOf = (windows: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ windows, ...extra })

describe('summarizeKimiQuota', () => {
  it('sorts windows into the canonical order regardless of payload order', () => {
    const vm = summarizeKimiQuota({
      available: true,
      body: bodyOf(
        [
          { id: 'monthCode', percent: 4, resetsAt: 4 },
          { id: 'weekly', percent: 2, resetsAt: 2 },
          { id: 'other', percent: 5 },
          { id: 'fiveHour', percent: 1, resetsAt: 1 },
          { id: 'monthTotal', percent: 3 },
        ],
        { source: 'local-server' },
      ),
    })
    expect(vm.available).toBe(true)
    expect(vm.source).toBe('local-server')
    expect(vm.windows.map((w) => w.id)).toEqual(['fiveHour', 'weekly', 'monthTotal', 'monthCode', 'other'])
    expect(vm.windows.map((w) => w.percent)).toEqual([1, 2, 3, 4, 5])
    expect(vm.fetchedAt).not.toBeNull()
  })

  it('downgrades an unknown window id to other and clamps percentages', () => {
    const vm = summarizeKimiQuota({
      available: true,
      body: bodyOf([
        { id: 'brandNewWindow', percent: 250 },
        { id: 'fiveHour', percent: -3 },
      ]),
    })
    expect(vm.available).toBe(true)
    expect(vm.windows).toEqual([
      { id: 'fiveHour', percent: 0, resetsAt: null },
      { id: 'other', percent: 100, resetsAt: null },
    ])
  })

  it('drops windows without a finite percentage instead of fabricating zero', () => {
    const vm = summarizeKimiQuota({
      available: true,
      body: bodyOf([
        { id: 'fiveHour' },
        { id: 'weekly', percent: Number.NaN },
        'not-an-object',
        { id: 'monthTotal', percent: 7 },
      ]),
    })
    expect(vm.windows).toEqual([{ id: 'monthTotal', percent: 7, resetsAt: null }])
  })

  it('keeps a non-finite resetsAt as null', () => {
    const vm = summarizeKimiQuota({
      available: true,
      body: bodyOf([{ id: 'fiveHour', percent: 5, resetsAt: 'soon' }]),
    })
    expect(vm.windows[0]?.resetsAt).toBeNull()
  })

  it('parses the booster wallet with independent field degradation', () => {
    const full = summarizeKimiQuota({
      available: true,
      body: bodyOf([{ id: 'fiveHour', percent: 1 }], {
        wallet: { remaining: 12.5, total: 100, used: 87.5, currency: ' CNY ' },
      }),
    })
    expect(full.wallet).toEqual({ remaining: 12.5, total: 100, used: 87.5, currency: 'CNY' })

    const partial = summarizeKimiQuota({
      available: true,
      body: bodyOf([{ id: 'fiveHour', percent: 1 }], { wallet: { remaining: 3, total: 'x', currency: 42 } }),
    })
    expect(partial.wallet).toEqual({ remaining: 3, total: null, used: null, currency: null })

    // A wallet with no usable amount is dropped entirely
    const empty = summarizeKimiQuota({
      available: true,
      body: bodyOf([{ id: 'fiveHour', percent: 1 }], { wallet: { currency: 'CNY' } }),
    })
    expect(empty.wallet).toBeNull()
  })

  it('maps every malformed shape to the honest unavailable view', () => {
    for (const body of ['not json', 'null', '42', '"text"', '{"windows":"no"}', '{"windows":[]}']) {
      expect(summarizeKimiQuota({ available: true, body })).toEqual({
        available: false,
        reason: body === 'not json' ? 'bad-response' : 'malformed-body',
        windows: [],
        wallet: null,
        source: null,
        fetchedAt: null,
      })
    }
  })

  it('passes the unavailable reason through and never throws on an untrusted reply', () => {
    expect(summarizeKimiQuota({ available: false, reason: 'http-401' })).toEqual({
      available: false,
      reason: 'http-401',
      windows: [],
      wallet: null,
      source: null,
      fetchedAt: null,
    })
    // The declared type is non-null, but the value crosses IPC untrusted
    expect(summarizeKimiQuota(null as unknown as { available: boolean }).available).toBe(false)
    expect(summarizeKimiQuota('garbage' as unknown as { available: boolean }).reason).toBeNull()
    // A non-string source is dropped rather than stringified into a label
    expect(
      summarizeKimiQuota({ available: true, body: bodyOf([{ id: 'fiveHour', percent: 1 }], { source: 42 }) }).source,
    ).toBeNull()
  })
})
