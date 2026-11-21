import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchClaudeUsage, fetchGeminiUsage } from './subscription-quotas'

/**
 * subscription-quotas.ts deliberately avoids importing Electron so the probe
 * logic can run headlessly; these tests inject a scripted fetch like
 * kiro-quota.test.ts does. The assertions double as the P4 store-boundary
 * guard: the returned body is what quota-cache.json persists verbatim, so it
 * must carry only the narrowed quota fields — never the token and never the
 * account identifiers the vendor endpoints sprinkle around the numbers.
 */

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('fetchClaudeUsage', () => {
  const TOKEN = 'sk-ant-oat01-secret-token'

  it('returns no-auth-file when the credentials file is missing', async () => {
    const home = await tempDir('claude-quota-')
    expect(await fetchClaudeUsage(async () => new Response(''), home)).toEqual({
      available: false,
      reason: 'no-auth-file',
    })
  })

  it('returns no-oauth-token when the file carries no usable token', async () => {
    const base = await tempDir('claude-quota-')
    await writeFile(join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }))
    const outcome = await fetchClaudeUsage(async () => new Response(''), 'unused-home', base)
    expect(outcome).toEqual({ available: false, reason: 'no-oauth-token' })
  })

  it('maps a 401 to the http reason without echoing the response body', async () => {
    const home = await tempDir('claude-quota-')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }),
    )
    const outcome = await fetchClaudeUsage(async () => new Response('{"error":"expired"}', { status: 401 }), home)
    expect(outcome).toEqual({ available: false, reason: 'http-401' })
  })

  it('sends the bearer token with the oauth beta header and returns only the narrowed windows', async () => {
    const home = await tempDir('claude-quota-')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }))

    let authorization = ''
    let beta = ''
    const rawBody = JSON.stringify({
      // The endpoint's account-identifier fields must never reach the outcome body
      user_id: 'user-abc123',
      organizations: [{ id: 'org-xyz', name: 'Acme' }],
      five_hour: { utilization: 42.5, resets_at: '2026-11-21T10:00:00Z', account_id: 'acct-123' },
      seven_day: { utilization: 10, resets_at: '2026-11-24T00:00:00Z' },
      limits: [
        {
          percent: 88,
          resets_at: '2026-11-22T00:00:00Z',
          kind: 'seven_day_opus',
          account_uuid: 'acct-123',
          scope: { model: { display_name: 'Opus', internal_id: 'scoped-internal' } },
        },
        // Non-object entries are dropped instead of crashing the card
        'garbage-entry',
      ],
    })
    const outcome = await fetchClaudeUsage(
      async (_url, init) => {
        const headers = init.headers as Record<string, string>
        authorization = headers.Authorization
        beta = headers['anthropic-beta']
        return new Response(rawBody, { status: 200 })
      },
      home,
    )

    expect(authorization).toBe(`Bearer ${TOKEN}`)
    expect(beta).toBeTruthy()
    expect(outcome.available).toBe(true)
    // The persisted body must not carry the token or any account identifier
    expect(outcome.body).not.toContain(TOKEN)
    expect(outcome.body).not.toContain('user-abc123')
    expect(outcome.body).not.toContain('org-xyz')
    expect(outcome.body).not.toContain('acct-123')
    expect(outcome.body).not.toContain('scoped-internal')
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      five_hour: { utilization: 42.5, resets_at: '2026-11-21T10:00:00Z' },
      seven_day: { utilization: 10, resets_at: '2026-11-24T00:00:00Z' },
      limits: [
        {
          percent: 88,
          resets_at: '2026-11-22T00:00:00Z',
          kind: 'seven_day_opus',
          scope: { model: { display_name: 'Opus' } },
        },
      ],
    })
  })

  it('returns bad-response on an unparsable 200 body', async () => {
    const home = await tempDir('claude-quota-')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }))
    const outcome = await fetchClaudeUsage(async () => new Response('<html>gateway</html>', { status: 200 }), home)
    expect(outcome).toEqual({ available: false, reason: 'bad-response' })
  })

  it('maps a transport failure to probe-failed', async () => {
    const home = await tempDir('claude-quota-')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }))
    const outcome = await fetchClaudeUsage(
      async () => {
        throw new Error('network down')
      },
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'probe-failed' })
  })
})

