import { describe, expect, it } from 'vitest'
import { summarizeCopilotQuota, summarizeCursorQuota } from './local-plan-quota'

describe('summarizeCursorQuota', () => {
  it('reads the three used-percentage windows and the cycle end', () => {
    const vm = summarizeCursorQuota({
      available: true,
      body: JSON.stringify({
        is_unlimited: false,
        billing_cycle_end: '2026-11-20T00:00:00Z',
        individual_usage: { plan: { total_percent_used: 37, auto_percent_used: 12, api_percent_used: 64 } },
      }),
    })
    expect(vm.available).toBe(true)
    expect(vm.windows.map((w) => [w.id, w.percent])).toEqual([
      ['cursorTotal', 37],
      ['cursorAuto', 12],
      ['cursorApi', 64],
    ])
    expect(vm.windows[0].resetsAt).toBe(Date.parse('2026-11-20T00:00:00Z'))
  })

  it('keeps an unlimited plan at 0% instead of inventing an exhausted one', () => {
    const vm = summarizeCursorQuota({
      available: true,
      body: JSON.stringify({
        is_unlimited: true,
        individual_usage: { plan: { total_percent_used: 100 } },
      }),
    })
    expect(vm.windows[0].percent).toBe(0)
  })

  it('passes the probe reason through when the login is missing or sealed', () => {
    expect(summarizeCursorQuota({ available: false, reason: 'sealed-token' })).toMatchObject({
      available: false,
      reason: 'sealed-token',
      windows: [],
    })
    expect(summarizeCursorQuota({ available: false, reason: 'no-login' }).reason).toBe('no-login')
  })

  it('degrades a payload without windows rather than rendering an empty card', () => {
    expect(summarizeCursorQuota({ available: true, body: '{}' }).reason).toBe('no-windows')
    expect(summarizeCursorQuota({ available: true, body: 'not json' }).reason).toBe('bad-response')
  })
})

describe('summarizeCopilotQuota', () => {
  it('inverts percent_remaining into used percentages exactly once', () => {
    const vm = summarizeCopilotQuota({
      available: true,
      body: JSON.stringify({
        copilot_plan: 'individual',
        quota_reset_date: '2026-12-01T00:00:00Z',
        quota_snapshots: { premium_interactions: { percent_remaining: 76 }, chat: { percent_remaining: 100 } },
      }),
    })
    expect(vm.plan).toBe('individual')
    expect(vm.windows.map((w) => [w.id, w.percent])).toEqual([
      ['copilotPremium', 24],
      ['copilotChat', 0],
    ])
    expect(vm.windows[0].resetsAt).toBe(Date.parse('2026-12-01T00:00:00Z'))
  })

  it('clamps a nonsensical remaining value instead of showing a negative gauge', () => {
    const vm = summarizeCopilotQuota({
      available: true,
      body: JSON.stringify({ quota_snapshots: { premium_interactions: { percent_remaining: 130 } } }),
    })
    expect(vm.windows[0].percent).toBe(0)
  })

  it('reports no windows when the account has no quota snapshots', () => {
    expect(summarizeCopilotQuota({ available: true, body: '{"copilot_plan":"business"}' }).reason).toBe('no-windows')
  })
})
