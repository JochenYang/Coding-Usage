import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  apiKeyFromDotEnv,
  fetchFactoryQuota,
  planFromAuthPayload,
  windowFromBilling,
  windowsFromBillingLimits,
  windowsFromLegacyUsage,
} from './factory-quota'

const NOW = Date.parse('2026-11-21T00:00:00Z')

describe('Factory .env credential', () => {
  it('reads FACTORY_API_KEY with or without the export prefix and strips quotes', () => {
    expect(apiKeyFromDotEnv('FACTORY_API_KEY=fk-abc\n')).toBe('fk-abc')
    expect(apiKeyFromDotEnv('export FACTORY_API_KEY=fk-def\nOTHER_KEY=nope\n')).toBe('fk-def')
    expect(apiKeyFromDotEnv('FACTORY_API_KEY="fk-quoted"\n')).toBe('fk-quoted')
    expect(apiKeyFromDotEnv("FACTORY_API_KEY='fk-single'\n")).toBe('fk-single')
    expect(apiKeyFromDotEnv('FACTORY_API_KEY=\n')).toBeNull()
    expect(apiKeyFromDotEnv('FACTORY_API_KEY=fk-a\nfk-b\nFACTORY_API_KEY=fk-b\n')).toBe('fk-a')
  })

  it('rejects a value that could break the Authorization header', () => {
    expect(apiKeyFromDotEnv('FACTORY_API_KEY=fk\u0000-a\n')).toBeNull()
  })
})

describe('Factory billing windows', () => {
  it('prefers secondsRemaining and keeps an unstarted window without a reset', () => {
    const running = windowFromBilling({ usedPercent: 42, windowEnd: NOW / 1000 + 3600, secondsRemaining: 1800 }, NOW)
    expect(running).toEqual({ percent: 42, resetsAt: NOW + 1_800_000 })
    const unstarted = windowFromBilling({ usedPercent: 7, windowEnd: null }, NOW)
    expect(unstarted).toEqual({ percent: 7, resetsAt: null })
  })

  it('reads windowEnd as ISO, numeric string, seconds or milliseconds', () => {
    expect(windowFromBilling({ usedPercent: 1, windowEnd: '2026-11-21T01:00:00Z' }, NOW)?.resetsAt).toBe(
      Date.parse('2026-11-21T01:00:00Z'),
    )
    expect(windowFromBilling({ usedPercent: 1, windowEnd: String(NOW / 1000 + 60) }, NOW)?.resetsAt).toBe(NOW + 60_000)
    expect(windowFromBilling({ usedPercent: 1, windowEnd: NOW + 60_000 }, NOW)?.resetsAt).toBe(NOW + 60_000)
    expect(windowFromBilling({ usedPercent: 1, windowEnd: NOW / 1000 + 60 }, NOW)?.resetsAt).toBe(NOW + 60_000)
  })

  it('shows an expired window as reset instead of stale usage', () => {
    const expired = windowFromBilling({ usedPercent: 90, windowEnd: NOW / 1000 - 3600 }, NOW)
    expect(expired).toEqual({ percent: 0, resetsAt: null })
  })

  it('maps the standard pool, adds core only when it carries usage, and converts the balance', () => {
    const payload = {
      usesTokenRateLimitsBilling: true,
      limits: {
        standard: {
          fiveHour: { usedPercent: 20, windowEnd: NOW / 1000 + 3600 },
          weekly: { usedPercent: 50, windowEnd: null },
          monthly: { usedPercent: 5 },
        },
        core: {
          fiveHour: { usedPercent: 0, windowEnd: null },
          weekly: { usedPercent: 3 },
          monthly: { usedPercent: 0 },
        },
      },
      extraUsageBalanceCents: 1250,
    }
    const result = windowsFromBillingLimits(payload, NOW)
    expect(result?.windows.map((window) => window.id)).toEqual([
      'factoryFiveHour',
      'factoryWeekly',
      'factoryMonthly',
      'factoryCoreFiveHour',
      'factoryCoreWeekly',
      'factoryCoreMonthly',
    ])
    expect(result?.topUpCredits).toBe(12.5)
  })

  it('drops an idle core pool and rejects non-token-rate-limits payloads', () => {
    const idle = windowsFromBillingLimits(
      {
        usesTokenRateLimitsBilling: true,
        limits: {
          standard: { fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 50 }, monthly: { usedPercent: 5 } },
          core: { fiveHour: { usedPercent: 0 }, weekly: { usedPercent: 0 }, monthly: { usedPercent: 0 } },
        },
      },
      NOW,
    )
    expect(idle?.windows.map((window) => window.id)).not.toContain('factoryCoreWeekly')
    expect(
      windowsFromBillingLimits({ usesTokenRateLimitsBilling: false, limits: { standard: { fiveHour: {} } } }, NOW),
    ).toBeNull()
    expect(windowsFromBillingLimits({}, NOW)).toBeNull()
  })
})

