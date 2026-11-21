import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  clearOpendesignCredential,
  fetchOpendesignQuota,
  initOpendesignStore,
  normalizeOpendesignCredential,
  parseOpendesignUsage,
  pollOpendesignLogin,
  readOpendesignCredential,
  saveOpendesignCredential,
  startOpendesignLogin,
} from './opendesign-quota'

// The store round-trip runs against a temp dir with a stand-in keystore: the
// ciphertext is base64("enc:<plain>"), which is enough to prove save → read
// → clear without a real OS keystore.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString()
      return text.startsWith('enc:') ? text.slice(4) : text
    },
  },
}))

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const impl =
  (routes: (url: string, init?: RequestInit) => Response): FetchImpl =>
  async (url, init) =>
    routes(url, init)

// Obviously synthetic fixture values — real credentials never appear in tests.
// The control-key prefix is assembled by concatenation so credential scanners
// do not mistake the fixture for a live token.
const FIXTURE_COOKIE = 'session=demo; extra=v1'
const FIXTURE_CONTROL_KEY = 'vela_ctrl_' + 'demo-key-00000000'
const DEVICE_SECRET = 'demo-device-secret'
const WORKSPACE = 'ws_demo01'

const tempDirs: string[] = []
async function newTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) void rm(dir, { recursive: true, force: true })
})

const usagePayload = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: WORKSPACE,
  workspaceMemberId: 'member-1',
  eligible: true,
  windows: [
    {
      policyId: 'p-5h',
      durationSeconds: 18_000,
      usedCredits: '1200',
      remainingCredits: '8800',
      limitCredits: '10000',
      resetsAt: '2026-11-21T18:00:00.000Z',
    },
    {
      policyId: 'p-7d',
      durationSeconds: 604_800,
      usedCredits: '40000',
      remainingCredits: '60000',
      limitCredits: '100000',
      resetsAt: '2026-11-24T00:00:00.000Z',
    },
  ],
  ...overrides,
})

describe('normalizeOpendesignCredential', () => {
  it('accepts a control key and a full cookie header, normalizing both', () => {
    expect(normalizeOpendesignCredential(FIXTURE_CONTROL_KEY)).toEqual({
      kind: 'control-key',
      authorization: `Bearer ${FIXTURE_CONTROL_KEY}`,
    })
    expect(normalizeOpendesignCredential(`cookie: ${FIXTURE_COOKIE}`)).toEqual({
      kind: 'cookie',
      header: FIXTURE_COOKIE,
    })
    expect(normalizeOpendesignCredential(`  ${FIXTURE_COOKIE}  `)).toEqual({
      kind: 'cookie',
      header: FIXTURE_COOKIE,
    })
  })

  it('rejects inference keys, whitespace and non-credential text', () => {
    expect(normalizeOpendesignCredential('sk-amr_demo')).toBeNull()
    expect(normalizeOpendesignCredential('vela_ctrl_demo\nsecond-line')).toBeNull()
    expect(normalizeOpendesignCredential('vela_ctrl_short')).toBeNull()
    expect(normalizeOpendesignCredential('just some prose')).toBeNull()
    expect(normalizeOpendesignCredential(42)).toBeNull()
    expect(normalizeOpendesignCredential(`vela_ctrl_${'x'.repeat(17_000)}`)).toBeNull()
    expect(normalizeOpendesignCredential(`${FIXTURE_COOKIE}\nother=1`)).toBeNull()
  })
})

