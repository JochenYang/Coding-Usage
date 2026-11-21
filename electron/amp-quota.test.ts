import { describe, expect, it } from 'vitest'
import { bodyFromAmpMeters, fetchAmpUsage, parseAmpUsageText, type AmpCliResult } from './amp-quota'

/**
 * The Amp probe reads the official CLI's own `amp usage` sheet, so every test
 * drives the parser and the fetch through the DI runner with captured output
 * (CodexBar issue #3171 documents the real sheet, including the bold-wrapped
 * labels a newer CLI build emits). No CLI is spawned and no network is hit.
 */

const NOW = 1_800_000_000_000

function cliResult(overrides: Partial<AmpCliResult> = {}): AmpCliResult {
  return { code: 0, out: '', err: '', missing: false, timedOut: false, ...overrides }
}

/** The sheet CodexBar's issue quotes for a Megawatt account, verbatim labels */
const MEGAWATT_SHEET = [
  'Signed in as user@example.com',
  '**Amp Free:** 0% remaining today (resets daily) - https://ampcode.com/settings',
  '**Amp Megawatt Subscription:** 68% other usage and 97% orb usage remaining - resets upon renewal in 5 days',
  '**Individual credits:** $3.23 remaining (set up auto-reload to avoid running out) - https://ampcode.com/settings',
  '# Run `amp usage --details` for more detailed information.',
  '',
].join('\n')

describe('parseAmpUsageText', () => {
  it('reads every meter of a bold-wrapped sheet by its label', () => {
    const meters = parseAmpUsageText(MEGAWATT_SHEET, NOW)
    expect(meters).toEqual({
      plan: 'Megawatt',
      freeRemainingPercent: 0,
      subscriptionOtherRemainingPercent: 68,
      subscriptionOrbRemainingPercent: 97,
      subscriptionResetsAt: NOW + 5 * 86_400_000,
      individualCreditsUsd: 3.23,
      workspaceCreditsUsd: null,
    })
  })

  it('reads the same sheet when the CLI stops bold-wrapping the labels', () => {
    const legacy = [
      'Amp Free: 48% remaining today (resets daily)',
      'Individual credits: $1,234.56 remaining',
    ].join('\n')
    expect(parseAmpUsageText(legacy, NOW)).toEqual({
      plan: null,
      freeRemainingPercent: 48,
      subscriptionOtherRemainingPercent: null,
      subscriptionOrbRemainingPercent: null,
      subscriptionResetsAt: null,
      individualCreditsUsd: 1234.56,
      workspaceCreditsUsd: null,
    })
  })

  it('tolerates ANSI escapes and stray bold markers around the meters', () => {
    const noisy = '\x1b[1m**Amp Free:**\x1b[0m 100% remaining today\n**Individual credits:** $0.00 remaining'
    const meters = parseAmpUsageText(noisy, NOW)
    expect(meters?.freeRemainingPercent).toBe(100)
    expect(meters?.individualCreditsUsd).toBe(0)
  })

  it('keeps the meters a drifted line loses instead of failing the sheet', () => {
    const drifted = [
      '**Amp Megawatt Subscription:** 68% of the pools remaining',
      '**Individual credits:** $3.23 remaining',
    ].join('\n')
    const meters = parseAmpUsageText(drifted, NOW)
    expect(meters).not.toBeNull()
    expect(meters?.plan).toBeNull()
    expect(meters?.subscriptionOtherRemainingPercent).toBeNull()
    expect(meters?.individualCreditsUsd).toBe(3.23)
  })

  it('caps a drifted plan label at the family plan-length bound', () => {
    const long = `Amp ${'x'.repeat(200)} Subscription: 10% other usage remaining`
    expect(parseAmpUsageText(long, NOW)?.plan).toBe('x'.repeat(80))
  })

  it('rejects a sheet with no meter at all', () => {
    expect(parseAmpUsageText('Signed in as user@example.com')).toBeNull()
    expect(parseAmpUsageText('')).toBeNull()
    expect(parseAmpUsageText('**Workspace credits:** $9.99 remaining')).not.toBeNull()
  })
})

describe('bodyFromAmpMeters', () => {
  it('inverts remaining percentages into consumed windows and carries the balances', () => {
    const meters = parseAmpUsageText(MEGAWATT_SHEET, NOW)!
    const body = JSON.parse(bodyFromAmpMeters(meters)) as {
      plan: unknown
      windows: Array<{ id: string; percent: number; resetsAt: number | null }>
      topUpCredits: unknown
      workspaceCredits: unknown
      stale: boolean
    }
    expect(body.plan).toBe('Megawatt')
    expect(body.windows).toEqual([
      { id: 'ampFree', percent: 100, resetsAt: null },
      { id: 'ampSubscriptionOther', percent: 32, resetsAt: NOW + 5 * 86_400_000 },
      { id: 'ampSubscriptionOrb', percent: 3, resetsAt: NOW + 5 * 86_400_000 },
    ])
    expect(body.topUpCredits).toBe(3.23)
    expect(body.workspaceCredits).toBeNull()
    expect(body.stale).toBe(false)
  })

  it('clamps a remaining figure above 100 instead of inverting it below zero', () => {
    const meters = parseAmpUsageText('Amp Free: 150% remaining today', NOW)!
    expect(meters?.freeRemainingPercent).toBe(100)
    expect(JSON.parse(bodyFromAmpMeters(meters)).windows).toEqual([
      { id: 'ampFree', percent: 0, resetsAt: null },
    ])
  })
})

describe('fetchAmpUsage', () => {
  it('returns no-auth when the CLI is not installed', async () => {
    const outcome = await fetchAmpUsage(async () => cliResult({ missing: true }))
    expect(outcome).toEqual({ available: false, reason: 'no-auth' })
  })

  it('maps a CLI that never finished in time to timeout', async () => {
    const outcome = await fetchAmpUsage(async () => cliResult({ timedOut: true, code: null }))
    expect(outcome).toEqual({ available: false, reason: 'timeout' })
  })

  it('returns parse-failed when the sheet carries no meter', async () => {
    const outcome = await fetchAmpUsage(async () => cliResult({ out: 'Signed in as user@example.com' }))
    expect(outcome).toEqual({ available: false, reason: 'parse-failed' })
  })

  it('accepts parseable output even when the CLI exited non-zero', async () => {
    const outcome = await fetchAmpUsage(async () => cliResult({ code: 1, out: '**Individual credits:** $3.23 remaining' }))
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body ?? '{}').topUpCredits).toBe(3.23)
  })

  it('returns numbers only — the signed-in address never reaches the body', async () => {
    const outcome = await fetchAmpUsage(async () => cliResult({ out: MEGAWATT_SHEET }))
    expect(outcome.available).toBe(true)
    expect(outcome.body).not.toContain('user@example.com')
    expect(outcome.body).not.toContain('https://ampcode.com')
    const body = JSON.parse(outcome.body ?? '{}') as { windows: unknown[]; plan: unknown }
    expect(body.windows).toHaveLength(3)
    expect(body.plan).toBe('Megawatt')
  })

  it('maps a runner that throws to probe-failed', async () => {
    const outcome = await fetchAmpUsage(async () => {
      throw new Error('runner exploded')
    })
    expect(outcome).toEqual({ available: false, reason: 'probe-failed' })
  })
})
