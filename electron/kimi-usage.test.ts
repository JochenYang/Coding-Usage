import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchKimiUsage } from './kimi-usage'

/**
 * Scripted-fetch tests for the Kimi Code subscription probe (P27 / T5), in the
 * kiro/claude/gemini pattern. The loopback fixture follows the server's
 * documented `{code, msg, data, request_id}` envelope with an in-band
 * `data.kind`, while the inner `summary`/`limits` fields mirror the shape
 * parseLoopback actually consumes. The outcome body is what quota-cache.json
 * persists verbatim, so the success assertions double as the store-boundary
 * guard: windows and wallet only — never the server token, the OAuth token or
 * a pasted API key.
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

const LOOPBACK_URLS = [58627, 58628, 58629].map((port) => `http://127.0.0.1:${port}/api/v1/oauth/usage`)
const REMOTE_URL = 'https://api.kimi.com/coding/v1/usages'

interface RecordedCall {
  url: string
  authorization: string
  redirect: string
}

/** Answers per URL and records the security-relevant request facts */
function scriptedFetch(
  handlers: Record<string, (url: string, init: RequestInit) => Response>,
  calls?: RecordedCall[],
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    calls?.push({
      url,
      authorization: new Headers(init.headers).get('authorization') ?? '',
      redirect: init.redirect ?? '',
    })
    return handler(url, init)
  }
}

async function writeServerToken(home: string, token: string): Promise<void> {
  const dir = join(home, '.kimi-code')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'server.token'), token)
}

async function writeOAuthToken(home: string, accessToken: string): Promise<void> {
  const dir = join(home, '.kimi-code', 'credentials')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'kimi-code.json'), JSON.stringify({ access_token: accessToken }))
}

/** Remote quota-model payload — the shape parseRemote prefers */
const REMOTE_QUOTA_OK = {
  usages: {
    limit_5h: { used_ratio: 0.4, reset_time: '2026-11-21T18:00:00.000Z' },
    limit_7d: { used_ratio: 0.3, reset_time: '2026-11-28T00:00:00.000Z' },
    limit_month_total: { used_ratio: 0.2 },
    limit_month_code: { used_ratio: 0.9 },
  },
  boosterWallet: { balanceCents: 5000, totalCents: 9000, monthlyUsedCents: 1000, currency: 'CNY' },
}

