import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clineProvidersPath, credentialFromProviders, fetchClineQuota, windowsFromUsageLimits } from './cline-quota'

describe('Cline Pass credential file', () => {
  it('follows Cline path overrides in order', () => {
    expect(clineProvidersPath('/home/u', { CLINE_PROVIDER_SETTINGS_PATH: '/tmp/providers.json' })).toBe(
      '/tmp/providers.json',
    )
    expect(clineProvidersPath('/home/u', { CLINE_DATA_DIR: '/data' })).toBe(join('/data', 'settings', 'providers.json'))
    expect(clineProvidersPath('/home/u', { CLINE_DIR: '~/apps/cline' })).toBe(
      join('/home/u', 'apps', 'cline', 'data', 'settings', 'providers.json'),
    )
    expect(clineProvidersPath('/home/u', {})).toBe(join('/home/u', '.cline', 'data', 'settings', 'providers.json'))
  })

  it('prefers the OAuth access token and ignores refresh tokens and other providers', () => {
    const token = credentialFromProviders(
      JSON.stringify({
        providers: {
          other: { settings: { apiKey: 'sk-other' } },
          cline: { settings: { apiKey: 'sk-kept', auth: { accessToken: 'raw-token', refreshToken: 'refresh' } } },
        },
      }),
    )
    expect(token).toBe('workos:raw-token')
  })

  it('keeps an already prefixed token and falls back to the API key', () => {
    expect(
      credentialFromProviders(JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'workos:abc' } } } } })),
    ).toBe('workos:abc')
    expect(
      credentialFromProviders(JSON.stringify({ providers: { cline: { settings: { apiKey: 'sk-cp', auth: { apiKey: 'other' } } } } })),
    ).toBe('sk-cp')
    expect(credentialFromProviders(JSON.stringify({ providers: { cline: { settings: { auth: { refreshToken: 'x' } } } } }))).toBe(
      null,
    )
  })

  it('rejects a token that could break the Authorization header', () => {
    expect(
      credentialFromProviders(JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'a\nb' } } } } })),
    ).toBe(null)
  })
})

describe('Cline Pass usage payload', () => {
  it('maps the three windows and skips an unknown type', () => {
    const windows = windowsFromUsageLimits({
      success: true,
      data: {
        limits: [
          { type: 'five_hour', percentUsed: 12.5, resetsAt: '2026-04-02T00:00:00Z' },
          { type: 'weekly', percentUsed: 40, resetsAt: null },
          { type: 'monthly', percentUsed: 150 },
          { type: 'daily', percentUsed: 1 },
        ],
      },
    })
    expect(windows).toEqual([
      { id: 'clineFiveHour', percent: 12.5, resetsAt: Date.parse('2026-04-02T00:00:00Z') },
      { id: 'clineWeekly', percent: 40, resetsAt: null },
      { id: 'clineMonthly', percent: 100, resetsAt: null },
    ])
  })

  it('does not turn a rejected or empty payload into 0%', () => {
    expect(windowsFromUsageLimits({ success: false, data: { limits: [] } })).toBeNull()
    expect(windowsFromUsageLimits({ success: true, data: { limits: [{ type: 'five_hour', percentUsed: 'nope' }] } })).toEqual(
      [],
    )
  })
})

describe('fetchClineQuota', () => {
  it('returns no-auth when Cline has not signed in', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cline-quota-'))
    const outcome = await fetchClineQuota(async () => new Response(''), home, {})
    expect(outcome).toEqual({ available: false, reason: 'no-auth' })
  })

  it('sends the bearer token and returns only window numbers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cline-quota-'))
    const file = join(home, 'providers.json')
    await writeFile(file, JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'secret-token' } } } } }))
    let authorization = ''
    const outcome = await fetchClineQuota(
      async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return new Response(
          JSON.stringify({ success: true, data: { limits: [{ type: 'weekly', percentUsed: 8, resetsAt: null }] } }),
          { status: 200 },
        )
      },
      home,
      { CLINE_PROVIDER_SETTINGS_PATH: file },
    )
    expect(authorization).toBe('Bearer workos:secret-token')
    expect(outcome.available).toBe(true)
    expect(outcome.body).not.toContain('secret-token')
    expect(JSON.parse(outcome.body ?? '{}').windows).toEqual([{ id: 'clineWeekly', percent: 8, resetsAt: null }])
  })

  it('maps a rejected session to reauth and does not echo the token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cline-quota-'))
    const file = join(home, 'providers.json')
    await writeFile(file, JSON.stringify({ providers: { cline: { settings: { apiKey: 'sk-secret' } } } }))
    const outcome = await fetchClineQuota(async () => new Response('no', { status: 401 }), home, {
      CLINE_PROVIDER_SETTINGS_PATH: file,
    })
    expect(outcome).toEqual({ available: false, reason: 'reauth' })
  })
})