describe('credential store', () => {
  it('round-trips the credential through the encrypted file, not just memory', async () => {
    const dir = await newTempDir('opendesign-store-')
    initOpendesignStore(dir)
    expect(await readOpendesignCredential()).toBeNull()
    expect(await saveOpendesignCredential(FIXTURE_CONTROL_KEY)).toEqual({ ok: true })
    // Reading through a fresh store instance simulates an app restart: the
    // answer must come from the decrypted file, not the memory cache.
    initOpendesignStore(dir)
    expect(await readOpendesignCredential()).toEqual({
      kind: 'control-key',
      authorization: `Bearer ${FIXTURE_CONTROL_KEY}`,
    })
    // The file carries only the encrypted blob, never the plaintext credential
    const raw = await readFile(join(dir, 'opendesign-cookie.json'), 'utf8')
    expect(raw).not.toContain(FIXTURE_CONTROL_KEY)
    expect(raw).toMatch(/"credential":"[A-Za-z0-9+/=]+"/)
    await clearOpendesignCredential()
    expect(await readOpendesignCredential()).toBeNull()
    // An invalid paste never reaches the store
    expect(await saveOpendesignCredential('just some prose')).toEqual({ ok: false, reason: 'invalid' })
    expect(await readOpendesignCredential()).toBeNull()
  })

  it('refuses a tampered or unknown-version store instead of guessing', async () => {
    const dir = await newTempDir('opendesign-store-')
    // A blob that decrypts to something that is not a credential JSON
    const tampered = Buffer.from('not a credential at all').toString('base64')
    await writeFile(join(dir, 'opendesign-cookie.json'), JSON.stringify({ version: 2, credential: tampered }), 'utf8')
    initOpendesignStore(dir)
    expect(await readOpendesignCredential()).toBeNull()
    // An unknown file version is refused wholesale rather than misread
    const future = Buffer.from(
      JSON.stringify({ kind: 'control-key', authorization: `Bearer ${FIXTURE_CONTROL_KEY}` }),
    ).toString('base64')
    await writeFile(join(dir, 'opendesign-cookie.json'), JSON.stringify({ version: 3, credential: future }), 'utf8')
    initOpendesignStore(dir)
    expect(await readOpendesignCredential()).toBeNull()
  })
})

describe('parseOpendesignUsage', () => {
  it('maps windows by duration and keeps three-decimal precision on non-integer ratios', () => {
    const payload = usagePayload()
    ;(payload.windows as Array<Record<string, unknown>>)[0]!.usedCredits = '1'
    ;(payload.windows as Array<Record<string, unknown>>)[0]!.remainingCredits = '2'
    ;(payload.windows as Array<Record<string, unknown>>)[0]!.limitCredits = '3'
    const rows = parseOpendesignUsage(payload, WORKSPACE)
    expect(rows).toEqual([
      { id: 'fiveHour', percent: 33.333, resetsAt: Date.parse('2026-11-21T18:00:00.000Z') },
      { id: 'weekly', percent: 40, resetsAt: Date.parse('2026-11-24T00:00:00.000Z') },
    ])
  })

  it('handles counters beyond 2^53 via BigInt without precision loss', () => {
    // 9999999999999999999999999 / 20000000000000000000000000 → 49.999 after
    // the contract's ×100000/÷1000; remaining must equal limit − used exactly.
    const payload = usagePayload({
      windows: [
        {
          policyId: 'p-big',
          durationSeconds: 18_000,
          usedCredits: '9999999999999999999999999',
          remainingCredits: '10000000000000000000000001',
          limitCredits: '20000000000000000000000000',
          resetsAt: null,
        },
      ],
    })
    expect(parseOpendesignUsage(payload, WORKSPACE)).toEqual([{ id: 'fiveHour', percent: 49.999, resetsAt: null }])
  })

  it('lands unknown durations on other and clamps an over-limit row to 100', () => {
    const payload = usagePayload({
      windows: [
        { policyId: 'a', durationSeconds: 300, usedCredits: '5', remainingCredits: '0', limitCredits: '5', resetsAt: null },
        { policyId: 'b', durationSeconds: 18_000, usedCredits: '99999', remainingCredits: '0', limitCredits: '10', resetsAt: null },
      ],
    })
    const rows = parseOpendesignUsage(payload, WORKSPACE)
    expect(rows).toEqual([
      { id: 'other', percent: 100, resetsAt: null },
      { id: 'fiveHour', percent: 100, resetsAt: null },
    ])
  })

  it('unwraps the preflight codingPlan wrapper when both identities agree', () => {
    const inner = usagePayload()
    const wrapped = { workspaceId: WORKSPACE, codingPlan: inner }
    expect(parseOpendesignUsage(wrapped, WORKSPACE)).toEqual(parseOpendesignUsage(inner, WORKSPACE))
    // A wrapper whose inner workspace disagrees is drift, not a reading
    const conflicting = { workspaceId: WORKSPACE, codingPlan: usagePayload({ workspaceId: 'ws_other' }) }
    expect(parseOpendesignUsage(conflicting, WORKSPACE)).toBeNull()
  })

  it('fails closed on identity drift, arithmetic drift and eligible mismatch', () => {
    expect(parseOpendesignUsage(usagePayload({ workspaceId: 'ws_other' }), WORKSPACE)).toBeNull()
    const badMath = usagePayload()
    ;(badMath.windows as Array<Record<string, unknown>>)[0]!.remainingCredits = '100'
    expect(parseOpendesignUsage(badMath, WORKSPACE)).toBeNull()
    expect(parseOpendesignUsage(usagePayload({ eligible: false }), WORKSPACE)).toBeNull()
    expect(parseOpendesignUsage(usagePayload({ windows: [] }), WORKSPACE)).toBeNull()
    const stringy = usagePayload()
    ;(stringy.windows as Array<Record<string, unknown>>)[0]!.usedCredits = 1200
    expect(parseOpendesignUsage(stringy, WORKSPACE)).toBeNull()
    // A member id serialized as null (gateway-tolerated) is treated as absent
    expect(parseOpendesignUsage(usagePayload({ workspaceMemberId: null }), WORKSPACE)).not.toBeNull()
  })
})

