import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureIlinkSessionWarm,
  initIlinkSession,
  isIlinkSessionWarm,
  recoverIlinkSession,
  startIlinkSession,
  stopIlinkSession,
} from './weixin-session'

/**
 * The session keeper's contract (documented at weixin-session.ts:13-20): the
 * platform prepares sendmessage only while an authenticated getupdates poll is
 * live, so a {ret:-2, prepare failed} on send is recovered by re-issuing the
 * poll — and a round that ends because the server HELD it (timeout/abort) is
 * the prepared state, not a failure. The opaque get_updates_buf cursor is the
 * only thing persisted. The long-poll loop itself is deliberately not tested
 * here; the fetcher is injected exactly like `net.fetch` is in registerIpc.
 *
 * The background loop is kept parked with a never-resolving fetch in every
 * test: a fast-resolving loop round would spin the event loop without ever
 * reaching a macrotask, and the loop's own behaviour is out of scope here.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.userData : '') },
}))

type NetFetch = typeof import('electron').net.fetch

interface CapturedCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** One fetch behaviour, consumed in order; beyond the list every call hangs */
type Step = 'hang' | 'fail' | 'abort' | Response

function makeFetcher(steps: Step[] = []): { fetch: NetFetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const fetch = (async (url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(String(init?.body ?? '')) as Record<string, unknown>
    } catch {
      // body not JSON — recorded empty
    }
    const call: CapturedCall = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    }
    const step = steps[calls.length] ?? 'hang'
    calls.push(call)
    if (step === 'hang') return new Promise<Response>(() => {})
    if (step === 'fail') throw new TypeError('fetch failed')
    // The shape `AbortSignal.timeout` produces when the hold window ends.
    if (step === 'abort') {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
    }
    return step
  }) as unknown as NetFetch
  return { fetch, calls }
}

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })

const cursorPath = (): string => join(state.userData, 'weixin-ilink-cursor.json')

const dirs: string[] = []

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weixin-session-'))
  dirs.push(dir)
  state.userData = dir
})

