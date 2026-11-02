import { describe, expect, it } from 'vitest'
import { summarizeCodexQuota } from './codex-quota'

/**
 * Shape taken from a live `wham/usage` response: the two rate-limit windows plus
 * the plan, credit balance, reset credits and personal spend cap. The extra
 * fields exist because a 0% window looks identical to an exhausted account.
 */
const LIVE = JSON.stringify({
  plan_type: 'free',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 2592000, reset_after_seconds: 2418019, reset_at: 1796039275 },
    secondary_window: null,
  },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: null },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 },
})

const ok = (body: string) => summarizeCodexQuota({ available: true, body })

describe('summarizeCodexQuota', () => {
  it('reads the window, plan and reset time from a live payload', () => {
    const vm = ok(LIVE)
    expect(vm.available).toBe(true)
    expect(vm.plan).toBe('free')
    expect(vm.primary).toMatchObject({ label: '30 天窗口', percent: 0, resetsAt: 1796039275000 })
    expect(vm.secondary).toBeNull()
    // Zero credits-available is not worth a row
    expect(vm.resetCredits).toBeNull()
    expect(vm.credits).toBeNull()
  })

  it('surfaces a pay-as-you-go balance and reset credits when present', () => {
    const vm = ok(
      JSON.stringify({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 61, limit_window_seconds: 18000, resets_at: '2026-11-02T12:00:00Z' } },
        credits: { unlimited: false, balance: 12.5 },
        rate_limit_reset_credits: { available_count: 2 },
      }),
    )
    expect(vm.primary).toMatchObject({ label: '5 小时窗口', percent: 61 })
    expect(vm.primary?.resetsAt).toBe(Date.parse('2026-11-02T12:00:00Z'))
    expect(vm.credits).toEqual({ unlimited: false, balance: 12.5 })
    expect(vm.resetCredits).toBe(2)
  })

  it('marks an unlimited credit plan so the card can say so', () => {
    const vm = ok(JSON.stringify({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } }, credits: { unlimited: true } }))
    expect(vm.credits).toEqual({ unlimited: true, balance: null })
  })

  it('reads a personal spend cap', () => {
    const vm = ok(
      JSON.stringify({
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } },
        spend_control: { reached: true, individual_limit: { used_percent: 100 } },
      }),
    )
    expect(vm.individualLimit).toEqual({ percent: 100, reached: true })
  })

  it('degrades to unavailable on a body without windows', () => {
    const vm = ok(JSON.stringify({ plan_type: 'free' }))
    expect(vm.available).toBe(false)
    expect(vm.reason).toBe('malformed-body')
    expect(vm.plan).toBe('free')
  })

  it('reports a bad response instead of throwing', () => {
    const vm = ok('not json')
    expect(vm.available).toBe(false)
    expect(vm.reason).toBe('bad-response')
  })
})
