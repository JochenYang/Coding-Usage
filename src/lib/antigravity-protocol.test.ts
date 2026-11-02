import { describe, expect, it } from 'vitest'
import {
  antigravityUserAgent,
  hasQuotaGroups,
  quotaGroupsFromModels,
  type ModelQuota,
} from '../../electron/antigravity-quota'

/**
 * Regression: the Cloud Code quota endpoint decides how much to return from the
 * User-Agent's Antigravity version. A 1.x build string gets a summary with the
 * Gemini pool omitted, so the probe must identify as a current hub build and
 * must not mistake a bucket-less summary for a usable one.
 */
describe('antigravity quota protocol', () => {
  it('identifies as a current antigravity hub build', () => {
    expect(antigravityUserAgent('2.28.2')).toMatch(/^antigravity\/hub\/2\.28\.2 (win32|darwin|linux)\/(x64|arm64)$/)
  })

  it('rejects a summary whose groups carry no buckets', () => {
    expect(hasQuotaGroups(JSON.stringify({ groups: [] }))).toBe(false)
    expect(hasQuotaGroups(JSON.stringify({ groups: [{ displayName: 'Gemini Models', buckets: [] }] }))).toBe(false)
    expect(
      hasQuotaGroups(
        JSON.stringify({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h' }] }] }),
      ),
    ).toBe(true)
  })

  it('rebuilds the pools from per-model quotas, taking the tightest share', () => {
    const models = new Map<string, ModelQuota>([
      ['gemini-3-flash', { remaining: 0.4, resetsAt: '2026-11-02T06:00:00Z' }],
      ['gemini-3.1-pro', { remaining: 0.8, resetsAt: '2026-11-02T05:00:00Z' }],
      ['claude-sonnet-4-6', { remaining: 0.2, resetsAt: '' }],
      ['gpt-oss-120b-medium', { remaining: 0, resetsAt: '' }],
      ['gemini-disabled', { remaining: 1, resetsAt: '' }],
    ])
    const body = quotaGroupsFromModels(models) as {
      groups: { displayName: string; buckets: { bucketId: string; remainingFraction: number; resetTime?: string }[] }[]
    }

    expect(body.groups.map((g) => g.displayName)).toEqual(['Gemini Models', 'Claude and GPT models'])
    expect(body.groups[0].buckets[0]).toMatchObject({ bucketId: 'gemini-5h', remainingFraction: 0.4, resetTime: '2026-11-02T05:00:00Z' })
    expect(body.groups[1].buckets[0].remainingFraction).toBe(0)
  })
})