describe('device-code login', () => {
  const startResponse = () =>
    new Response(
      JSON.stringify({
        deviceId: 'dev-123',
        deviceSecret: DEVICE_SECRET,
        userCode: 'AB12CD',
        activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-123&userCode=AB12CD',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        pollIntervalSeconds: 1,
      }),
      { status: 200 },
    )

  it('validates the start response and assembles the approval page locally', async () => {
    const urls: string[] = []
    const started = await startOpendesignLogin(
      impl((url) => {
        urls.push(url)
        return startResponse()
      }),
      'coding-usage',
    )
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.session.userCode).toBe('AB12CD')
    expect(started.session.url).toBe('https://open-design.ai/cloud/cli/activate?deviceId=dev-123&userCode=AB12CD')
    expect(urls[0]).toBe('https://amr-api.open-design.ai/api/v1/cli/device-authorizations')
    // An upstream body pointing anywhere else must fail rather than be opened
    const hijacked = await startOpendesignLogin(
      impl(() =>
        new Response(
          JSON.stringify({
            deviceId: 'dev-123',
            deviceSecret: DEVICE_SECRET,
            userCode: 'AB12CD',
            activationUrl: 'https://evil.example/activate',
          }),
          { status: 200 },
        ),
      ),
      'coding-usage',
    )
    expect(hijacked).toEqual({ ok: false, reason: 'invalid' })
  })

  it('polls to approved (storing the control key), then consumes the session', async () => {
    initOpendesignStore(await newTempDir('opendesign-login-'))
    const started = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!started.ok) throw new Error('start failed')
    // Pending keeps the session alive
    const pending = await pollOpendesignLogin(impl(() => new Response(JSON.stringify({ status: 'pending' }), { status: 200 })), started.session.loginId)
    expect(pending).toEqual({ status: 'pending' })
    // Approved stores the control key in the encrypted slot; the key itself
    // never appears in the poll answer
    const approved = await pollOpendesignLogin(
      impl(() => new Response(JSON.stringify({ controlKey: FIXTURE_CONTROL_KEY }), { status: 200 })),
      started.session.loginId,
    )
    expect(approved).toEqual({ status: 'approved' })
    expect(await readOpendesignCredential()).toEqual({
      kind: 'control-key',
      authorization: `Bearer ${FIXTURE_CONTROL_KEY}`,
    })
    // The session is consumed after approval
    const consumed = await pollOpendesignLogin(
      impl(() => new Response(JSON.stringify({ controlKey: FIXTURE_CONTROL_KEY }), { status: 200 })),
      started.session.loginId,
    )
    expect(consumed).toEqual({ status: 'failed', reason: 'expired' })
  })

  it('maps terminal statuses and unknown devices to their failure reasons', async () => {
    // Each terminal status consumes its own session, so every case starts one
    const deniedSession = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!deniedSession.ok) throw new Error('start failed')
    const denied = await pollOpendesignLogin(
      impl(() => new Response(JSON.stringify({ status: 'denied' }), { status: 200 })),
      deniedSession.session.loginId,
    )
    expect(denied).toEqual({ status: 'failed', reason: 'denied' })
    const cancelledSession = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!cancelledSession.ok) throw new Error('start failed')
    const cancelled = await pollOpendesignLogin(
      impl(() => new Response(JSON.stringify({ status: 'cancelled' }), { status: 200 })),
      cancelledSession.session.loginId,
    )
    expect(cancelled).toEqual({ status: 'failed', reason: 'cancelled' })
    const unknownDevice = await pollOpendesignLogin(impl(() => new Response('{}', { status: 200 })), cancelledSession.session.loginId + 999)
    expect(unknownDevice).toEqual({ status: 'failed', reason: 'expired' })
  })

  it('classifies start failures and clamps the server poll interval', async () => {
    const networkDown = await startOpendesignLogin(
      impl(() => {
        throw new Error('network down')
      }),
      'coding-usage',
    )
    expect(networkDown).toEqual({ ok: false, reason: 'network' })
    const refused = await startOpendesignLogin(impl(() => new Response('no', { status: 500 })), 'coding-usage')
    expect(refused).toEqual({ ok: false, reason: 'start-failed' })
    // The server's suggested cadence is clamped into 1s…15s
    const clamped = await startOpendesignLogin(
      impl(() =>
        new Response(
          JSON.stringify({
            deviceId: 'dev-123',
            deviceSecret: DEVICE_SECRET,
            userCode: 'AB12CD',
            activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-123&userCode=AB12CD',
            pollIntervalSeconds: 100,
          }),
          { status: 200 },
        ),
      ),
      'coding-usage',
    )
    expect(clamped.ok).toBe(true)
    if (clamped.ok) expect(clamped.session.intervalMs).toBe(15_000)
  })

  it('keeps a live session on transport jitter and ends it on explicit 401', async () => {
    const started = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!started.ok) throw new Error('start failed')
    // A transport throw is jitter, not an auth failure: the session survives
    const jitter = await pollOpendesignLogin(
      impl(() => {
        throw new Error('connection reset')
      }),
      started.session.loginId,
    )
    expect(jitter).toEqual({ status: 'pending' })
    // A 401 ends it: the code was revoked or expired server-side
    const revoked = await pollOpendesignLogin(impl(() => new Response('no', { status: 401 })), started.session.loginId)
    expect(revoked).toEqual({ status: 'failed', reason: 'expired' })
  })

  it('keeps polling when an approved response carries no control key yet', async () => {
    const started = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!started.ok) throw new Error('start failed')
    // HTTP 200 without a controlKey means "not approved yet", not a failure
    const stillWaiting = await pollOpendesignLogin(impl(() => new Response('{}', { status: 200 })), started.session.loginId)
    expect(stillWaiting).toEqual({ status: 'pending' })
  })

  it('classifies poll responses by status before the body, keeping 429 and 5xx recoverable', async () => {
    const started = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!started.ok) throw new Error('start failed')
    // A plain-text 403 (WAF page) is still a denial — classification must not
    // depend on the body parsing as JSON
    const wafDenied = await pollOpendesignLogin(impl(() => new Response('blocked', { status: 403 })), started.session.loginId)
    expect(wafDenied).toEqual({ status: 'failed', reason: 'denied' })
    const session2 = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!session2.ok) throw new Error('start failed')
    // Rate limiting and server errors are recoverable, with or without a JSON body
    const rateLimited = await pollOpendesignLogin(impl(() => new Response('{"error":"slow down"}', { status: 429 })), session2.session.loginId)
    expect(rateLimited).toEqual({ status: 'pending' })
    const serverError = await pollOpendesignLogin(impl(() => new Response('{"error":"oops"}', { status: 503 })), session2.session.loginId)
    expect(serverError).toEqual({ status: 'pending' })
    // A revoked grant is terminal even without a JSON body
    const revokedSession = await startOpendesignLogin(impl(() => startResponse()), 'coding-usage')
    if (!revokedSession.ok) throw new Error('start failed')
    const revoked = await pollOpendesignLogin(impl(() => new Response('revoked', { status: 400 })), revokedSession.session.loginId)
    expect(revoked).toEqual({ status: 'failed', reason: 'invalid' })
  })
})

