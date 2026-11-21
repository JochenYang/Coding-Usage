import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchTraeIntlUsage, fetchTraeUsage, intlRegionOf } from './trae-usage'

/**
 * Scripted-fetch tests for the Trae CN credits probe (P27 / T5). The login
 * fixture is built with the same derivation the IDE's frontend uses and
 * decryptTcValue consumes (6-byte "tc" header, SHA-512 over the random block
 * XOR-folded with the frontend salts, AES-128-CBC, body preceded by a SHA-512
 * checksum) so the test exercises the real decryption path. The two salt
 * arrays are transcribed verbatim from trae-usage.ts — they originate in
 * Trae CN's frontend JS, not in this app, so any drift between the copies
 * (or an upstream salt change) surfaces as a failing decrypt test.
 *
 * The outcome body is what quota-cache.json persists verbatim, so the success
 * assertions double as the store-boundary guard: percent/consumed/total/packs
 * only — never the JWT or the userId.
 */

const dirs: string[] = []
const originalAppData = process.env.APPDATA

afterEach(async () => {
  // The probe reads process.env.APPDATA; restore whatever the host had
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** mkdtemp + point APPDATA at it (the probe's only app-data discovery input) */
async function tempAppData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trae-quota-'))
  dirs.push(dir)
  process.env.APPDATA = dir
  return dir
}

// Verbatim from trae-usage.ts ("tc"-AES salt pair, A⊕B)
const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155,
  47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76,
  149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181,
  74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235,
  187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])

const SALT_AB = new Uint8Array(64)
for (let i = 0; i < 64; i++) SALT_AB[i] = SALT_A[i] ^ SALT_B[i]

/** Build a storage.json "tc" value exactly the way Trae CN's frontend does */
function buildTcBlob(body: object): string {
  const random = randomBytes(32)
  const bodyBytes = Buffer.from(JSON.stringify(body), 'utf8')
  const plain = Buffer.concat([createHash('sha512').update(bodyBytes).digest(), bodyBytes])
  const keyMaterial = createHash('sha512')
    .update(Buffer.concat([createHash('sha512').update(random).digest(), SALT_AB]))
    .digest()
  const cipher = createCipheriv('aes-128-cbc', keyMaterial.subarray(0, 16), keyMaterial.subarray(16, 32))
  return Buffer.concat([
    Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]),
    random,
    Buffer.concat([cipher.update(plain), cipher.final()]),
  ]).toString('base64')
}

function tamperedTcBlob(body: object): string {
  const buf = Buffer.from(buildTcBlob(body), 'base64')
  buf[buf.length - 1] ^= 0xff
  return buf.toString('base64')
}

const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide'

async function writeStorage(appData: string, product: string, value: unknown): Promise<void> {
  const dir = join(appData, product, 'User', 'globalStorage')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'storage.json'), JSON.stringify({ [AUTH_KEY]: value }))
}

interface RecordedCall {
  url: string
  method: string
  body: string
  headers: Record<string, string>
}

/** Answers per URL and records the request facts; unexpected URLs fail the test */
function scriptedFetch(
  handlers: Record<string, (url: string, init: RequestInit) => Response>,
  calls?: RecordedCall[],
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    calls?.push({
      url,
      method: init.method ?? 'GET',
      body: String(init.body ?? ''),
      headers: Object.fromEntries(new Headers(init.headers)),
    })
    return handler(url, init)
  }
}

const USAGE_URL = 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage'

/** Entitlement list where only the first and last entries may surface */
const USAGE_OK = {
  usage_summary: { consumed_amount: 120, total_amount: 500, consumption_ratio: 0.25 },
  user_entitlement_pack_list: [
    {
      display_desc: 'Monthly pack',
      expire_time: 2_100_000_000,
      status: 1,
      is_hide: false,
      entitlement_base_info: { quota: { credits_limit: 400 } },
    },
    // hidden / inactive / nameless entries must be dropped before aggregation
    { display_desc: 'Hidden pack', expire_time: 2_300_000_000, status: 1, is_hide: true },
    { display_desc: 'Inactive pack', expire_time: 2_400_000_000, status: 2 },
    { display_desc: '', status: 1 },
    { display_desc: 'Pack without quota', expire_time: 2_200_000_000, status: 1, is_hide: false },
  ],
  is_credits_billing: true,
}

