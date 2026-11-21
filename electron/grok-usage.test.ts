import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchGrokUsage, parseGrokResetCredits, readGrokCredentials } from './grok-usage'

/**
 * Scripted-fetch tests for the Grok Build (SuperGrok) probe (P27 / T5), in the
 * kiro/claude/gemini pattern: read ~/.grok/auth.json, query the official
 * billing endpoint, return numbers only. The outcome body is persisted
 * verbatim in quota-cache.json, so the success assertions double as the
 * store-boundary guard: the bearer token must never appear in it.
 */

const dirs: string[] = []

const originalGrokHome = process.env.GROK_HOME

beforeEach(() => {
  // The probe prefers $GROK_HOME over <homeDir>/.grok; pin it off so the
  // fixtures below are read regardless of the host environment.
  delete process.env.GROK_HOME
})

afterEach(async () => {
  if (originalGrokHome === undefined) delete process.env.GROK_HOME
  else process.env.GROK_HOME = originalGrokHome
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings'

interface RecordedCall {
  url: string
  headers: Record<string, string>
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
      headers: Object.fromEntries(new Headers(init.headers)),
      redirect: init.redirect ?? '',
    })
    return handler(url, init)
  }
}

async function writeAuth(home: string, payload: object): Promise<void> {
  const dir = join(home, '.grok')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'auth.json'), JSON.stringify(payload))
}

describe('readGrokCredentials', () => {
  it('prefers the SuperGrok OIDC scope over the legacy sign-in scope', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, {
      'some-unrelated-scope': { key: 'fallback-secret', email: 'fallback@example.com' },
      'https://accounts.x.ai/sign-in': { key: 'legacy-secret', email: 'legacy@example.com' },
      'https://auth.x.ai::supergrok': { key: 'oidc-secret', email: 'oidc@example.com' },
    })
    expect(await readGrokCredentials(home)).toEqual({ token: 'oidc-secret' })
  })

  it('falls back to the legacy scope and skips entries without a usable key', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, {
      'https://auth.x.ai::supergrok': { key: '' },
      'https://accounts.x.ai/sign-in': { key: 'legacy-secret' },
      'some-unrelated-scope': { key: 'fallback-secret' },
    })
    expect(await readGrokCredentials(home)).toEqual({ token: 'legacy-secret' })
  })

  it('returns null when auth.json is missing', async () => {
    const home = await tempDir('grok-quota-')
    expect(await readGrokCredentials(home)).toBeNull()
  })
})

describe('fetchGrokUsage', () => {
  it('returns no-auth-file and never fetches without auth.json', async () => {
    const home = await tempDir('grok-quota-')
    const outcome = await fetchGrokUsage(scriptedFetch({}), home)
    expect(outcome).toEqual({ available: false, reason: 'no-auth-file' })
  })

  it('queries billing with the CLI headers and returns only the normalized numbers', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, {
      'https://auth.x.ai::supergrok': { key: 'grok-secret', email: 'user@example.com' },
    })
    const calls: RecordedCall[] = []
    const outcome = await fetchGrokUsage(
      scriptedFetch(
        {
          [BILLING_URL]: () =>
            new Response(
              JSON.stringify({
                config: {
                  creditUsagePercent: 42.5,
                  currentPeriod: { end: '2026-12-01T00:00:00.000Z' },
                },
              }),
              { status: 200 },
            ),
          [SETTINGS_URL]: () => new Response(JSON.stringify({ subscription_tier_display: 'SuperGrok' }), { status: 200 }),
        },
        calls,
      ),
      home,
    )

    expect(calls.map((c) => c.url)).toEqual([BILLING_URL, SETTINGS_URL])
    expect(calls[0]?.headers.authorization).toBe('Bearer grok-secret')
    expect(calls[0]?.headers['x-xai-token-auth']).toBe('xai-grok-cli')
    expect(calls[0]?.headers['user-agent']).toBe('Grok Build')
    expect(calls[0]?.redirect).toBe('error')
    expect(outcome.available).toBe(true)
    // The persisted body must not carry the bearer token
    expect(outcome.body).not.toContain('grok-secret')
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      percent: 42.5,
      resetsAt: Date.parse('2026-12-01T00:00:00.000Z'),
      plan: 'SuperGrok',
    })
  })

  it('derives the percentage from usage counts when no direct percent field exists', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () =>
          new Response(
            JSON.stringify({ usage: { onDemandUsed: 30 }, onDemandCap: 200 }),
            { status: 200 },
          ),
        [SETTINGS_URL]: () => new Response('{}', { status: 200 }),
      }),
      home,
    )
    expect(outcome.available).toBe(true)
    const body = JSON.parse(outcome.body ?? '{}') as { percent: number; resetsAt: unknown; plan: unknown }
    expect(body.percent).toBe(15)
    // No usable period fields and no plan label must stay absent, not zeroed
    expect(body.resetsAt).toBeNull()
    expect(body.plan).toBeNull()
    // The login email must not ride along into the persisted body
    expect('email' in body).toBe(false)
  })

  it('clamps a percentage reported above 100', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () => new Response(JSON.stringify({ config: { creditUsagePercent: 150 } }), { status: 200 }),
        [SETTINGS_URL]: () => new Response('{}', { status: 200 }),
      }),
      home,
    )
    expect(JSON.parse(outcome.body ?? '{}').percent).toBe(100)
  })

  it('keeps the numbers when the plan-label request fails', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () => new Response(JSON.stringify({ config: { creditUsagePercent: 42.5 } }), { status: 200 }),
        [SETTINGS_URL]: () => new Response('server error', { status: 500 }),
      }),
      home,
    )
    expect(outcome.available).toBe(true)
    const body = JSON.parse(outcome.body ?? '{}') as { plan: unknown }
    expect(body.plan).toBeNull()
  })

  it('maps a 401 to the http reason; the concurrent garnish reads fire and cost nothing', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({ [BILLING_URL]: () => new Response('{"error":"expired"}', { status: 401 }) }),
      home,
    )
    // 401 is decided by the billing read. The plan/banked reads were launched
    // concurrently with it — their failures are swallowed, so no extra reason
    // or field leaks out.
    expect(outcome).toEqual({ available: false, reason: 'http-401' })
  })

  it('maps a non-200 billing status to the http reason', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({ [BILLING_URL]: () => new Response('boom', { status: 500 }) }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'http-500' })
  })

  it('returns malformed-body when billing carries no usable percent', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () => new Response(JSON.stringify({ unrelated: 'shape' }), { status: 200 }),
      }),
      home,
    )
    expect(outcome).toEqual({ available: false, reason: 'malformed-body' })
  })

  it('maps a transport failure to network and a signal timeout to timeout', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const networkDown = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () => {
          throw new Error('network down')
        },
      }),
      home,
    )
    expect(networkDown).toEqual({ available: false, reason: 'network' })
    const timedOut = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () => {
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        },
      }),
      home,
    )
    expect(timedOut).toEqual({ available: false, reason: 'timeout' })
  })
})