describe('fetchGeminiUsage', () => {
  const TOKEN_URL = 'https://oauth2.googleapis.com/token'
  const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
  const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'

  /** Scripted fetch keyed by URL, recording every call for the assertions */
  function scriptedFetch(
    handlers: Record<string, (url: string, init: RequestInit) => Response>,
    calls?: Array<{ url: string; body: string; authorization: string }>,
  ): (url: string, init: RequestInit) => Promise<Response> {
    return async (url, init) => {
      const handler = handlers[url]
      if (!handler) throw new Error(`unexpected fetch: ${url}`)
      calls?.push({
        url,
        body: String(init.body ?? ''),
        authorization: new Headers(init.headers).get('authorization') ?? '',
      })
      return handler(url, init)
    }
  }

  it('returns no-auth-file when the credentials file is missing', async () => {
    const home = await tempDir('gemini-quota-')
    const outcome = await fetchGeminiUsage(async () => new Response(''), home)
    expect(outcome).toEqual({ available: false, reason: 'no-auth-file' })
  })

  it('returns no-refresh-token when the file has neither token', async () => {
    const home = await tempDir('gemini-quota-')
    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ unrelated: 'field' }))
    const outcome = await fetchGeminiUsage(async () => new Response(''), home)
    expect(outcome).toEqual({ available: false, reason: 'no-refresh-token' })
  })

  it('refreshes a stale token, resolves the project id and returns only the buckets', async () => {
    const home = await tempDir('gemini-quota-')
    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(
      join(home, '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'stale-token', refresh_token: 'refresh-secret', expiry_date: 1 }),
    )
    const calls: Array<{ url: string; body: string; authorization: string }> = []
    const outcome = await fetchGeminiUsage(
      scriptedFetch(
        {
          [TOKEN_URL]: () => new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200 }),
          [LOAD_URL]: () =>
            new Response(
              // Account payload around the one field the probe needs
              JSON.stringify({ cloudaicompanionProject: 'proj-string', user_id: 'user-abc', name: 'profiles/abc' }),
              { status: 200 },
            ),
          [QUOTA_URL]: () =>
            new Response(
              JSON.stringify({
                buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.4 }],
                user_id: 'user-abc',
                organization: { id: 'org-1' },
              }),
              { status: 200 },
            ),
        },
        calls,
      ),
      home,
    )

    // Token refresh is a form POST carrying the refresh grant
    expect(calls[0]?.url).toBe(TOKEN_URL)
    expect(calls[0]?.body).toContain('grant_type=refresh_token')
    expect(calls[0]?.body).toContain(encodeURIComponent('refresh-secret'))
    expect(calls[0]?.body).toContain('client_id=')
    // Downstream calls use the refreshed bearer token
    expect(calls[1]?.url).toBe(LOAD_URL)
    expect(calls[1]?.authorization).toBe('Bearer fresh-token')
    expect(calls[2]?.url).toBe(QUOTA_URL)
    expect(calls[2]?.authorization).toBe('Bearer fresh-token')
    // A plain-string project id is forwarded as the quota request body
    expect(calls[2]?.body).toBe(JSON.stringify({ project: 'proj-string' }))

    expect(outcome.available).toBe(true)
    // The persisted body is buckets only — no token, no account identifiers
    expect(outcome.body).not.toContain('fresh-token')
    expect(outcome.body).not.toContain('refresh-secret')
    expect(outcome.body).not.toContain('user-abc')
    expect(outcome.body).not.toContain('org-1')
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.4 }],
    })
  })

  it('accepts an object-shaped project id and passes it through', async () => {
    const home = await tempDir('gemini-quota-')
    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(
      join(home, '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'access-token', expiry_date: Date.now() + 3_600_000 }),
    )
    const calls: Array<{ url: string; body: string; authorization: string }> = []
    await fetchGeminiUsage(
      scriptedFetch(
        {
          [LOAD_URL]: () => new Response(JSON.stringify({ cloudaicompanionProject: { id: 'pid-object' } }), { status: 200 }),
          [QUOTA_URL]: () => new Response(JSON.stringify({ buckets: [] }), { status: 200 }),
        },
        calls,
      ),
      home,
    )
    // A fresh token skips the refresh endpoint entirely
    expect(calls.map((c) => c.url)).toEqual([LOAD_URL, QUOTA_URL])
    expect(calls[0]?.authorization).toBe('Bearer access-token')
    expect(calls[1]?.body).toBe(JSON.stringify({ project: 'pid-object' }))
  })

  it('maps a 401 on loadCodeAssist to the http reason', async () => {
    const home = await tempDir('gemini-quota-')
    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(
      join(home, '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'access-token', expiry_date: Date.now() + 3_600_000 }),
    )
    const calls: Array<{ url: string; body: string; authorization: string }> = []
    const outcome = await fetchGeminiUsage(
      scriptedFetch({ [LOAD_URL]: () => new Response('denied', { status: 401 }) }, calls),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'http-401' })
    // The quota endpoint is never called after the auth rejection
    expect(calls.map((c) => c.url)).toEqual([LOAD_URL])
  })

  it('maps a failing quota endpoint to the http reason', async () => {
    const home = await tempDir('gemini-quota-')
    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(
      join(home, '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'access-token', expiry_date: Date.now() + 3_600_000 }),
    )
    const outcome = await fetchGeminiUsage(
      scriptedFetch({
        [LOAD_URL]: () => new Response(JSON.stringify({ cloudaicompanionProject: 'proj' }), { status: 200 }),
        [QUOTA_URL]: () => new Response('boom', { status: 500 }),
      }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'http-500' })
  })

  it('keeps probing with the stale token when the refresh endpoint rejects it', async () => {
    const home = await tempDir('gemini-quota-')
    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(
      join(home, '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'stale-token', refresh_token: 'refresh-secret', expiry_date: 1 }),
    )
    const calls: Array<{ url: string; body: string; authorization: string }> = []
    // A failed refresh does not stop the probe: it falls back to the stale
    // access token and goes ahead, so the outcome reflects that attempt
    const outcome = await fetchGeminiUsage(
      scriptedFetch(
        {
          [TOKEN_URL]: () => new Response('{"error":"invalid_grant"}', { status: 400 }),
          [LOAD_URL]: () => new Response(JSON.stringify({ cloudaicompanionProject: 'proj' }), { status: 200 }),
          [QUOTA_URL]: () => new Response(JSON.stringify({ buckets: [{ modelId: 'gemini-2.5-pro' }] }), { status: 200 }),
        },
        calls,
      ),
      home,
    )
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({ buckets: [{ modelId: 'gemini-2.5-pro' }] })
    expect(calls[1]?.authorization).toBe('Bearer stale-token')
    expect(calls[2]?.authorization).toBe('Bearer stale-token')
  })

  it('reports refresh-failed when only a refresh token exists and the refresh fails', async () => {
    const home = await tempDir('gemini-quota-')
    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'refresh-secret' }))
    const outcome = await fetchGeminiUsage(
      scriptedFetch({ [TOKEN_URL]: () => new Response('{"error":"invalid_grant"}', { status: 400 }) }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'refresh-failed' })
  })
})
