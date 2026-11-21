import { describe, expect, it } from 'vitest'
import {
  fetchCodexResetCredits,
  mergeCodexResetCredits,
  resetCreditsFromPayload,
  type CodexResetCredits,
} from './codex-reset-credits'

/**
 * The banked-reset companion read is an enhancement over the usage endpoint's
 * own `rate_limit_reset_credits.available_count`, so the tests pin the two
 * rules that make it safe to fail: the usage count is never overwritten, and
 * any failure leaves the narrowed body exactly as it was. The redemption id
 * (`credits[].id`) is the handle that spends a reset — it must not survive.
 */

const RESET_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'

describe('resetCreditsFromPayload', () => {
  it('takes the count and the earliest expiry among available credits', () => {
    const reset = resetCreditsFromPayload({
      available_count: 2,
      credits: [
        { id: 'reset-id-1', status: 'available', expires_at: '2026-12-10T00:00:00.000Z' },
        { id: 'reset-id-2', status: 'available', expires_at: '2026-12-01T00:00:00.000Z' },
        { status: 'available', expires_at: 1_800_000_000 },
      ],
    })
    expect(reset).toEqual({
      availableCount: 2,
      earliestExpiryMs: Date.parse('2026-12-01T00:00:00.000Z'),
    })
  })

  it('ignores spent and expired rows so their earlier expiry cannot win', () => {
    const reset = resetCreditsFromPayload({
      available_count: 1,
      credits: [
        { status: 'spent', expires_at: '2026-01-01T00:00:00.000Z' },
        { status: 'available', expires_at: '2026-12-01T00:00:00.000Z' },
      ],
    })
    expect(reset?.earliestExpiryMs).toBe(Date.parse('2026-12-01T00:00:00.000Z'))
  })

  it('reads a count sent as a string and tolerates a missing credits list', () => {
    expect(resetCreditsFromPayload({ available_count: '3' })).toEqual({
      availableCount: 3,
      earliestExpiryMs: null,
    })
  })

  it('fails closed on a zero, negative, missing or non-numeric count', () => {
    expect(resetCreditsFromPayload({ available_count: 0, credits: [] })).toBeNull()
    expect(resetCreditsFromPayload({ available_count: -1 })).toBeNull()
    expect(resetCreditsFromPayload({ credits: [] })).toBeNull()
    expect(resetCreditsFromPayload({ available_count: 'many' })).toBeNull()
    expect(resetCreditsFromPayload(null)).toBeNull()
    expect(resetCreditsFromPayload('nope')).toBeNull()
  })

  it('drops an implausible or unparsable expiry instead of inventing one', () => {
    expect(resetCreditsFromPayload({ available_count: 1, credits: [{ expires_at: 'soon' }] })).toEqual({
      availableCount: 1,
      earliestExpiryMs: null,
    })
  })
})

describe('mergeCodexResetCredits', () => {
  const reset: CodexResetCredits = { availableCount: 5, earliestExpiryMs: 1_800_000_000_000 }

  it('never overwrites the count the usage response supplied', () => {
    const narrowed = { rate_limit_reset_credits: { available_count: 2 } }
    const merged = mergeCodexResetCredits(narrowed, reset)
    expect(merged.rate_limit_reset_credits).toEqual({ available_count: 2, expiresAtMs: 1_800_000_000_000 })
  })

  it('treats a stringified count as present so the companion cannot win', () => {
    // proto-JSON commonly stringifies counters: usage "0" + companion 5 must
    // still show 0, not the stale companion value
    const narrowed = { rate_limit_reset_credits: { available_count: '0' } }
    const merged = mergeCodexResetCredits(narrowed, reset)
    expect(merged.rate_limit_reset_credits).toEqual({ available_count: '0', expiresAtMs: 1_800_000_000_000 })
  })

  it('fills in the count only when the usage response said nothing', () => {
    const merged = mergeCodexResetCredits({ plan_type: 'pro' }, reset)
    expect(merged.rate_limit_reset_credits).toEqual({ available_count: 5, expiresAtMs: 1_800_000_000_000 })
    expect(merged.plan_type).toBe('pro')
  })

  it('returns the narrowed body unchanged when the companion read failed', () => {
    const narrowed = { rate_limit_reset_credits: { available_count: 2 } }
    expect(mergeCodexResetCredits(narrowed, null)).toBe(narrowed)
    const empty = mergeCodexResetCredits({ plan_type: 'pro' }, null)
    expect(empty).toEqual({ plan_type: 'pro' })
    expect(empty).not.toHaveProperty('rate_limit_reset_credits')
  })

  it('adds nothing when there is no expiry to attach and the count already exists', () => {
    const narrowed = { rate_limit_reset_credits: { available_count: 2 } }
    const merged = mergeCodexResetCredits(narrowed, { availableCount: 5, earliestExpiryMs: null })
    expect(merged).toBe(narrowed)
  })
})

describe('fetchCodexResetCredits', () => {
  it('reuses the caller headers on the companion GET', async () => {
    let seenUrl = ''
    let seenHeaders: Headers | null = null
    const outcome = await fetchCodexResetCredits(
      async (url, init) => {
        seenUrl = String(url)
        seenHeaders = new Headers(init.headers)
        return new Response(JSON.stringify({ available_count: 1, credits: [] }), { status: 200 })
      },
      { Authorization: 'Bearer secret-token', 'ChatGPT-Account-Id': 'acct-1' },
    )
    expect(seenUrl).toBe(RESET_URL)
    expect(seenHeaders!.get('authorization')).toBe('Bearer secret-token')
    expect(seenHeaders!.get('chatgpt-account-id')).toBe('acct-1')
    expect(outcome).toEqual({ availableCount: 1, earliestExpiryMs: null })
  })

  it('degrades silently on an http error, a bad body and a transport failure', async () => {
    const headers = { Authorization: 'Bearer secret-token' }
    expect(await fetchCodexResetCredits(async () => new Response('no', { status: 403 }), headers)).toBeNull()
    expect(await fetchCodexResetCredits(async () => new Response('not json', { status: 200 }), headers)).toBeNull()
    expect(
      await fetchCodexResetCredits(async () => new Response('{"available_count":0}', { status: 200 }), headers),
    ).toBeNull()
    expect(
      await fetchCodexResetCredits(
        async () => {
          throw new Error('network down')
        },
        headers,
      ),
    ).toBeNull()
  })
})
