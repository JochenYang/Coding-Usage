import { describe, expect, it } from 'vitest'
import { cursor } from './cursor'
import { copilot } from './copilot'

/**
 * Both adapters talk to undocumented endpoints, so the recorded payload shapes
 * below are the contract worth pinning: the Cursor cookie is *derived* from the
 * JWT (getting it wrong is a silent 401), and Copilot reports REMAINING
 * percentages that must be inverted exactly once.
 */

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('cursor adapter', () => {
  const token = jwt({ sub: 'google-oauth2|user_01ABC', exp: 1900000000 })

  it('derives the WorkosCursorSessionToken cookie from the JWT sub claim', async () => {
    let seen: Record<string, string> | null = null
    const metrics = await cursor.parseResponse({}, {
      key: token,
      fetch: async (_url, headers) => {
        seen = headers
        return jsonResponse({
          is_unlimited: false,
          billing_cycle_end: '2026-11-20T00:00:00Z',
          individual_usage: { plan: { total_percent_used: 37, auto_percent_used: 12, api_percent_used: 64 } },
        })
      },
    })
    expect(seen!.Cookie).toBe(`WorkosCursorSessionToken=user_01ABC%3A%3A${token}`)
    expect(metrics.map((m) => [m.id, Math.round(m.percent ?? 0)])).toEqual([
      ['cursor-total', 37],
      ['cursor-auto', 12],
      ['cursor-api', 64],
    ])
    expect(metrics[0].resetsAt).toBe(Date.parse('2026-11-20T00:00:00Z'))
  })

  it('rejects a token that is not a session JWT instead of sending a 401', async () => {
    await expect(
      cursor.parseResponse({}, { key: 'not-a-jwt', fetch: async () => jsonResponse({}) }),
    ).rejects.toThrow(/Cursor/)
  })

  it('reports a rejected session as an invalid key', async () => {
    await expect(
      cursor.parseResponse({}, { key: token, fetch: async () => jsonResponse({}, 401) }),
    ).rejects.toThrow(/Key/)
  })
})

describe('copilot adapter', () => {
  it('sends the editor identity the internal endpoint expects', () => {
    const { url, headers } = copilot.buildRequest('gho_example')
    expect(url).toBe('https://api.github.com/copilot_internal/user')
    expect(headers.Authorization).toBe('token gho_example')
    expect(headers['Editor-Version']).toBeTruthy()
    expect(headers['User-Agent']).toMatch(/^GitHubCopilotChat\//)
  })

  it('inverts percent_remaining into used percentages', async () => {
    const metrics = await copilot.parseResponse(
      {
        copilot_plan: 'individual',
        quota_reset_date: '2026-12-01T00:00:00Z',
        quota_snapshots: {
          premium_interactions: { percent_remaining: 76 },
          chat: { percent_remaining: 100 },
        },
      },
      {},
    )
    expect(metrics.map((m) => [m.id, Math.round(m.percent ?? 0)])).toEqual([
      ['copilot-premium', 24],
      ['copilot-chat', 0],
    ])
    expect(metrics[0].resetsAt).toBe(Date.parse('2026-12-01T00:00:00Z'))
  })

  it('fails loudly when the payload carries no quota windows', async () => {
    await expect(copilot.parseResponse({ copilot_plan: 'individual' }, {})).rejects.toThrow(/额度窗口/)
  })
})
