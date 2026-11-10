import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression: current Antigravity installs (appx-style layout) no longer write
 * `~/.gemini/<flavour>/bin/agentapi.bat`, so launcher-anchored client discovery
 * found zero OAuth candidates and every refresh was reported as a dead login.
 * The bundle must also be read straight from the standard install roots, and a
 * probe-side refresh failure must not be labelled `rejected` (re-login advice).
 */

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => state.home }
})

// Fake declarations, shaped like the minified bundle's positional pairs.
const PAIR_A = { id: '111111111-aaaaaaaa.apps.googleusercontent.com', secret: 'GOCSPX-aaaaaaaaaaaaaa' }
const PAIR_B = { id: '222222222-bbbbbbbb.apps.googleusercontent.com', secret: 'GOCSPX-bbbbbbbbbbbbbb' }
const PAIR_C = { id: '333333333-cccccccc.apps.googleusercontent.com', secret: 'GOCSPX-cccccccccccccc' }

function bundleWith(pairs: Array<{ id: string; secret: string }>): string {
  return pairs.map((p) => `oauthClientId="${p.id}",oauthClientSecret="${p.secret}";`).join('\n')
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

const bundlePath = (): string => join(localAppData, 'Programs', 'Antigravity IDE', '_', 'resources', 'app', 'out', 'main.js')

// ===== minimal protobuf encoder for the credential-store fixture =====

function varint(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

const tag = (field: number, wire: number): Buffer => varint((field << 3) | wire)
const vint = (field: number, value: number): Buffer => Buffer.concat([tag(field, 0), varint(value)])
const ldel = (field: number, body: Buffer): Buffer => Buffer.concat([tag(field, 2), varint(body.length), body])
const text = (field: number, value: string): Buffer => ldel(field, Buffer.from(value, 'utf8'))

/** Mirrors decodeTokenBlob's envelope: two #1 branches, sentinel + payload, base64 wrap. */
function tokenBlob(seconds: number): string {
  const tokens = Buffer.concat([
    text(1, 'fake-access'),
    text(2, 'Bearer'),
    text(3, 'fake-refresh'),
    ldel(4, vint(1, seconds)),
  ])
  const payload = ldel(1, Buffer.from(tokens.toString('base64'), 'utf8'))
  const tokenInfo = Buffer.concat([text(1, 'oauthTokenInfoSentinelKey'), ldel(2, payload)])
  return Buffer.concat([ldel(1, Buffer.from('auth-state')), ldel(1, tokenInfo)]).toString('base64')
}

async function putStore(seconds: number): Promise<void> {
  const dir = join(appData, 'Antigravity IDE', 'User', 'globalStorage')
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'state.vscdb'))
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'antigravityUnifiedStateSync.oauthToken',
      tokenBlob(seconds),
    )
  } finally {
    db.close()
  }
}

const dirs: string[] = []
let localAppData: string
let programFiles: string
let appData: string
let savedEnv: { LOCALAPPDATA?: string; PROGRAMFILES?: string; APPDATA?: string }

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(async () => {
  state.home = await tempDir('agy-home-')
  localAppData = await tempDir('agy-local-')
  programFiles = await tempDir('agy-pf-')
  appData = await tempDir('agy-appdata-')
  savedEnv = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PROGRAMFILES: process.env.PROGRAMFILES,
    APPDATA: process.env.APPDATA,
  }
  process.env.LOCALAPPDATA = localAppData
  process.env.PROGRAMFILES = programFiles
  process.env.APPDATA = appData
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Fresh module per test: the probed client cache must not leak across tests. */
async function loadModule() {
  vi.resetModules()
  return await import('./antigravity-quota')
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) out.push(item)
  return out
}