const FUTURE_EXPIRY = '2030-01-01T00:00:00.000Z'

describe('fetchTraeUsage', () => {
  it('returns no-auth-file and never fetches when no Trae layout exists', async () => {
    await tempAppData()
    const outcome = await fetchTraeUsage(scriptedFetch({}), 'unused-home')
    expect(outcome).toEqual({ available: false, reason: 'no-auth-file' })
  })

  it('returns no-auth-token when storage.json carries no auth entry', async () => {
    const appData = await tempAppData()
    const dir = join(appData, 'TRAE SOLO CN', 'User', 'globalStorage')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'storage.json'), JSON.stringify({ unrelated: 'value' }))
    const outcome = await fetchTraeUsage(scriptedFetch({}), 'unused-home')
    expect(outcome).toEqual({ available: false, reason: 'no-auth-token' })
  })

  it('returns no-auth-token for a value the shim does not recognize', async () => {
    const appData = await tempAppData()
    await writeStorage(appData, 'TRAE SOLO CN', 'definitely-not-a-blob')
    const outcome = await fetchTraeUsage(scriptedFetch({}), 'unused-home')
    expect(outcome).toEqual({ available: false, reason: 'no-auth-token' })
  })

  it('returns no-auth-token when the tc ciphertext is corrupted', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      tamperedTcBlob({ token: 'trae-jwt-secret', userId: 'u-123', expiredAt: FUTURE_EXPIRY }),
    )
    const outcome = await fetchTraeUsage(scriptedFetch({}), 'unused-home')
    expect(outcome).toEqual({ available: false, reason: 'no-auth-token' })
  })

  it('rejects an expired token before fetching', async () => {
    const appData = await tempAppData()
    await writeStorage(
      // the second-priority layout must be found when the first is absent
      appData,
      'Trae CN',
      buildTcBlob({ token: 'trae-jwt-secret', userId: 'u-123', expiredAt: '2020-01-01T00:00:00.000Z' }),
    )
    const outcome = await fetchTraeUsage(scriptedFetch({}), 'unused-home')
    expect(outcome).toEqual({ available: false, reason: 'token-expired' })
  })

  it('decrypts the tc blob, posts the entitlement endpoint and returns only the narrowed numbers', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      buildTcBlob({ token: 'trae-jwt-secret', refreshToken: 'r-secret', userId: 'u-123', expiredAt: FUTURE_EXPIRY }),
    )
    // the machineid file rides next to the storage dir and becomes a header
    await mkdir(join(appData, 'TRAE SOLO CN'), { recursive: true })
    await writeFile(join(appData, 'TRAE SOLO CN', 'machineid'), ' machine-abc\n')
    const calls: RecordedCall[] = []
    const outcome = await fetchTraeUsage(scriptedFetch({ [USAGE_URL]: () => new Response(JSON.stringify(USAGE_OK), { status: 200 }) }, calls), 'unused-home')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toBe('{}')
    expect(calls[0]?.headers.authorization).toBe('Cloud-IDE-JWT trae-jwt-secret')
    expect(calls[0]?.headers['x-cloudide-token']).toBe('trae-jwt-secret')
    expect(calls[0]?.headers['x-uid']).toBe('u-123')
    expect(calls[0]?.headers['x-machine-id']).toBe('machine-abc')
    expect(calls[0]?.headers['x-app-id']).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
    expect(calls[0]?.headers['x-device-type']).toBe('windows')
    expect(calls[0]?.headers['content-type']).toBe('application/json')

    expect(outcome.available).toBe(true)
    // The persisted body must not carry the JWT, the refresh token or the userId
    expect(outcome.body).not.toContain('trae-jwt-secret')
    expect(outcome.body).not.toContain('r-secret')
    expect(outcome.body).not.toContain('u-123')
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      percent: 25,
      consumed: 120,
      total: 500,
      unit: 'credits',
      // reset anchor: the earliest expiring active pack
      resetsAt: 2_100_000_000_000,
      plan: 'Trae CN',
      packs: [
        { name: 'Monthly pack', credits: 400, resetsAt: 2_100_000_000_000 },
        { name: 'Pack without quota', credits: null, resetsAt: 2_200_000_000_000 },
      ],
    })
  })

  it('derives the percentage from consumed/total when consumption_ratio is absent', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      buildTcBlob({ token: 'trae-jwt-secret', userId: 'u-123', expiredAt: FUTURE_EXPIRY }),
    )
    const outcome = await fetchTraeUsage(
      scriptedFetch({
        [USAGE_URL]: () =>
          new Response(JSON.stringify({ usage_summary: { consumed_amount: 125, total_amount: 500 } }), { status: 200 }),
      }),
      'unused-home',
    )
    expect(outcome.available).toBe(true)
    const body = JSON.parse(outcome.body ?? '{}') as { percent: number; plan: unknown; packs: unknown[] }
    expect(body.percent).toBe(25)
    expect(body.plan).toBeNull()
    expect(body.packs).toEqual([])
  })

  it('clamps a percentage reported outside 0-100', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      buildTcBlob({ token: 'trae-jwt-secret', userId: 'u-123', expiredAt: FUTURE_EXPIRY }),
    )
    const outcome = await fetchTraeUsage(
      scriptedFetch({
        [USAGE_URL]: () =>
          new Response(
            JSON.stringify({ usage_summary: { consumed_amount: 2, total_amount: 100, consumption_ratio: 1.4 } }),
            { status: 200 },
          ),
      }),
      'unused-home',
    )
    expect(JSON.parse(outcome.body ?? '{}').percent).toBe(100)
  })

  it('accepts the plaintext-JSON auth value defensively', async () => {
    // International builds keep the same key as plaintext JSON; the shim
    // tolerates that layout instead of reporting a torn blob.
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      JSON.stringify({ token: 'plain-token', userId: 'u-9', expiredAt: FUTURE_EXPIRY }),
    )
    const calls: RecordedCall[] = []
    const outcome = await fetchTraeUsage(
      scriptedFetch(
        {
          [USAGE_URL]: () =>
            new Response(JSON.stringify({ usage_summary: { consumed_amount: 125, total_amount: 500 } }), { status: 200 }),
        },
        calls,
      ),
      'unused-home',
    )
    expect(calls[0]?.headers.authorization).toBe('Cloud-IDE-JWT plain-token')
    expect(calls[0]?.headers['x-uid']).toBe('u-9')
    expect(outcome.available).toBe(true)
  })

  it('maps a 401 to the http reason without echoing the response body', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      buildTcBlob({ token: 'trae-jwt-secret', userId: 'u-123', expiredAt: FUTURE_EXPIRY }),
    )
    const outcome = await fetchTraeUsage(
      scriptedFetch({ [USAGE_URL]: () => new Response('{"error":"expired"}', { status: 401 }) }),
      'unused-home',
    )
    expect(outcome).toEqual({ available: false, reason: 'http-401' })
  })

  it('returns malformed-body when usage_summary carries no usable totals', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      buildTcBlob({ token: 'trae-jwt-secret', userId: 'u-123', expiredAt: FUTURE_EXPIRY }),
    )
    const outcome = await fetchTraeUsage(
      scriptedFetch({ [USAGE_URL]: () => new Response(JSON.stringify({ usage_summary: { consumed_amount: 1 } }), { status: 200 }) }),
      'unused-home',
    )
    expect(outcome).toEqual({ available: false, reason: 'malformed-body' })
  })

  it('maps a transport failure to probe-failed', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO CN',
      buildTcBlob({ token: 'trae-jwt-secret', userId: 'u-123', expiredAt: FUTURE_EXPIRY }),
    )
    const outcome = await fetchTraeUsage(
      scriptedFetch({
        [USAGE_URL]: () => {
          throw new Error('network down')
        },
      }),
      'unused-home',
    )
    expect(outcome).toEqual({ available: false, reason: 'probe-failed' })
  })
})

