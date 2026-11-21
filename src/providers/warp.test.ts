import { describe, expect, it } from 'vitest'
import { warp } from './warp'

/**
 * Scripted-fetch tests for the Warp GraphQL adapter (the zhipu.test.ts
 * pattern): parseResponse drives the request through an injected fetch, so
 * the query/POST shape, the by-name field resolution and the fail-closed
 * paths are exercised headlessly — no key, no network.
 *
 * The endpoint is undocumented (E12), so the fixtures pin the exact response
 * shape the CodexBar implementation reads; a schema drift breaks these tests
 * instead of silently emptying the card.
 */

type CtxFetch = NonNullable<NonNullable<Parameters<typeof warp.parseResponse>[1]>['fetch']>

/** Records the request facts and answers with a scripted GraphQL payload */
function scriptedFetch(
  respond: () => { status: number; body: unknown },
  calls: { url: string; headers: Record<string, string>; body: string }[],
): CtxFetch {
  return async (url, headers, init) => {
    calls.push({ url, headers, body: String(init?.body ?? '') })
    const { status, body } = respond()
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
}

const OK_PAYLOAD = {
  data: {
    user: {
      __typename: 'UserOutput',
      user: {
        requestLimitInfo: {
          isUnlimited: false,
          nextRefreshTime: '2026-12-01T00:00:00Z',
          requestLimit: 150,
          requestsUsedSinceLastRefresh: 30,
        },
        bonusGrants: [{ requestCreditsGranted: 100, requestCreditsRemaining: 25, expiration: '2026-11-30T00:00:00Z' }],
        workspaces: { bonusGrantsInfo: { grants: [{ requestCreditsGranted: 50, requestCreditsRemaining: 50 }] } },
      },
    },
  },
}

const ctx = (fetch: CtxFetch) => ({ key: 'wk-test-key', fetch, locale: 'zh-CN' as const })

describe('warp quota adapter', () => {
  it('posts the GraphQL query with the client headers the edge requires', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    await warp.parseResponse({}, ctx(scriptedFetch(() => ({ status: 200, body: OK_PAYLOAD }), calls)))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo')
    expect(calls[0]?.headers.Authorization).toBe('Bearer wk-test-key')
    expect(calls[0]?.headers['User-Agent']).toBe('Warp/1.0')
    expect(calls[0]?.headers['x-warp-client-id']).toBe('warp-app')
    expect(calls[0]?.headers.Origin).toBe('https://app.warp.dev')
    const sent = JSON.parse(calls[0]?.body ?? '{}') as { operationName: string; query: string }
    expect(sent.operationName).toBe('GetRequestLimitInfo')
    expect(sent.query).toContain('requestLimitInfo')
  })

  it('maps the monthly request pool and keeps add-on credits as a separate row', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    const metrics = await warp.parseResponse(
      {},
      ctx(scriptedFetch(() => ({ status: 200, body: OK_PAYLOAD }), calls)),
    )
    expect(metrics.map((m) => [m.id, m.percent, m.used, m.total])).toEqual([
      ['warp-requests', 20, 30, 150],
      // (100-25 + 50-50) used out of (100+50) granted
      ['warp-bonus', 50, 75, 150],
    ])
    // The bonus row anchors on the earliest expiring grant with a remainder
    expect(metrics[1]?.resetsAt).toBe(Date.parse('2026-11-30T00:00:00Z'))
  })

  it('shows an unlimited plan as a present 0% row', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    const payload = {
      data: {
        user: {
          __typename: 'UserOutput',
          user: {
            requestLimitInfo: { isUnlimited: true, requestLimit: 0, requestsUsedSinceLastRefresh: 0 },
            bonusGrants: [],
            workspaces: { bonusGrantsInfo: { grants: [] } },
          },
        },
      },
    }
    const metrics = await warp.parseResponse(
      {},
      ctx(scriptedFetch(() => ({ status: 200, body: payload }), calls)),
    )
    expect(metrics.map((m) => [m.id, m.percent])).toEqual([['warp-requests', 0]])
  })

  it('fails on GraphQL-level errors instead of inventing a reading', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    await expect(
      warp.parseResponse(
        {},
        ctx(
          scriptedFetch(() => ({ status: 200, body: { errors: [{ message: 'Unauthorized: User not in context' }], data: null } }), calls),
        ),
      ),
    ).rejects.toThrow('Unauthorized: User not in context')
  })

  it('fails closed on an error __typename, missing fields and a non-2xx status', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    const fetch = scriptedFetch(() => ({ status: 200, body: { data: { user: { __typename: 'RateLimited' } } } }), calls)
    await expect(warp.parseResponse({}, ctx(fetch))).rejects.toThrow()
    const noFields = scriptedFetch(() => ({ status: 200, body: { data: { user: { __typename: 'UserOutput', user: {} } } } }), calls)
    await expect(warp.parseResponse({}, ctx(noFields))).rejects.toThrow()
    const http401 = scriptedFetch(() => ({ status: 401, body: {} }), calls)
    await expect(warp.parseResponse({}, ctx(http401))).rejects.toThrow()
  })

  it('drops a grant whose numbers contradict themselves', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    const payload = {
      data: {
        user: {
          __typename: 'UserOutput',
          user: {
            requestLimitInfo: { isUnlimited: false, requestLimit: 10, requestsUsedSinceLastRefresh: 1 },
            bonusGrants: [{ requestCreditsGranted: 10, requestCreditsRemaining: 99 }],
            workspaces: { bonusGrantsInfo: { grants: [] } },
          },
        },
      },
    }
    const metrics = await warp.parseResponse(
      {},
      ctx(scriptedFetch(() => ({ status: 200, body: payload }), calls)),
    )
    expect(metrics.map((m) => m.id)).toEqual(['warp-requests'])
  })
})
