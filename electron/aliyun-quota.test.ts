import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  cookieHeader,
  cookieValue,
  fetchQwenCloudQuota,
  formEncode,
  secTokenFromHtml,
  windowsFromConsolePayload,
} from './aliyun-quota'
import { sealCookieValue } from './browser-cookies'

const KEY = Buffer.alloc(32, 6)

/** A Chrome-like profile with the given cookie rows, under a temp root. */
async function profile(rows: Array<{ host: string; name: string; value: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cu-ali-'))
  const dir = join(root, 'Default', 'Network')
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'Cookies'))
  db.exec(
    'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER)',
  )
  const insert = db.prepare(
    'INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const row of rows) {
    insert.run(row.host, row.name, '', Buffer.from(sealCookieValue(row.value, KEY)), '/', 0, 1)
  }
  db.close()
  return root
}

describe('Aliyun console helpers', () => {
  it('reads one cookie by name and builds a header', () => {
    expect(cookieValue('a=1; sec_token=abc; cna=x', 'sec_token')).toBe('abc')
    expect(cookieValue('a=1', 'sec_token')).toBeNull()
    expect(cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }])).toBe('a=1; b=2')
  })

  it('finds sec_token in the dashboard bundle', () => {
    expect(secTokenFromHtml('window.x={secToken:"tok-1"}')).toBe('tok-1')
    expect(secTokenFromHtml("sec_token: 'tok-2'")).toBe('tok-2')
    expect(secTokenFromHtml('nothing here')).toBeNull()
  })

  it('form-encodes reserved characters', () => {
    expect(formEncode([['params', '{"a":"b c"}']])).toBe('params=%7B%22a%22%3A%22b%20c%22%7D')
  })
})

describe('Aliyun quota payload', () => {
  it('maps 5-hour, weekly and monthly counters', () => {
    const windows = windowsFromConsolePayload({
      data: {
        codingPlanInstanceInfos: [
          {
            planName: 'Coding Plan Pro',
            codingPlanQuotaInfo: {
              per5HourUsedQuota: 10,
              per5HourTotalQuota: 100,
              per5HourQuotaNextRefreshTime: 1_800_000_000,
              perWeekUsedQuota: 30,
              perWeekTotalQuota: 100,
              perBillMonthUsedQuota: '55',
              perBillMonthTotalQuota: '100',
            },
          },
        ],
      },
    })
    expect(windows?.map((window) => window.id)).toEqual(['ali5h', 'aliWeekly', 'aliMonthly'])
    expect(windows?.[0]?.percent).toBeCloseTo(10, 10)
    expect(windows?.[0]?.resetsAt).toBe(1_800_000_000_000)
    expect(windows?.[1]?.percent).toBeCloseTo(30, 10)
    expect(windows?.[2]?.percent).toBeCloseTo(55, 10)
  })

  it('returns null rather than 0% when only plan metadata is present', () => {
    expect(windowsFromConsolePayload({ data: { codingPlanInstanceInfos: [{ planName: 'Pro' }] } })).toBeNull()
    expect(windowsFromConsolePayload({ data: { per5HourUsedQuota: 0 } })).toBeNull()
  })
})

describe('Qwen Cloud probe', () => {
  it('says so when the browser cookie is app-bound instead of claiming no login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cu-ali-bound-'))
    const dir = join(root, 'Default', 'Network')
    await mkdir(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'Cookies'))
    db.exec(
      'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER)',
    )
    db.prepare(
      'INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('.qwencloud.com', 'session', '', Buffer.from('v20-bound'), '/', 0, 1)
    db.close()
    const outcome = await fetchQwenCloudQuota(async () => new Response('unused'), { userDataDirs: [root], key: KEY })
    expect(outcome).toEqual({ available: false, reason: 'cookie-app-bound' })
  })

  it('posts the form body and keeps the cookie out of the result', async () => {
    const root = await profile([{ host: '.qwencloud.com', name: 'sec_token', value: 'session-secret' }])
    let cookieSent = ''
    let body = ''
    const outcome = await fetchQwenCloudQuota(
      async (url, init) => {
        if (String(url).includes('/billing/')) return new Response('<html></html>', { status: 200 })
        cookieSent = new Headers(init?.headers).get('cookie') ?? ''
        body = String(init?.body ?? '')
        return new Response(
          JSON.stringify({
            data: { per5HourUsedQuota: 5, per5HourTotalQuota: 50, perWeekUsedQuota: 20, perWeekTotalQuota: 100 },
          }),
          { status: 200 },
        )
      },
      { userDataDirs: [root], key: KEY },
    )
    expect(cookieSent).toContain('sec_token=session-secret')
    expect(body).toContain('sec_token=session-secret')
    expect(outcome.body).not.toContain('session-secret')
    expect(JSON.parse(outcome.body ?? '{}').windows).toHaveLength(2)
  })

  it('reports no-auth when the browser has no cookie for the console', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cu-ali-empty-'))
    await mkdir(join(root, 'Default', 'Network'), { recursive: true })
    const db = new DatabaseSync(join(root, 'Default', 'Network', 'Cookies'))
    db.exec(
      'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER)',
    )
    db.close()
    expect(await fetchQwenCloudQuota(async () => new Response('unused'), { userDataDirs: [root], key: KEY })).toEqual({
      available: false,
      reason: 'no-auth',
    })
  })
})
