import { beforeEach, describe, expect, it, vi } from 'vitest'
import { errorDetail, fetchProviderModels, sanitize } from './agent-model-list'

/**
 * The model-list reader walks a candidate list of URLs and auth styles and
 * keeps the first answer that parses — so the interesting contract is the
 * walk: which credential presentation goes out under which protocol, when a
 * 404 skips the remaining auth styles, when a dead endpoint stops the walk,
 * and that whatever a gateway answers with reaches the UI sanitized.
 *
 * `net.fetch` is only imported lazily inside `fetchProviderModels`, so a
 * module mock of `electron` keeps this test headless without touching the
 * source.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; headers: Record<string, string> }>,
  queue: [] as Array<{ status: number; body: string } | { error: Error }>,
}))

vi.mock('electron', () => ({
  net: {
    fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
      state.calls.push({ url, headers: init?.headers ?? {} })
      const next = state.queue.shift()
      if (!next) throw new Error('no scripted response left')
      if ('error' in next) throw next.error
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => next.body,
      }
    },
  },
}))

beforeEach(() => {
  state.calls.length = 0
  state.queue.length = 0
})

const ok = (body: unknown): { status: number; body: string } => ({ status: 200, body: JSON.stringify(body) })
const status = (code: number, body: unknown): { status: number; body: string } => ({ status: code, body: JSON.stringify(body) })
const raw = (code: number, body: string): { status: number; body: string } => ({ status: code, body })
const boom = (error: Error): { error: Error } => ({ error })

describe('fetchProviderModels — preconditions', () => {
  it('reports a missing base url or credential without any request', async () => {
    expect(await fetchProviderModels('', 'sk-key', '')).toEqual({ ok: false, message: 'no base url configured' })
    expect(await fetchProviderModels('   ', 'sk-key', '')).toEqual({ ok: false, message: 'no base url configured' })
    expect(await fetchProviderModels('https://api.example.com', '', '')).toEqual({
      ok: false,
      message: 'provider has no stored credential',
    })
    expect(state.calls).toHaveLength(0)
  })
})

describe('fetchProviderModels — candidate walk', () => {
  it('queries {base}/models with a bearer token and returns sorted unique model ids', async () => {
    state.queue.push(
      ok({
        data: [{ id: 'model-b' }, { model: 'model-a' }, { model_name: ' model-c ' }, 'model-a', 'model-d', 7, null],
      }),
    )

    const result = await fetchProviderModels('https://api.example.com', 'k-test', '')

    expect(result).toEqual({
      ok: true,
      models: ['model-a', 'model-b', 'model-c', 'model-d'],
      usedUrl: 'https://api.example.com/models',
    })
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]!.headers.Authorization).toBe('Bearer k-test')
  })

  it('appends /models to a base that already ends in a version segment', async () => {
    state.queue.push(ok({ data: [{ id: 'm1' }] }))

    const result = await fetchProviderModels('https://api.example.com/v1/', 'k-test', '')

    expect(result).toMatchObject({ ok: true, usedUrl: 'https://api.example.com/v1/models' })
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]!.url).toBe('https://api.example.com/v1/models')
  })

  it('falls back to /v1/models after a 404 on /models without retrying the auth style', async () => {
    state.queue.push(status(404, { error: { message: 'no such route' } }), ok({ data: [{ id: 'm1' }] }))

    const result = await fetchProviderModels('https://api.example.com', 'k-test', '')

    expect(result).toMatchObject({ ok: true, usedUrl: 'https://api.example.com/v1/models' })
    // 404 means the path is wrong, not the credential: two calls, both bearer.
    expect(state.calls).toHaveLength(2)
    for (const call of state.calls) {
      expect(call.headers.Authorization).toBe('Bearer k-test')
      expect(call.headers['x-api-key']).toBeUndefined()
    }
  })

  it('retries the same url with x-api-key first for an anthropic protocol', async () => {
    state.queue.push(status(401, { error: { message: 'bad key' } }), ok({ data: [{ id: 'm1' }] }))

    const result = await fetchProviderModels('https://api.anthropic.com/v1', 'k-test', 'anthropic')

    expect(result).toMatchObject({ ok: true, usedUrl: 'https://api.anthropic.com/v1/models' })
    expect(state.calls).toHaveLength(2)
    expect(state.calls[0]!.headers).toEqual({ 'x-api-key': 'k-test', 'anthropic-version': '2023-06-01' })
    expect(state.calls[1]!.headers).toEqual({ Authorization: 'Bearer k-test' })
  })

  it('falls back to x-api-key for a plain gateway that rejects the bearer token', async () => {
    // step_plan speaks anthropic messages but authenticates its model list
    // with a bearer token — here the roles are reversed: bearer 401, then the
    // anthropic style answers.
    state.queue.push(
      status(401, { error: { message: 'unauthorized' } }),
      ok({ data: [{ id: 'step-plan-model' }] }),
    )

    const result = await fetchProviderModels('https://api.stepfun.example/v1', 'k-test', '')

    expect(result).toMatchObject({ ok: true, models: ['step-plan-model'], usedUrl: 'https://api.stepfun.example/v1/models' })
    expect(state.calls).toHaveLength(2)
    expect(state.calls[1]!.headers['x-api-key']).toBe('k-test')
  })

  it('keeps walking candidates when a 200 body is unusable', async () => {
    state.queue.push(
      raw(200, '<html>not json</html>'),
      raw(200, '<html>still not json</html>'),
      ok({ data: [] }),
      ok({ data: [] }),
    )

    const result = await fetchProviderModels('https://api.example.com', 'k-test', '')

    expect(result).toEqual({ ok: false, message: 'no models in the response' })
    expect(state.calls).toHaveLength(4)
  })

  it('stops retrying auth styles when the endpoint is unreachable', async () => {
    state.queue.push(boom(new Error('ECONNREFUSED 127.0.0.1:443')), boom(new Error('ECONNREFUSED 127.0.0.1:443')))

    const result = await fetchProviderModels('https://api.example.com', 'k-test', '')

    // One attempt per URL: a dead endpoint cannot be fixed by re-authing.
    expect(result).toEqual({ ok: false, message: 'ECONNREFUSED 127.0.0.1:443' })
    expect(state.calls).toHaveLength(2)
  })

  it('maps a timeout to an honest message', async () => {
    const timeout = new Error('The operation was aborted')
    timeout.name = 'TimeoutError'
    state.queue.push(boom(timeout), boom(timeout))

    const result = await fetchProviderModels('https://api.example.com', 'k-test', '')

    expect(result).toEqual({ ok: false, message: 'request timed out' })
  })

  it('returns the first candidate that parses', async () => {
    state.queue.push(ok({ data: [{ id: 'm1' }] }), ok({ data: [{ id: 'never-fetched' }] }))

    const result = await fetchProviderModels('https://api.example.com', 'k-test', '')

    expect(result).toMatchObject({ ok: true, usedUrl: 'https://api.example.com/models' })
    expect(state.calls).toHaveLength(1)
  })
})

describe('fetchProviderModels — error surfaces', () => {
  it('surfaces a sanitized gateway error message that never echoes the credential', async () => {
    const rejected = status(401, { error: { message: 'invalid key sk-secretkey123456 for tenant' } })
    state.queue.push(rejected, rejected, rejected, rejected)

    const result = await fetchProviderModels('https://api.example.com', 'sk-secretkey123456', '')

    expect(result).toEqual({ ok: false, message: 'invalid key sk-*** for tenant' })
    expect(JSON.stringify(result)).not.toContain('sk-secretkey123456')
  })

  it('reports the HTTP status when the error body is not JSON', async () => {
    const rejected = raw(403, '<html>forbidden</html>')
    state.queue.push(rejected, rejected, rejected, rejected)

    const result = await fetchProviderModels('https://api.example.com', 'k-test', '')

    expect(result).toEqual({ ok: false, message: 'HTTP 403' })
  })
})

describe('sanitize', () => {
  it('masks sk-style keys and long opaque tokens', () => {
    expect(sanitize('bad key sk-abcdefgh12345678 here')).toBe('bad key sk-*** here')
    expect(sanitize(`token ${'a'.repeat(40)} leaked`)).toBe('token *** leaked')
  })

  it('caps the message length', () => {
    // Words short enough not to trigger the long-token mask: the cap applies
    // to the surviving text.
    expect(sanitize('word '.repeat(100))).toHaveLength(300)
  })
})

describe('errorDetail', () => {
  it('reads the message out of the common error envelopes', () => {
    expect(errorDetail({ error: { message: 'nested' } }, 500)).toBe('nested')
    expect(errorDetail({ message: 'flat' }, 500)).toBe('flat')
    expect(errorDetail({ error: 'string' }, 500)).toBe('string')
  })

  it('falls back to the status line', () => {
    expect(errorDetail({}, 503)).toBe('HTTP 503')
    expect(errorDetail(null, 500)).toBe('HTTP 500')
    expect(errorDetail({ error: { message: '' } }, 429)).toBe('HTTP 429')
  })
})