describe('Factory legacy usage payload', () => {
  it('uses usedRatio when sane and token counts otherwise', () => {
    const windows = windowsFromLegacyUsage(
      {
        usage: {
          endDate: NOW / 1000 + 86_400,
          standard: { userTokens: 1_000, totalAllowance: 4_000, usedRatio: 0.25 },
          premium: { userTokens: 500, totalAllowance: 2_000, usedRatio: 0.9 },
        },
      },
      NOW,
    )
    expect(windows).toEqual([
      { id: 'factoryStandard', percent: 25, resetsAt: NOW + 86_400_000 },
      { id: 'factoryPremium', percent: 90, resetsAt: NOW + 86_400_000 },
    ])
  })

  it('falls back to counts, drops an unusable pool, and never invents 0%', () => {
    const windows = windowsFromLegacyUsage(
      {
        usage: {
          standard: { userTokens: 300, totalAllowance: 100 },
          premium: { userTokens: 10, totalAllowance: 0 },
        },
      },
      NOW,
    )
    expect(windows).toEqual([{ id: 'factoryStandard', percent: 100, resetsAt: null }])
    expect(windowsFromLegacyUsage({ usage: {} }, NOW)).toBeNull()
    expect(windowsFromLegacyUsage({}, NOW)).toBeNull()
  })
})

describe('Factory plan label', () => {
  it('prefers the orb plan name and falls back to the factory tier', () => {
    expect(planFromAuthPayload({ organization: { subscription: { orbSubscription: { plan: { name: 'Pro' } } } } })).toBe(
      'Pro',
    )
    expect(planFromAuthPayload({ organization: { subscription: { factoryTier: 'team' } } })).toBe('team')
    expect(planFromAuthPayload({ organization: {} })).toBeNull()
    expect(planFromAuthPayload(null)).toBeNull()
  })
})

describe('fetchFactoryQuota', () => {
  it('returns no-auth when no Factory API key is reachable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'factory-quota-'))
    expect(await fetchFactoryQuota(async () => new Response(''), home, {})).toEqual({
      available: false,
      reason: 'no-auth',
    })
  })

  it('sends the bearer token and x-factory-client header and returns only numbers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'factory-quota-'))
    const envFile = join(home, '.factory', '.env')
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(home, '.factory'), { recursive: true })
    await writeFile(envFile, 'FACTORY_API_KEY=fk-secret\n')
    const seenUrls: string[] = []
    let authorization = ''
    let clientHeader = ''
    const outcome = await fetchFactoryQuota(
      async (url, init) => {
        seenUrls.push(String(url))
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        clientHeader = new Headers(init?.headers).get('x-factory-client') ?? ''
        if (String(url).endsWith('/api/app/auth/me')) {
          return new Response(JSON.stringify({ organization: { subscription: { orbSubscription: { plan: { name: 'Pro' } } } } }))
        }
        return new Response(
          JSON.stringify({
            usesTokenRateLimitsBilling: true,
            limits: {
              standard: {
                fiveHour: { usedPercent: 12, secondsRemaining: 600 },
                weekly: { usedPercent: 34 },
                monthly: { usedPercent: 56 },
              },
            },
            extraUsageBalanceCents: 0,
          }),
        )
      },
      home,
      {},
    )
    expect(seenUrls[0]).toBe('https://api.factory.ai/api/billing/limits')
    expect(authorization).toBe('Bearer fk-secret')
    expect(clientHeader).toBe('web-app')
    expect(outcome.available).toBe(true)
    expect(outcome.body).not.toContain('fk-secret')
    const body = JSON.parse(outcome.body ?? '{}')
    expect(body.plan).toBe('Pro')
    expect(body.windows.map((window: { id: string }) => window.id)).toEqual([
      'factoryFiveHour',
      'factoryWeekly',
      'factoryMonthly',
    ])
    expect(body.topUpCredits).toBe(0)
  })

  it('falls back to the legacy usage endpoint for non-token-rate-limits accounts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'factory-quota-'))
    const seenUrls: string[] = []
    const outcome = await fetchFactoryQuota(
      async (url) => {
        seenUrls.push(String(url))
        if (String(url).includes('/api/organization/subscription/usage')) {
          return new Response(
            JSON.stringify({
              usage: { endDate: NOW / 1000, standard: { userTokens: 1, totalAllowance: 2, usedRatio: 0.5 } },
            }),
          )
        }
        return new Response(JSON.stringify({ usesTokenRateLimitsBilling: false }))
      },
      home,
      { FACTORY_API_KEY: 'fk-env' },
    )
    expect(seenUrls[1]).toBe('https://api.factory.ai/api/organization/subscription/usage?useCache=true')
    expect(JSON.parse(outcome.body ?? '{}').windows).toEqual([{ id: 'factoryStandard', percent: 50, resetsAt: null }])
  })

  it('maps a rejected key to reauth and a bad status to its http reason', async () => {
    const home = await mkdtemp(join(tmpdir(), 'factory-quota-'))
    const outcome401 = await fetchFactoryQuota(async () => new Response('no', { status: 401 }), home, {
      FACTORY_API_KEY: 'fk-expired',
    })
    expect(outcome401).toEqual({ available: false, reason: 'reauth' })
    const outcome503 = await fetchFactoryQuota(async () => new Response('no', { status: 503 }), home, {
      FACTORY_API_KEY: 'fk-key',
    })
    expect(outcome503).toEqual({ available: false, reason: 'http-503' })
  })
})