// ===== Trae international (SG/US deployment) =====

const INTL_SG_URL = 'https://api-sg-central.trae.ai/trae/api/v1/pay/user_current_entitlement_list'
const INTL_US_URL = 'https://api-us-east.trae.ai/trae/api/v1/pay/user_current_entitlement_list'

/** The international entitlement list: USD-denominated basic/bonus packs */
const INTL_OK = {
  code: 0,
  data: {
    user_entitlement_pack_list: [
      {
        display_desc: 'Pro monthly',
        entitlement_base_info: {
          quota: { basic_usage_limit: 20, bonus_usage_limit: 5 },
          end_time: 2_100_000_000,
        },
        usage: { basic_usage_amount: 4.5, bonus_usage_amount: 0.5 },
      },
      // A second pack with an earlier expiry anchors the reset countdown
      {
        display_desc: 'Signup bonus',
        entitlement_base_info: {
          quota: { basic_usage_limit: 3 },
          expire_time: 2_050_000_000,
        },
        usage: { basic_usage_amount: 3 },
      },
      // A pack without a quota carries no numbers and must not break the sum
      { display_desc: 'Empty pack' },
    ],
  },
}

describe('fetchTraeIntlUsage', () => {
  it('returns no-auth-file when only the CN layout exists', async () => {
    const appData = await tempAppData()
    await writeStorage(appData, 'TRAE SOLO CN', buildTcBlob({ token: 'trae-jwt-secret', userId: 'u-123' }))
    const outcome = await fetchTraeIntlUsage(scriptedFetch({}), 'unused-home')
    expect(outcome).toEqual({ available: false, reason: 'no-auth-file' })
  })

  it('rejects an expired token before fetching', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO',
      JSON.stringify({ token: 'plain-token', userId: 'u-9', expiredAt: '2020-01-01T00:00:00.000Z' }),
    )
    const outcome = await fetchTraeIntlUsage(scriptedFetch({}), 'unused-home')
    expect(outcome).toEqual({ available: false, reason: 'token-expired' })
  })

  it('reads the plaintext login, posts the SG endpoint and returns only narrowed USD numbers', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'TRAE SOLO',
      JSON.stringify({ token: 'intl-jwt-secret', refreshToken: 'r-secret', userId: 'u-intl', expiredAt: FUTURE_EXPIRY }),
    )
    await mkdir(join(appData, 'TRAE SOLO'), { recursive: true })
    await writeFile(join(appData, 'TRAE SOLO', 'machineid'), ' machine-intl\n')
    const calls: RecordedCall[] = []
    const outcome = await fetchTraeIntlUsage(
      scriptedFetch({ [INTL_SG_URL]: () => new Response(JSON.stringify(INTL_OK), { status: 200 }) }, calls),
      'unused-home',
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toBe('{}')
    expect(calls[0]?.headers.authorization).toBe('Cloud-IDE-JWT intl-jwt-secret')
    expect(calls[0]?.headers['x-cloudide-token']).toBe('intl-jwt-secret')
    expect(calls[0]?.headers['x-uid']).toBe('u-intl')
    expect(calls[0]?.headers['x-machine-id']).toBe('machine-intl')
    expect(calls[0]?.headers['x-app-id']).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')

    expect(outcome.available).toBe(true)
    // The persisted body must not carry the JWT, the refresh token or the userId
    expect(outcome.body).not.toContain('intl-jwt-secret')
    expect(outcome.body).not.toContain('r-secret')
    expect(outcome.body).not.toContain('u-intl')
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      // (4.5 + 0.5 + 3) / (20 + 5 + 3)
      percent: (8 / 28) * 100,
      consumed: 8,
      total: 28,
      unit: 'USD',
      // reset anchor: the earliest expiring pack still in the future
      resetsAt: 2_050_000_000_000,
      plan: null,
      packs: [
        { name: 'Pro monthly', credits: 25, resetsAt: 2_100_000_000_000 },
        { name: 'Signup bonus', credits: 3, resetsAt: 2_050_000_000_000 },
      ],
    })
  })

  it('decrypts the shared tc-blob format from the second international layout', async () => {
    const appData = await tempAppData()
    await writeStorage(
      appData,
      'Trae',
      buildTcBlob({ token: 'tc-intl-secret', userId: 'u-tc', expiredAt: FUTURE_EXPIRY }),
    )
    const outcome = await fetchTraeIntlUsage(
      scriptedFetch({
        [INTL_SG_URL]: () =>
          new Response(JSON.stringify({ data: { user_entitlement_pack_list: [
            { entitlement_base_info: { quota: { basic_usage_limit: 10 } }, usage: { basic_usage_amount: 2.5 } },
          ] } }), { status: 200 }),
      }),
      'unused-home',
    )
    expect(outcome.available).toBe(true)
    const body = JSON.parse(outcome.body ?? '{}') as { percent: number; total: number }
    expect(body.percent).toBe(25)
    expect(body.total).toBe(10)
  })

  it('routes an explicit US region hint to the us-east host', async () => {
    const appData = await tempAppData()
    const dir = join(appData, 'TRAE SOLO', 'User', 'globalStorage')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'storage.json'),
      JSON.stringify({
        'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token: 'us-token', userId: 'u-us', expiredAt: FUTURE_EXPIRY }),
        userRegion: { _aiRegion: 'US-virginia' },
      }),
    )
    const calls: RecordedCall[] = []
    await fetchTraeIntlUsage(
      scriptedFetch({
        [INTL_US_URL]: () =>
          new Response(JSON.stringify({ data: { user_entitlement_pack_list: [
            { entitlement_base_info: { quota: { basic_usage_limit: 10 } }, usage: { basic_usage_amount: 5 } },
          ] } }), { status: 200 }),
      }, calls),
      'unused-home',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(INTL_US_URL)
    expect(calls[0]?.headers.authorization).toBe('Cloud-IDE-JWT us-token')
  })

  it('stays on the SG host unless a region hint is explicitly US', async () => {
    expect(intlRegionOf({})).toBe('sg')
    expect(intlRegionOf({ userRegion: { _aiRegion: 'Singapore' } })).toBe('sg')
    expect(intlRegionOf({ region: 'us' })).toBe('us')
    expect(intlRegionOf({ aiRegion: 'US' })).toBe('us')
    // A foreign host value that merely contains "us" is not a US region
    expect(intlRegionOf({ uidRegion: 'AUS-east' })).toBe('sg')
  })

  it('maps the auth-expired code to the token-expired reason', async () => {
    const appData = await tempAppData()
    await writeStorage(appData, 'TRAE SOLO', JSON.stringify({ token: 'plain-token', userId: 'u-9' }))
    const outcome = await fetchTraeIntlUsage(
      scriptedFetch({ [INTL_SG_URL]: () => new Response(JSON.stringify({ code: 1001 }), { status: 200 }) }),
      'unused-home',
    )
    expect(outcome).toEqual({ available: false, reason: 'token-expired' })
  })

  it('returns malformed-body when the payload carries no pack list or no allowance', async () => {
    const appData = await tempAppData()
    await writeStorage(appData, 'TRAE SOLO', JSON.stringify({ token: 'plain-token', userId: 'u-9' }))
    const noPacks = await fetchTraeIntlUsage(
      scriptedFetch({ [INTL_SG_URL]: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }) }),
      'unused-home',
    )
    expect(noPacks).toEqual({ available: false, reason: 'malformed-body' })
    const noAllowance = await fetchTraeIntlUsage(
      scriptedFetch({
        [INTL_SG_URL]: () =>
          new Response(JSON.stringify({ data: { user_entitlement_pack_list: [{ display_desc: 'x' }] } }), { status: 200 }),
      }),
      'unused-home',
    )
    expect(noAllowance).toEqual({ available: false, reason: 'malformed-body' })
  })

  it('maps a non-zero wrapper code to malformed-body', async () => {
    const appData = await tempAppData()
    await writeStorage(appData, 'TRAE SOLO', JSON.stringify({ token: 'plain-token', userId: 'u-9' }))
    const outcome = await fetchTraeIntlUsage(
      scriptedFetch({ [INTL_SG_URL]: () => new Response(JSON.stringify({ code: 500, message: 'server error' }), { status: 200 }) }),
      'unused-home',
    )
    expect(outcome).toEqual({ available: false, reason: 'malformed-body' })
  })

  it('maps a 401 to the http reason and a transport failure to probe-failed', async () => {
    const appData = await tempAppData()
    await writeStorage(appData, 'TRAE SOLO', JSON.stringify({ token: 'plain-token', userId: 'u-9' }))
    const unauthorized = await fetchTraeIntlUsage(
      scriptedFetch({ [INTL_SG_URL]: () => new Response('{"error":"expired"}', { status: 401 }) }),
      'unused-home',
    )
    expect(unauthorized).toEqual({ available: false, reason: 'http-401' })
    const transport = await fetchTraeIntlUsage(
      scriptedFetch({
        [INTL_SG_URL]: () => {
          throw new Error('network down')
        },
      }),
      'unused-home',
    )
    expect(transport).toEqual({ available: false, reason: 'probe-failed' })
  })
})
