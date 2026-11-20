import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fetchKiroQuota, kiroEndpoint, windowFromKiroLimits } from './kiro-quota'

const ARN = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/abc'

describe('Kiro endpoint', () => {
  it('uses US East when there is no profile and rejects an unsupported region', () => {
    expect(kiroEndpoint(null)).toBe('https://codewhisperer.us-east-1.amazonaws.com/')
    expect(kiroEndpoint(ARN)).toBe('https://codewhisperer.us-east-1.amazonaws.com/')
    expect(kiroEndpoint('arn:aws:codewhisperer:ap-northeast-1:1:profile/abc')).toBeNull()
  })

  it('does not turn a missing credit row into 0%', () => {
    expect(windowFromKiroLimits({ usageBreakdownList: [] })).toBeNull()
    expect(
      windowFromKiroLimits({
        usageBreakdownList: [
          {
            resourceType: 'CREDIT',
            usageLimitWithPrecision: 50,
            currentUsageWithPrecision: 10,
            currentOveragesWithPrecision: 0,
            nextDateReset: 1_800_000_000,
          },
        ],
      }),
    ).toEqual({ percent: 20, resetsAt: 1_800_000_000_000 })
  })
})

describe('fetchKiroQuota', () => {
  it('returns no-auth when the CLI database is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiro-quota-'))
    expect(await fetchKiroQuota(async () => new Response(''), home, {})).toEqual({ available: false, reason: 'no-auth' })
  })

  it('sends the bearer token and returns only the credit window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiro-quota-'))
    const dir = await mkdtemp(join(tmpdir(), 'kiro-data-'))
    const db = new DatabaseSync(join(dir, 'data.sqlite3'))
    db.exec('CREATE TABLE auth_kv (key TEXT, value TEXT); CREATE TABLE state (key TEXT, value TEXT)')
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
      'kirocli:odic:token',
      JSON.stringify({ access_token: 'secret-token' }),
    )
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run(
      'api.codewhisperer.profile',
      JSON.stringify({ arn: ARN }),
    )
    db.close()
    let authorization = ''
    let body = ''
    const outcome = await fetchKiroQuota(
      async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        body = String(init?.body ?? '')
        return new Response(
          JSON.stringify({
            usageBreakdownList: [
              {
                resourceType: 'CREDIT',
                usageLimitWithPrecision: 100,
                currentUsageWithPrecision: 25,
                nextDateReset: 1_800_000_000,
              },
            ],
          }),
        )
      },
      home,
      { KIRO_DATA_DIR: dir },
    )
    expect(authorization).toBe('Bearer secret-token')
    expect(body).toContain(ARN)
    expect(outcome.body).not.toContain('secret-token')
    expect(JSON.parse(outcome.body ?? '{}').windows).toEqual([
      { id: 'kiroMonthly', percent: 25, resetsAt: 1_800_000_000_000 },
    ])
  })
})