describe('fetchKimiUsage', () => {
  it('returns no-auth-file and never fetches without any credential', async () => {
    const home = await tempDir('kimi-quota-')
    const outcome = await fetchKimiUsage(scriptedFetch({}), home)
    expect(outcome).toEqual({ available: false, reason: 'no-auth-file' })
  })

  it('returns no-auth-file when the credential file is not valid JSON', async () => {
    const home = await tempDir('kimi-quota-')
    const dir = join(home, '.kimi-code', 'credentials')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'kimi-code.json'), 'not-json{')
    const outcome = await fetchKimiUsage(scriptedFetch({}), home)
    expect(outcome).toEqual({ available: false, reason: 'no-auth-file' })
  })

  it('answers from the loopback server and never touches the remote endpoint', async () => {
    const home = await tempDir('kimi-quota-')
    await writeServerToken(home, 'cli-server-token')
    const calls: RecordedCall[] = []
    const outcome = await fetchKimiUsage(
      scriptedFetch(
        {
          [LOOPBACK_URLS[0]!]: () =>
            new Response(
              JSON.stringify({
                code: 0,
                msg: 'success',
                request_id: 'req-1',
                data: {
                  kind: 'ok',
                  summary: {
                    window: { duration: 1, unit: 'week' },
                    used: 30,
                    limit: 100,
                    reset_at: '2026-11-28T00:00:00.000Z',
                  },
                  limits: [
                    {
                      window: { duration: 5, unit: 'hour' },
                      used: 40,
                      limit: 100,
                      reset_at: '2026-11-21T18:00:00.000Z',
                    },
                  ],
                  extra_usage: { balanceCents: 1234, currency: 'CNY' },
                },
              }),
              { status: 200 },
            ),
        },
        calls,
      ),
      home,
    )

    expect(calls.map((c) => c.url)).toEqual([LOOPBACK_URLS[0]])
    expect(calls[0]?.authorization).toBe('Bearer cli-server-token')
    expect(calls[0]?.redirect).toBe('error')
    expect(outcome.available).toBe(true)
    expect(outcome.body).not.toContain('cli-server-token')
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      source: 'local-server',
      windows: [
        { id: 'fiveHour', percent: 40, resetsAt: Date.parse('2026-11-21T18:00:00.000Z') },
        { id: 'weekly', percent: 30, resetsAt: Date.parse('2026-11-28T00:00:00.000Z') },
      ],
      wallet: { remaining: 12.34, total: null, used: null, currency: 'CNY' },
    })
  })

  it('walks every loopback port and falls through to the remote token when the server yields no windows', async () => {
    // Two fall-through shapes are exercised against the same expectation:
    // an in-band data.kind:"error" (the documented upstream-failure envelope)
    // and the currently documented quota payload (data.kind:"ok" with
    // quota.usages — which parseLoopback does not read, so it yields no
    // windows and the probe moves on instead of guessing).
    const home = await tempDir('kimi-quota-')
    await writeServerToken(home, 'cli-server-token')
    await writeOAuthToken(home, 'oauth-secret')
    const quotaModelData = {
      kind: 'ok',
      quota: { usages: { limit5h: { usedRatio: 0.4 } }, extraUsage: null },
    }
    const errorData = { kind: 'error', message: 'upstream down' }
    const responses = [quotaModelData, errorData, quotaModelData]
    const handlers: Record<string, (url: string, init: RequestInit) => Response> = {}
    LOOPBACK_URLS.forEach((url, i) => {
      handlers[url] = () => new Response(JSON.stringify({ code: 0, msg: 'success', data: responses[i] }), { status: 200 })
    })
    handlers[REMOTE_URL] = () => new Response(JSON.stringify(REMOTE_QUOTA_OK), { status: 200 })
    const calls: RecordedCall[] = []
    const outcome = await fetchKimiUsage(scriptedFetch(handlers, calls), home)

    expect(calls.map((c) => c.url)).toEqual([...LOOPBACK_URLS, REMOTE_URL])
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body ?? '{}').source).toBe('remote')
  })

  it('stops scanning loopback ports after an auth rejection and falls through to the remote token', async () => {
    const home = await tempDir('kimi-quota-')
    await writeServerToken(home, 'cli-server-token')
    await writeOAuthToken(home, 'oauth-secret')
    const calls: RecordedCall[] = []
    const outcome = await fetchKimiUsage(
      scriptedFetch(
        {
          [LOOPBACK_URLS[0]!]: () => new Response('{"error":"expired"}', { status: 403 }),
          [REMOTE_URL]: () => new Response(JSON.stringify(REMOTE_QUOTA_OK), { status: 200 }),
        },
        calls,
      ),
      home,
    )

    // 401/403 mean the token is wrong for every port: no point trying 58628/58629
    expect(calls.map((c) => c.url)).toEqual([LOOPBACK_URLS[0], REMOTE_URL])
    expect(calls[1]?.authorization).toBe('Bearer oauth-secret')
    expect(outcome.available).toBe(true)
  })

  it('returns only the normalized windows from the stored OAuth token', async () => {
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const calls: RecordedCall[] = []
    const outcome = await fetchKimiUsage(
      scriptedFetch({ [REMOTE_URL]: () => new Response(JSON.stringify(REMOTE_QUOTA_OK), { status: 200 }) }, calls),
      home,
    )

    expect(calls.map((c) => c.url)).toEqual([REMOTE_URL])
    expect(calls[0]?.authorization).toBe('Bearer oauth-secret')
    expect(outcome.available).toBe(true)
    // The persisted body must not carry the stored token
    expect(outcome.body).not.toContain('oauth-secret')
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      source: 'remote',
      windows: [
        { id: 'fiveHour', percent: 40, resetsAt: Date.parse('2026-11-21T18:00:00.000Z') },
        { id: 'weekly', percent: 30, resetsAt: Date.parse('2026-11-28T00:00:00.000Z') },
        { id: 'monthTotal', percent: 20, resetsAt: null },
        { id: 'monthCode', percent: 90, resetsAt: null },
      ],
      wallet: { remaining: 50, total: 90, used: 10, currency: 'CNY' },
    })
  })

  it('reads a used_ratio above 1 as an already-reported percentage', async () => {
    // percentFromRatio treats >1 values as percentages, not ratios — locking
    // the tolerance here so a future edit cannot silently flip the semantics.
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const outcome = await fetchKimiUsage(
      scriptedFetch({
        [REMOTE_URL]: () =>
          new Response(JSON.stringify({ usages: { limit_5h: { used_ratio: 1.5 } } }), { status: 200 }),
      }),
      home,
    )
    expect(JSON.parse(outcome.body ?? '{}').windows).toEqual([{ id: 'fiveHour', percent: 1.5, resetsAt: null }])
  })

  it('keeps the wallet absent when the quota payload carries no booster wallet', async () => {
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const outcome = await fetchKimiUsage(
      scriptedFetch({
        [REMOTE_URL]: () =>
          new Response(
            JSON.stringify({ usages: { limit_5h: { used_ratio: 0.4 } } }),
            { status: 200 },
          ),
      }),
      home,
    )
    expect(JSON.parse(outcome.body ?? '{}').wallet).toBeNull()
  })

  it('parses the legacy limits/usage shape as a fallback', async () => {
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const outcome = await fetchKimiUsage(
      scriptedFetch({
        [REMOTE_URL]: () =>
          new Response(
            JSON.stringify({
              limits: [{ detail: { limit: 200, remaining: 50, resetTime: '2026-12-01T00:00:00.000Z' } }],
              usage: { limit: 100, remaining: 25, resetTime: '2026-11-28T00:00:00.000Z' },
            }),
            { status: 200 },
          ),
      }),
      home,
    )
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body ?? '{}').windows).toEqual([
      { id: 'fiveHour', percent: 75, resetsAt: Date.parse('2026-12-01T00:00:00.000Z') },
      { id: 'weekly', percent: 75, resetsAt: Date.parse('2026-11-28T00:00:00.000Z') },
    ])
  })

  it('maps a 401 to the http reason without echoing the response body', async () => {
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const outcome = await fetchKimiUsage(
      scriptedFetch({ [REMOTE_URL]: () => new Response('{"error":"expired"}', { status: 401 }) }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'http-401' })
  })

  it('maps a non-200 remote status to the http reason', async () => {
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const outcome = await fetchKimiUsage(
      scriptedFetch({ [REMOTE_URL]: () => new Response('boom', { status: 500 }) }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'http-500' })
  })

  it('returns malformed-body for a 200 body that parses to no windows', async () => {
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const outcome = await fetchKimiUsage(
      scriptedFetch({ [REMOTE_URL]: () => new Response('<html>gateway</html>', { status: 200 }) }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'malformed-body' })
  })

  it('maps a transport failure to probe-failed', async () => {
    const home = await tempDir('kimi-quota-')
    await writeOAuthToken(home, 'oauth-secret')
    const outcome = await fetchKimiUsage(
      scriptedFetch({
        [REMOTE_URL]: () => {
          throw new Error('network down')
        },
      }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'probe-failed' })
  })
})