afterEach(async () => {
  await stopIlinkSession()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('recoverIlinkSession', () => {
  it('retries after prepare-failed: a completed round is success and marks the session warm', async () => {
    const { fetch, calls } = makeFetcher(['hang', json({ ret: 0, get_updates_buf: 'BUF-1' })])
    initIlinkSession(fetch)
    await startIlinkSession('TOKEN-1')

    expect(await recoverIlinkSession('TOKEN-1')).toBe(true)
    expect(isIlinkSessionWarm()).toBe(true)
    // The recovery round re-issued the authenticated poll from the loaded cursor.
    expect(calls[1]?.url).toContain('/ilink/bot/getupdates')
    expect(calls[1]?.headers.AuthorizationType).toBe('ilink_bot_token')
    expect(calls[1]?.body.get_updates_buf).toBe('')
  })

  it('counts a server-held round (timeout/abort) as prepared instead of failed', async () => {
    // The previous behaviour treated this hold as failure, so cold-start
    // recovery reported "failed" and the send never retried.
    const { fetch } = makeFetcher(['hang', 'abort'])
    initIlinkSession(fetch)
    await startIlinkSession('TOKEN-2')

    expect(await recoverIlinkSession('TOKEN-2')).toBe(true)
    expect(isIlinkSessionWarm()).toBe(true)
  })

  it('refuses the retry after a fast transport error that the server did not hold', async () => {
    const { fetch } = makeFetcher(['hang', 'fail'])
    initIlinkSession(fetch)
    await startIlinkSession('TOKEN-3')

    expect(await recoverIlinkSession('TOKEN-3')).toBe(false)
    expect(isIlinkSessionWarm()).toBe(false)
  })

  it('returns true without a new request when the background poll is already held', async () => {
    vi.useFakeTimers()
    try {
      const { fetch, calls } = makeFetcher(['hang'])
      initIlinkSession(fetch)
      await startIlinkSession('TOKEN-4')
      // The loop's poll has been in flight past the settle window.
      await vi.advanceTimersByTimeAsync(2100)

      expect(await recoverIlinkSession('TOKEN-4')).toBe(true)
      // No recovery round was issued: the held poll IS the prepared state.
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await stopIlinkSession()
    }
  })
})

describe('cursor persistence', () => {
  it('persists the next cursor keyed by a token hint, and restarts from it', async () => {
    const { fetch } = makeFetcher(['hang', json({ ret: 0, get_updates_buf: 'BUF-1' })])
    initIlinkSession(fetch)
    await startIlinkSession('TOKEN-1')
    await recoverIlinkSession('TOKEN-1')

    // Only an opaque map keyed by a token hint lands on disk.
    const written = await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(cursorPath(), 'utf8')) as Record<string, unknown>
      expect(Object.values(raw)).toContain('BUF-1')
      return raw
    })
    expect(Object.keys(written)).toHaveLength(1)
    expect(Object.keys(written)[0]).toMatch(/^t[0-9a-f]+$/)
    expect(JSON.stringify(written)).not.toContain('TOKEN-1')

    // A restart loads the cursor back: the first poll continues where the
    // previous run left off instead of replaying the backlog.
    await stopIlinkSession()
    const { fetch: restartFetch, calls: restartCalls } = makeFetcher([])
    initIlinkSession(restartFetch)
    await startIlinkSession('TOKEN-1')
    expect(restartCalls[0]?.body.get_updates_buf).toBe('BUF-1')
  })

  it('merges the write with unrelated token keys instead of clobbering the file', async () => {
    await writeFile(cursorPath(), JSON.stringify({ tdeadbeef: 'OTHER-TOKEN' }), 'utf8')
    const { fetch } = makeFetcher(['hang', json({ ret: 0, get_updates_buf: 'BUF-A' })])
    initIlinkSession(fetch)
    await startIlinkSession('TOKEN-5')
    await recoverIlinkSession('TOKEN-5')

    const first = await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(cursorPath(), 'utf8')) as Record<string, unknown>
      expect(Object.values(raw)).toContain('BUF-A')
      return raw
    })
    expect(first.tdeadbeef).toBe('OTHER-TOKEN')

    // A second round for the same token overwrites its own key only.
    await stopIlinkSession()
    const { fetch: fetch2 } = makeFetcher(['hang', json({ ret: 0, get_updates_buf: 'BUF-B' })])
    initIlinkSession(fetch2)
    await startIlinkSession('TOKEN-5')
    await recoverIlinkSession('TOKEN-5')

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(cursorPath(), 'utf8')) as Record<string, unknown>
      expect(Object.values(raw)).toContain('BUF-B')
      expect(Object.values(raw)).not.toContain('BUF-A')
      expect(raw.tdeadbeef).toBe('OTHER-TOKEN')
    })
  })

  it('starts from an empty cursor when the file is missing or corrupt', async () => {
    await writeFile(cursorPath(), '{{{ not json', 'utf8')
    const { fetch, calls } = makeFetcher([])
    initIlinkSession(fetch)
    await startIlinkSession('TOKEN-6')

    expect(calls[0]?.body.get_updates_buf).toBe('')
  })
})

describe('ensureIlinkSessionWarm', () => {
  it('is warm once the background poll has been held past the settle window', async () => {
    vi.useFakeTimers()
    try {
      const { fetch } = makeFetcher(['hang'])
      initIlinkSession(fetch)
      await startIlinkSession('TOKEN-7')

      // The idle round is answered by the server holding it open, so an
      // in-flight poll past 2s is the strongest available evidence.
      const warm = ensureIlinkSessionWarm('TOKEN-7')
      await vi.advanceTimersByTimeAsync(2600)
      await expect(warm).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
      await stopIlinkSession()
    }
  })

  it('reports false when the session is stopped mid-wait', async () => {
    vi.useFakeTimers()
    try {
      const { fetch } = makeFetcher(['hang'])
      initIlinkSession(fetch)
      await startIlinkSession('TOKEN-8')

      const warm = ensureIlinkSessionWarm('TOKEN-8')
      await stopIlinkSession()
      await vi.advanceTimersByTimeAsync(1000)
      await expect(warm).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers immediately from a recently completed round', async () => {
    const { fetch } = makeFetcher(['hang', json({ ret: 0 })])
    initIlinkSession(fetch)
    await startIlinkSession('TOKEN-9')
    await recoverIlinkSession('TOKEN-9')

    await expect(ensureIlinkSessionWarm('TOKEN-9')).resolves.toBe(true)
  })
})