// ===== Banked resets (GetRemainingResets, gRPC-Web) =====
//
// The fixtures build the exact wire bytes ai-usagebar's live capture
// documents: gRPC-Web framing ([flags u8][len u32 BE][payload]) around a
// ConsumerGetRemainingResetsResp message whose tokens carry token_id = 10,
// validity_start = 20 and validity_end = 30 (Timestamp, seconds = field 1).

function varint(value: number): Uint8Array {
  const out: number[] = []
  let rest = value
  while (rest > 0x7f) {
    out.push((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return new Uint8Array(out)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function delimited(field: number, payload: Uint8Array): Uint8Array {
  return concat([varint((field << 3) | 2), varint(payload.length), payload])
}

/** Timestamp { seconds = 1 } — seconds is field 1, wire type 0 (varint) */
function timestamp(seconds: number): Uint8Array {
  return concat([varint(1 << 3), varint(seconds)])
}

/** ConsumerResetToken { token_id = 10, validity_start = 20, validity_end = 30 } */
function resetToken(id: string, start: number, end: number, ...extra: Uint8Array[]): Uint8Array {
  return concat([delimited(10, Buffer.from(id, 'utf8')), delimited(20, timestamp(start)), delimited(30, timestamp(end)), ...extra])
}

function dataFrame(payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(5)
  new DataView(head.buffer).setUint32(1, payload.length)
  return concat([head, payload])
}

function trailerFrame(text: string): Uint8Array {
  const head = new Uint8Array(5)
  head[0] = 0x80
  new DataView(head.buffer).setUint32(1, Buffer.byteLength(text))
  return concat([head, Buffer.from(text, 'utf8')])
}

const RESETS_URL = 'https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets'

describe('parseGrokResetCredits', () => {
  it('counts every token and keeps the earliest validity_end', () => {
    const body = concat([
      delimited(10, resetToken('restok_one', 1_786_560_540, 1_789_238_940)),
      delimited(10, resetToken('restok_two', 1_786_560_540, 1_791_830_940)),
    ])
    expect(parseGrokResetCredits(dataFrame(body))).toEqual({ count: 2, expiresAt: 1_789_238_940_000 })
  })

  it('counts a token without an expiry instead of failing the read', () => {
    const token = delimited(10, delimited(10, Buffer.from('restok', 'utf8')))
    expect(parseGrokResetCredits(dataFrame(token))).toEqual({ count: 1, expiresAt: null })
  })

  it('reads a trailer-reported failure as a failure, never as zero resets', () => {
    const rejected = concat([dataFrame(new Uint8Array(0)), trailerFrame('grpc-status:16\r\ngrpc-message:unauthenticated\r\n')])
    expect(parseGrokResetCredits(rejected)).toBeNull()
    const ok = concat([dataFrame(delimited(10, resetToken('restok', 1, 1_789_238_940))), trailerFrame('grpc-status:0\r\n')])
    expect(parseGrokResetCredits(ok)).toEqual({ count: 1, expiresAt: 1_789_238_940_000 })
  })

  it('skips unknown fields by wire type instead of breaking', () => {
    const extended = resetToken(
      'restok',
      1,
      1_789_238_940,
      delimited(40, Buffer.from('a field this build has never seen', 'utf8')),
      concat([varint((50 << 3) | 1), new Uint8Array(8)]),
    )
    expect(parseGrokResetCredits(dataFrame(delimited(10, extended)))).toEqual({
      count: 1,
      expiresAt: 1_789_238_940_000,
    })
  })

  it('rejects truncated frames, lying length prefixes and unknown wire types', () => {
    const framed = dataFrame(delimited(10, resetToken('restok', 1, 1_789_238_940)))
    for (const cut of [3, 6, framed.length - 1]) {
      expect(parseGrokResetCredits(framed.subarray(0, cut))).toBeNull()
    }
    const lying = new Uint8Array(5)
    new DataView(lying.buffer).setUint32(1, 255)
    expect(parseGrokResetCredits(concat([lying, delimited(10, resetToken('restok', 1, 1_789_238_940))]))).toBeNull()
    // Wire type 7 does not exist
    expect(parseGrokResetCredits(dataFrame(new Uint8Array([0x0f, 0x00])))).toBeNull()
    expect(parseGrokResetCredits(new Uint8Array(0))).toBeNull()
  })
})

describe('fetchGrokUsage banked resets', () => {
  it('adds remainingResets and resetsExpireAt to an otherwise unchanged body', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret', email: 'user@example.com' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () =>
          new Response(JSON.stringify({ config: { creditUsagePercent: 42.5 } }), { status: 200 }),
        [SETTINGS_URL]: () => new Response('{}', { status: 200 }),
        [RESETS_URL]: (_url, init) => {
          const headers = new Headers(init.headers)
          expect(headers.get('content-type')).toBe('application/grpc-web+proto')
          expect(headers.get('authorization')).toBe('Bearer grok-secret')
          return new Response(
            dataFrame(delimited(10, resetToken('restok_secret', 1_786_560_540, 1_789_238_940))),
            { status: 200 },
          )
        },
      }),
      home,
    )
    expect(outcome.available).toBe(true)
    const body = JSON.parse(outcome.body ?? '{}') as Record<string, unknown>
    expect(body.remainingResets).toBe(1)
    expect(body.resetsExpireAt).toBe(1_789_238_940_000)
    expect(body.percent).toBe(42.5)
  })

  it('never lets the redemption token_id reach the body or the errors', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const outcome = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: () => new Response(JSON.stringify({ config: { creditUsagePercent: 10 } }), { status: 200 }),
        [SETTINGS_URL]: () => new Response('{}', { status: 200 }),
        [RESETS_URL]: () => new Response(dataFrame(delimited(10, resetToken('restok_handle', 1, 1_789_238_940))), { status: 200 }),
      }),
      home,
    )
    expect(outcome.available).toBe(true)
    expect(outcome.body).not.toContain('restok_handle')
    expect(JSON.stringify(outcome)).not.toContain('restok_handle')
  })

  it('keeps the billing numbers when the resets call fails in any way', async () => {
    const home = await tempDir('grok-quota-')
    await writeAuth(home, { 'https://auth.x.ai::supergrok': { key: 'grok-secret' } })
    const billing = (): Response => new Response(JSON.stringify({ config: { creditUsagePercent: 42.5 } }), { status: 200 })
    const settings = (): Response => new Response('{}', { status: 200 })

    const httpFailure = await fetchGrokUsage(
      scriptedFetch({ [BILLING_URL]: billing, [SETTINGS_URL]: settings, [RESETS_URL]: () => new Response('no', { status: 500 }) }),
      home,
    )
    const grpcFailure = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: billing,
        [SETTINGS_URL]: settings,
        [RESETS_URL]: () => new Response(trailerFrame('grpc-status:7\r\n'), { status: 200 }),
      }),
      home,
    )
    const transportFailure = await fetchGrokUsage(
      scriptedFetch({
        [BILLING_URL]: billing,
        [SETTINGS_URL]: settings,
        [RESETS_URL]: () => {
          throw new Error('network down')
        },
      }),
      home,
    )
    for (const outcome of [httpFailure, grpcFailure, transportFailure]) {
      expect(outcome.available).toBe(true)
      const body = JSON.parse(outcome.body ?? '{}') as Record<string, unknown>
      expect(body.percent).toBe(42.5)
      expect(body.remainingResets).toBeUndefined()
      expect(body.resetsExpireAt).toBeUndefined()
    }
  })
})
