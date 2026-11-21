import { describe, expect, it } from 'vitest'
import { summarizeGeminiQuota } from './gemini-quota'

/**
 * Gemini Code Assist quota view-model. Buckets arrive verbatim from the
 * official endpoint and are folded into the three model classes; flash-lite
 * must classify before flash (its id contains "flash"), the tightest fraction
 * wins per class, and percent is the inversion of remainingFraction.
 */

describe('summarizeGeminiQuota', () => {
  it('classifies buckets into pro / flash / flashLite in display order', () => {
    const vm = summarizeGeminiQuota({
      available: true,
      body: JSON.stringify({
        buckets: [
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.7 },
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.2 },
          { modelId: 'gemini-2.5-flash-lite', remainingFraction: 0.9 },
        ],
      }),
    })
    expect(vm.available).toBe(true)
    expect(vm.reason).toBeNull()
    expect(vm.groups.map((g) => g.id)).toEqual(['pro', 'flash', 'flashLite'])
    // percent = (1 - fraction) * 100; keep the float-tolerant comparison
    expect(vm.groups.map((g) => g.percent)[0]).toBeCloseTo(80, 10)
    expect(vm.groups.map((g) => g.percent)[1]).toBeCloseTo(30, 10)
    expect(vm.groups.map((g) => g.percent)[2]).toBeCloseTo(10, 10)
    expect(typeof vm.fetchedAt).toBe('number')
  })

  it('shows the tightest bucket per class when the endpoint repeats one', () => {
    const vm = summarizeGeminiQuota({
      available: true,
      body: JSON.stringify({
        buckets: [
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.5 },
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.1 },
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.3 },
        ],
      }),
    })
    expect(vm.groups).toEqual([
      { id: 'pro', percent: 90, resetsAt: null },
      { id: 'flash', percent: 70, resetsAt: null },
    ])
  })

  it('parses resetTime into ms and keeps an unparsable stamp as null', () => {
    const vm = summarizeGeminiQuota({
      available: true,
      body: JSON.stringify({
        buckets: [
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.5, resetTime: '2026-11-22T00:00:00Z' },
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.3, resetTime: 'not-a-date' },
        ],
      }),
    })
    expect(vm.groups[0]?.resetsAt).toBe(Date.parse('2026-11-22T00:00:00Z'))
    expect(vm.groups[1]?.resetsAt).toBeNull()
  })

  it('clamps fractions into 0-1 before inverting', () => {
    const vm = summarizeGeminiQuota({
      available: true,
      body: JSON.stringify({
        buckets: [
          { modelId: 'gemini-2.5-pro', remainingFraction: 1.5 },
          { modelId: 'gemini-2.5-flash', remainingFraction: -0.5 },
        ],
      }),
    })
    expect(vm.groups).toEqual([
      { id: 'pro', percent: 0, resetsAt: null },
      { id: 'flash', percent: 100, resetsAt: null },
    ])
  })

  it('ignores buckets it cannot classify or cannot read', () => {
    const vm = summarizeGeminiQuota({
      available: true,
      body: JSON.stringify({
        buckets: [
          'garbage',
          null,
          {},
          { modelId: 42, remainingFraction: 0.5 },
          { modelId: 'gemini-2.5-pro' },
          { modelId: 'gemini-2.5-pro', remainingFraction: Number.NaN },
          { modelId: 'unknown-model', remainingFraction: 0.5 },
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.4 },
        ],
      }),
    })
    expect(vm.groups).toEqual([{ id: 'pro', percent: 60, resetsAt: null }])
  })

  it('maps no usable buckets to malformed-body and an unparsable body to bad-response', () => {
    // An empty fold still stamps fetchedAt (the parse itself succeeded)
    expect(summarizeGeminiQuota({ available: true, body: '{"buckets":[]}' })).toMatchObject({
      available: false,
      reason: 'malformed-body',
      groups: [],
    })
    expect(summarizeGeminiQuota({ available: true, body: '{}' })).toMatchObject({
      available: false,
      reason: 'malformed-body',
    })
    expect(summarizeGeminiQuota({ available: true, body: '<html>' })).toEqual({
      available: false,
      reason: 'bad-response',
      groups: [],
      fetchedAt: null,
    })
  })

  it('passes the unavailable reason through untouched', () => {
    expect(summarizeGeminiQuota({ available: false, reason: 'no-auth-file' })).toEqual({
      available: false,
      reason: 'no-auth-file',
      groups: [],
      fetchedAt: null,
    })
    expect(summarizeGeminiQuota({ available: false }).reason).toBeNull()
  })
})