describe('fetchOpendesignQuota', () => {
  function okJson(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200 })
  }

  it('returns no-auth without a credential', async () => {
    expect(await fetchOpendesignQuota(async () => okJson({}), null)).toEqual({ available: false, reason: 'no-auth' })
  })

  it('cookie route: discovery carries only the cookie, usage the workspace header', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const outcome = await fetchOpendesignQuota(
      impl((url, init) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
        if (url.endsWith('/workspaces/current')) return okJson({ activeWorkspaceId: WORKSPACE })
        return okJson(usagePayload())
      }),
      { kind: 'cookie', header: FIXTURE_COOKIE },
    )
    expect(calls[0]).toEqual({
      url: 'https://amr-api.open-design.ai/api/v1/workspaces/current',
      headers: { Cookie: FIXTURE_COOKIE, Accept: 'application/json' },
    })
    expect(calls[1]?.headers).toEqual({
      Cookie: FIXTURE_COOKIE,
      Accept: 'application/json',
      'x-vela-workspace-id': WORKSPACE,
    })
    expect(outcome.available).toBe(true)
    // The persisted body must not echo the credential
    expect(outcome.body).not.toContain(FIXTURE_COOKIE)
    expect(JSON.parse(outcome.body ?? '{}').windows).toEqual([
      { id: 'fiveHour', percent: 12, resetsAt: Date.parse('2026-11-21T18:00:00.000Z') },
      { id: 'weekly', percent: 40, resetsAt: Date.parse('2026-11-24T00:00:00.000Z') },
    ])
  })

  it('control-key route: bearer auth with the preflight wrapper and no wallet call', async () => {
    const calls: string[] = []
    const outcome = await fetchOpendesignQuota(
      impl((url) => {
        calls.push(url)
        if (url.endsWith('/workspaces/current')) return okJson({ activeWorkspaceId: WORKSPACE })
        if (url.endsWith('/billing/preflight')) return okJson({ workspaceId: WORKSPACE, codingPlan: usagePayload() })
        return new Response('no', { status: 500 })
      }),
      { kind: 'control-key', authorization: `Bearer ${FIXTURE_CONTROL_KEY}` },
    )
    expect(calls.some((url) => url.endsWith('/billing/preflight'))).toBe(true)
    // The wallet endpoint is not called: nothing renders it today, and an
    // unrendered field is not worth a request on the card's critical path
    expect(calls.some((url) => url.endsWith('/wallet/balance'))).toBe(false)
    expect(outcome.available).toBe(true)
    const body = JSON.parse(outcome.body ?? '{}') as { windows: unknown; walletUsd: unknown }
    expect(body.windows).toEqual(parseOpendesignUsage(usagePayload(), WORKSPACE))
    expect(body).not.toHaveProperty('walletUsd')
    // The credential must not leak into the persisted body
    expect(outcome.body).not.toContain(FIXTURE_CONTROL_KEY)
  })

  it('maps auth refusal, server errors and a workspace without a plan', async () => {
    const reauth = await fetchOpendesignQuota(async () => new Response('no', { status: 401 }), {
      kind: 'cookie',
      header: FIXTURE_COOKIE,
    })
    expect(reauth).toEqual({ available: false, reason: 'reauth' })
    const serverError = await fetchOpendesignQuota(
      impl((url) => {
        if (url.endsWith('/workspaces/current')) return okJson({ activeWorkspaceId: WORKSPACE })
        return new Response('no', { status: 500 })
      }),
      { kind: 'cookie', header: FIXTURE_COOKIE },
    )
    expect(serverError).toEqual({ available: false, reason: 'http-500' })
    const noPlan = await fetchOpendesignQuota(
      impl((url) => {
        if (url.endsWith('/workspaces/current')) return okJson({ activeWorkspaceId: WORKSPACE })
        return okJson(usagePayload({ eligible: false, windows: [] }))
      }),
      { kind: 'cookie', header: FIXTURE_COOKIE },
    )
    expect(noPlan).toEqual({ available: false, reason: 'no-plan' })
    const network = await fetchOpendesignQuota(
      impl(() => {
        throw new Error('network down')
      }),
      { kind: 'cookie', header: FIXTURE_COOKIE },
    )
    expect(network).toEqual({ available: false, reason: 'network' })
    const timedOut = await fetchOpendesignQuota(
      impl(() => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
      }),
      { kind: 'cookie', header: FIXTURE_COOKIE },
    )
    expect(timedOut).toEqual({ available: false, reason: 'timeout' })
  })
})