describe('clientCandidates', () => {
  it('reads the appx and legacy layouts when no launcher exists', async () => {
    await put(join(localAppData, 'Programs', 'Antigravity IDE', '_', 'resources', 'app', 'out', 'main.js'), bundleWith([PAIR_A]))
    await put(join(programFiles, 'Antigravity IDE', 'resources', 'app', 'out', 'main.js'), bundleWith([PAIR_B]))
    const { clientCandidates } = await loadModule()
    expect(await collect(clientCandidates())).toEqual([PAIR_A, PAIR_B])
  })

  it('still prefers the launcher-named bundle and dedupes repeats', async () => {
    const exe = join(state.home, 'ide', 'bin', 'language_server.exe')
    await put(join(state.home, '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat'), `@echo off\nstart "" "${exe}" %*`)
    await put(join(state.home, 'ide', 'resources', 'app', 'out', 'main.js'), bundleWith([PAIR_C]))
    // Same pair under an install root: must not be yielded twice.
    await put(join(localAppData, 'Programs', 'Antigravity IDE', '_', 'resources', 'app', 'out', 'main.js'), bundleWith([PAIR_C]))
    const { clientCandidates } = await loadModule()
    expect(await collect(clientCandidates())).toEqual([PAIR_C])
  })

  it('yields nothing when neither launcher nor install exists', async () => {
    const { clientCandidates } = await loadModule()
    expect(await collect(clientCandidates())).toEqual([])
  })
})

describe('refreshAccessToken', () => {
  it('marks invalid_grant as a rejected login when every candidate fails', async () => {
    await put(bundlePath(), bundleWith([PAIR_A]))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const { refreshAccessToken } = await loadModule()
    expect(await refreshAccessToken('fake-refresh')).toEqual({ token: null, rejected: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps trying after invalid_grant from a sibling client', async () => {
    // RFC 6749 §5.2: invalid_grant can mean "issued to another client", so the
    // first pair's rejection must not sentence a live login to death.
    await put(bundlePath(), bundleWith([PAIR_A, PAIR_B]))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'fake-access' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { refreshAccessToken } = await loadModule()
    expect(await refreshAccessToken('fake-refresh')).toEqual({ token: 'fake-access', rejected: false })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a candidate that never answered vetoes the rejected verdict', async () => {
    await put(bundlePath(), bundleWith([PAIR_A, PAIR_B]))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { refreshAccessToken } = await loadModule()
    expect(await refreshAccessToken('fake-refresh')).toEqual({ token: null, rejected: false })
  })

  it('does not call a wrong client a rejected login', async () => {
    await put(join(localAppData, 'Programs', 'Antigravity IDE', '_', 'resources', 'app', 'out', 'main.js'), bundleWith([PAIR_A]))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const { refreshAccessToken } = await loadModule()
    expect(await refreshAccessToken('fake-refresh')).toEqual({ token: null, rejected: false })
  })

  it('returns the token on success', async () => {
    await put(join(localAppData, 'Programs', 'Antigravity IDE', '_', 'resources', 'app', 'out', 'main.js'), bundleWith([PAIR_A]))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'fake-access' }), { status: 200 })))
    const { refreshAccessToken } = await loadModule()
    expect(await refreshAccessToken('fake-refresh')).toEqual({ token: 'fake-access', rejected: false })
  })

  it('without candidates the refresh is unavailable, not rejected', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { refreshAccessToken } = await loadModule()
    expect(await refreshAccessToken('fake-refresh')).toEqual({ token: null, rejected: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchViaCloudCode reasons', () => {
  it('reports refresh-unavailable when no client can be found', async () => {
    await putStore(Math.floor(Date.now() / 1000) - 3600)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchViaCloudCode } = await loadModule()
    expect(await fetchViaCloudCode()).toEqual({ available: false, reason: 'refresh-unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports refresh-failed only when Google calls the token dead', async () => {
    await putStore(Math.floor(Date.now() / 1000) - 3600)
    await put(bundlePath(), bundleWith([PAIR_A]))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
    )
    const { fetchViaCloudCode } = await loadModule()
    expect(await fetchViaCloudCode()).toEqual({ available: false, reason: 'refresh-failed' })
  })
})