import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AntigravityProbeDeps, KeyringRead } from './antigravity-quota'

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

// Helper processes are scripted here instead of spawned. The IDE's loopback
// fallback lists processes through PowerShell, which is slow on the machine
// running the tests and would answer differently whenever a real language
// server happens to run there; and the keyring reader must be testable
// without touching the real one. A test queues what the next helper answers;
// an empty queue means the tool is not installed.
const child = vi.hoisted(() => ({ queue: [] as Array<{ exit: number; stdout?: string; stderr?: string }> }))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = (
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout?: string, stderr?: string) => void,
  ): unknown => {
    const next = child.queue.shift()
    if (!next) {
      callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    } else if (next.exit === 0) {
      callback(null, next.stdout ?? '', next.stderr ?? '')
    } else {
      callback(
        Object.assign(new Error(`helper exited with status ${next.exit}`), {
          code: next.exit,
          stdout: next.stdout ?? '',
          stderr: next.stderr ?? '',
        }),
      )
    }
    return undefined
  }
  // Node's own execFile resolves `{ stdout, stderr }` under promisify. Without
  // this the mock would resolve the bare stdout string, and the probe's
  // destructuring would read undefined on every successful call.
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: unknown) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
        execFile(file, args, options, (error, stdout, stderr) =>
          error ? reject(error) : resolve({ stdout: stdout ?? '', stderr: stderr ?? '' }),
        ),
      ),
  })
  return { execFile }
})

// Fake declarations, shaped like the minified bundle's positional pairs. A
// client secret is `GOCSPX-` plus exactly 28 base64url characters, and the
// values are built by concatenation rather than written out: a literal with
// that shape is what GitHub's push protection matches, even as an obvious fake.
const fakeSecret = (fill: string): string => 'GOCSPX-' + fill.repeat(28)
const PAIR_A = { id: '111111111-aaaaaaaa.apps.googleusercontent.com', secret: fakeSecret('a') }
const PAIR_B = { id: '222222222-bbbbbbbb.apps.googleusercontent.com', secret: fakeSecret('b') }
const PAIR_C = { id: '333333333-cccccccc.apps.googleusercontent.com', secret: fakeSecret('c') }

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
  child.queue.length = 0
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

// ===== OAuth clients read straight from a binary =====

describe('clientCandidates from a Go binary', () => {
  it('cuts a secret off at its real length instead of running into the next string', async () => {
    // A Go string table packs strings of equal length next to each other with
    // nothing between them, so what follows a secret is another string. This
    // is the only source left once the IDE's JS bundle is gone.
    const exe = join(state.home, 'cli', 'agy.exe')
    await put(exe, `padding ${PAIR_A.id} padding ${PAIR_A.secret}NEIGHBOUR_STRING_abcdefghijklmnop tail`)
    await put(join(state.home, '.gemini', 'antigravity-cli', 'bin', 'agentapi.bat'), `@echo off\n"${exe}" agentapi %*`)
    const { clientCandidates } = await loadModule()
    expect(await collect(clientCandidates())).toEqual([PAIR_A])
  })

  it('finds the binaries an install keeps when no launcher names them', async () => {
    await put(
      join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
      `${PAIR_A.id} ${PAIR_A.secret}`,
    )
    await put(join(localAppData, 'agy', 'bin', 'agy.exe'), `${PAIR_B.id} ${PAIR_B.secret}`)
    const { clientCandidates } = await loadModule()
    const clients = await collect(clientCandidates())
    expect(clients).toContainEqual(PAIR_A)
    expect(clients).toContainEqual(PAIR_B)
  })
})

// ===== the app and the CLI: the shared keyring login =====

const HOUR_MS = 60 * 60_000

/** The CLI's keyring value, with a token valid for `validForMs` (negative = expired) */
function keyringLogin(validForMs: number, access = 'keyring-access', refresh = 'keyring-refresh'): () => Promise<KeyringRead> {
  return async () => ({
    ok: true,
    text: JSON.stringify({
      token: {
        access_token: access,
        refresh_token: refresh,
        expiry: new Date(Date.now() + validForMs).toISOString(),
      },
      auth_method: 'consumer',
    }),
  })
}

/** The CLI's keyring value the way Windows hands it over: the UTF-8 bytes, base64 */
const keyringBlob = (validForMs: number, access: string): string =>
  Buffer.from(
    JSON.stringify({
      token: {
        access_token: access,
        refresh_token: 'keyring-refresh',
        expiry: new Date(Date.now() + validForMs).toISOString(),
      },
    }),
    'utf8',
  ).toString('base64')

const NO_LOGIN: () => Promise<KeyringRead> = async () => ({ ok: false, reason: 'no-credentials' })

/** Cloud Code (and the token endpoint) answered in full; returned so a test can inspect the calls */
function stubCloudCode() {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'refreshed-access' }), { status: 200 })
    }
    if (url.endsWith(':loadCodeAssist')) {
      return new Response(JSON.stringify({ cloudaicompanionProject: 'test-project' }), { status: 200 })
    }
    if (url.endsWith(':retrieveUserQuotaSummary')) {
      return new Response(
        JSON.stringify({
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 }],
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The Authorization header each quota-summary request went out with */
function quotaAuthorizations(fetchMock: ReturnType<typeof stubCloudCode>): Array<string | undefined> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(':retrieveUserQuotaSummary'))
    .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization)
}

/** Probe dependencies that touch nothing on the machine running the test */
function offlineDeps(overrides: Partial<AntigravityProbeDeps> = {}): AntigravityProbeDeps {
  return { platform: 'win32', installedPrograms: async () => [], readKeyring: NO_LOGIN, ...overrides }
}

describe('the app and the CLI cards', () => {
  it('ask Cloud Code with the shared keyring login', async () => {
    const fetchMock = stubCloudCode()
    const { fetchAntigravityUsage } = await loadModule()
    const outcome = await fetchAntigravityUsage('app', offlineDeps({ readKeyring: keyringLogin(HOUR_MS) }))
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body ?? '{}').groups).toHaveLength(1)
    expect(quotaAuthorizations(fetchMock)).toEqual(['Bearer keyring-access'])
  })

  it('share one keyring read and one request between the two cards', async () => {
    const fetchMock = stubCloudCode()
    const readKeyring = vi.fn(keyringLogin(HOUR_MS))
    const { fetchAntigravityUsage } = await loadModule()
    const deps = offlineDeps({ readKeyring })
    const [app, cli] = await Promise.all([fetchAntigravityUsage('app', deps), fetchAntigravityUsage('cli', deps)])
    expect([app.available, cli.available]).toEqual([true, true])
    expect(readKeyring).toHaveBeenCalledTimes(1)
    expect(quotaAuthorizations(fetchMock)).toHaveLength(1)
  })

  it('refresh an expired keyring token through the OAuth client of the installed binary', async () => {
    await put(join(localAppData, 'agy', 'bin', 'agy.exe'), `${PAIR_A.id} ${PAIR_A.secret}`)
    const fetchMock = stubCloudCode()
    const { fetchAntigravityUsage } = await loadModule()
    const outcome = await fetchAntigravityUsage('cli', offlineDeps({ readKeyring: keyringLogin(-HOUR_MS) }))
    expect(outcome.available).toBe(true)
    expect(quotaAuthorizations(fetchMock)).toEqual(['Bearer refreshed-access'])
  })

  it('tell "never signed in" from "the keyring could not be read"', async () => {
    // A fresh module per case: the shared result would otherwise be reused
    const run = (readKeyring: () => Promise<KeyringRead>) =>
      loadModule().then(({ fetchAntigravityUsage }) => fetchAntigravityUsage('cli', offlineDeps({ readKeyring })))
    expect(await run(NO_LOGIN)).toMatchObject({ available: false, reason: 'no-credentials', installed: false })
    expect(await run(async () => ({ ok: false, reason: 'keyring-unavailable' }))).toMatchObject({
      available: false,
      reason: 'keyring-unavailable',
    })
  })

  it('do not call a keyring value this build cannot parse "never signed in"', async () => {
    const shapes = ['not json', JSON.stringify({ token: 'a string, not an object' }), JSON.stringify({ auth_method: 'consumer' })]
    for (const text of shapes) {
      const { fetchAntigravityUsage } = await loadModule()
      const outcome = await fetchAntigravityUsage('cli', offlineDeps({ readKeyring: async () => ({ ok: true, text }) }))
      expect(outcome, text).toMatchObject({ available: false, reason: 'unreadable-credentials' })
    }
  })

  it('report a keyring reader that throws as unavailable, not as a crash', async () => {
    const { fetchAntigravityUsage } = await loadModule()
    const readKeyring = async (): Promise<KeyringRead> => {
      throw new Error('keyring locked')
    }
    const outcome = await fetchAntigravityUsage('cli', offlineDeps({ readKeyring }))
    expect(outcome).toMatchObject({ available: false, reason: 'keyring-unavailable' })
  })
})

describe('is the client still installed', () => {
  async function installOf(
    flavour: 'ide' | 'app' | 'cli',
    deps: Partial<AntigravityProbeDeps> = {},
  ): Promise<boolean | null | undefined> {
    const { fetchAntigravityUsage } = await loadModule()
    return (await fetchAntigravityUsage(flavour, offlineDeps(deps))).installed
  }

  it('reports a Windows client as gone when nothing on the machine knows it', async () => {
    expect(await installOf('ide')).toBe(false)
    expect(await installOf('app')).toBe(false)
    expect(await installOf('cli')).toBe(false)
  })

  it('counts the uninstall registry, which survives a custom install directory', async () => {
    const names = async () => ['Antigravity 2.34.0', 'Antigravity IDE', 'Antigravity CLI']
    expect(await installOf('ide', { installedPrograms: names })).toBe(true)
    expect(await installOf('app', { installedPrograms: names })).toBe(true)
    expect(await installOf('cli', { installedPrograms: names })).toBe(true)
  })

  it('tells the three registry names apart', async () => {
    const only = (...names: string[]) => async () => names
    expect(await installOf('app', { installedPrograms: only('Antigravity 2.34.0') })).toBe(true)
    expect(await installOf('ide', { installedPrograms: only('Antigravity 2.34.0') })).toBe(false)
    expect(await installOf('ide', { installedPrograms: only('Antigravity IDE') })).toBe(true)
    expect(await installOf('cli', { installedPrograms: only('Antigravity CLI') })).toBe(true)
    expect(await installOf('app', { installedPrograms: only('Antigravity CLI') })).toBe(false)
  })

  it('counts the default install location, and a launcher whose binary exists', async () => {
    await put(join(localAppData, 'agy', 'bin', 'agy.exe'), 'binary')
    expect(await installOf('cli')).toBe(true)
    expect(await installOf('app')).toBe(false)

    // The launcher names the real path wherever the user chose to install
    const exe = join(state.home, 'elsewhere', 'Antigravity.exe')
    await put(exe, 'binary')
    await put(join(state.home, '.gemini', 'antigravity', 'bin', 'agentapi.bat'), `@echo off\n"${exe}" agentapi %*`)
    expect(await installOf('app')).toBe(true)
  })

  it('does not count a launcher whose binary is gone', async () => {
    const exe = join(state.home, 'gone', 'language_server.exe')
    await put(join(state.home, '.gemini', 'antigravity', 'bin', 'agentapi.bat'), `@echo off\n"${exe}" agentapi %*`)
    expect(await installOf('app')).toBe(false)
  })

  it('says nothing when the registry could not be asked', async () => {
    expect(await installOf('cli', { installedPrograms: async () => null })).toBeNull()
  })

  it('says nothing on a platform whose install layout was never checked', async () => {
    expect(await installOf('cli', { platform: 'darwin' })).toBeNull()
    expect(await installOf('cli', { platform: 'linux' })).toBeNull()
  })
})

describe('the IDE card', () => {
  const validStore = Math.floor(Date.now() / 1000) + 3600

  it('is the default flavour', async () => {
    await putStore(validStore)
    stubCloudCode()
    const { fetchAntigravityUsage } = await loadModule()
    const outcome = await fetchAntigravityUsage(undefined, offlineDeps({ installedPrograms: async () => ['Antigravity IDE'] }))
    expect(outcome).toMatchObject({ available: true, installed: true })
  })

  it('keeps reading the login an uninstalled IDE left behind, and says so', async () => {
    await putStore(validStore)
    stubCloudCode()
    const { fetchAntigravityUsage } = await loadModule()
    const outcome = await fetchAntigravityUsage('ide', offlineDeps())
    expect(outcome).toMatchObject({ available: true, installed: false })
  })

  it('never goes to the keyring: the IDE keeps a store of its own', async () => {
    await putStore(validStore)
    const fetchMock = stubCloudCode()
    const readKeyring = vi.fn(keyringLogin(HOUR_MS))
    const { fetchAntigravityUsage } = await loadModule()
    const outcome = await fetchAntigravityUsage('ide', offlineDeps({ readKeyring }))
    expect(outcome.available).toBe(true)
    expect(readKeyring).not.toHaveBeenCalled()
    expect(quotaAuthorizations(fetchMock)).toEqual(['Bearer fake-access'])
  })
})

// ===== the keyring, read through each platform's own tool =====

/** Probe dependencies that leave the keyring to the real reader on `platform` */
function keyringDeps(platform: NodeJS.Platform): AntigravityProbeDeps {
  return { platform, installedPrograms: async () => [] }
}

/** Everything printed while a probe runs, captured so a test can check it for leaks */
function captureOutput(): { text: () => string; restore: () => void } {
  const lines: string[] = []
  const show = (value: unknown): string => {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const push = (...args: unknown[]): void => {
    lines.push(args.map(show).join(' '))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(push),
    vi.spyOn(console, 'info').mockImplementation(push),
    vi.spyOn(console, 'warn').mockImplementation(push),
    vi.spyOn(console, 'error').mockImplementation(push),
    vi.spyOn(console, 'debug').mockImplementation(push),
  ]
  return { text: () => lines.join('\n'), restore: () => spies.forEach((spy) => spy.mockRestore()) }
}

const loginJson = (access: string): string =>
  JSON.stringify({
    token: {
      access_token: access,
      refresh_token: 'keyring-refresh',
      expiry: new Date(Date.now() + HOUR_MS).toISOString(),
    },
  })

/** One probe on `platform`, the keyring read by the real reader */
async function probeKeyring(flavour: 'app' | 'cli', platform: NodeJS.Platform) {
  const { fetchAntigravityUsage } = await loadModule()
  return fetchAntigravityUsage(flavour, keyringDeps(platform))
}

describe('the keyring, read through each platform’s own tool', () => {
  it('Windows: decodes the base64 blob CredReadW printed', async () => {
    child.queue.push({ exit: 0, stdout: `${keyringBlob(HOUR_MS, 'windows-access')}\n` })
    const fetchMock = stubCloudCode()
    const outcome = await probeKeyring('app', 'win32')
    expect(outcome.available).toBe(true)
    expect(quotaAuthorizations(fetchMock)).toEqual(['Bearer windows-access'])
  })

  it('Windows: a missing entry is "never signed in", any other failure is not', async () => {
    child.queue.push({ exit: 3 })
    expect(await probeKeyring('app', 'win32')).toMatchObject({ available: false, reason: 'no-credentials' })
    child.queue.push({ exit: 2, stderr: 'Add-Type : the assembly could not be loaded' })
    expect(await probeKeyring('app', 'win32')).toMatchObject({ available: false, reason: 'keyring-unavailable' })
  })

  it('macOS: takes go-keyring’s wrapper off what `security` prints', async () => {
    const json = loginJson('mac-access')
    const printed = [
      `go-keyring-base64:${Buffer.from(json, 'utf8').toString('base64')}`,
      `go-keyring-encoded:${Buffer.from(json, 'utf8').toString('hex')}`,
      json,
    ]
    for (const text of printed) {
      child.queue.push({ exit: 0, stdout: `${text}\n` })
      const fetchMock = stubCloudCode()
      const outcome = await probeKeyring('cli', 'darwin')
      expect(outcome.available, text.slice(0, 20)).toBe(true)
      expect(quotaAuthorizations(fetchMock)).toEqual(['Bearer mac-access'])
    }
  })

  it('macOS: an item that is not in the keychain is "never signed in"', async () => {
    child.queue.push({ exit: 44 })
    expect(await probeKeyring('cli', 'darwin')).toMatchObject({ available: false, reason: 'no-credentials' })
    child.queue.push({ exit: 36 })
    expect(await probeKeyring('cli', 'darwin')).toMatchObject({ available: false, reason: 'keyring-unavailable' })
  })

  it('Linux: the secret service stores the value as it is', async () => {
    child.queue.push({ exit: 0, stdout: `${loginJson('linux-access')}\n` })
    const fetchMock = stubCloudCode()
    const outcome = await probeKeyring('cli', 'linux')
    expect(outcome.available).toBe(true)
    expect(quotaAuthorizations(fetchMock)).toEqual(['Bearer linux-access'])
  })

  it('Linux: no tool at all is unavailable, no entry is "never signed in"', async () => {
    // An empty queue is a tool that is not installed
    expect(await probeKeyring('cli', 'linux')).toMatchObject({ available: false, reason: 'keyring-unavailable' })
    child.queue.push({ exit: 1 })
    expect(await probeKeyring('cli', 'linux')).toMatchObject({ available: false, reason: 'no-credentials' })
  })

  it('a platform with no reader says so instead of guessing', async () => {
    child.queue.push({ exit: 0, stdout: `${loginJson('never-read')}\n` })
    expect(await probeKeyring('cli', 'freebsd')).toMatchObject({ available: false, reason: 'keyring-unavailable' })
    // Nothing was spawned: the queued answer is still waiting
    expect(child.queue).toHaveLength(1)
  })

  it('reports a value that is not the CLI’s JSON as unreadable, not as signed out', async () => {
    for (const value of ['this is not json', 'go-keyring-base64:%%%']) {
      child.queue.push({ exit: 0, stdout: `${Buffer.from(value, 'utf8').toString('base64')}\n` })
      expect(await probeKeyring('app', 'win32'), value).toMatchObject({
        available: false,
        reason: 'unreadable-credentials',
      })
    }
  })
})

describe('credential boundaries', () => {
  const MARKER = 'TOKEN-MARKER-7f3a9c21e'

  it('never prints a token, nor hands one to the renderer', async () => {
    const fetchMock = stubCloudCode()
    const output = captureOutput()
    try {
      const { fetchAntigravityUsage } = await loadModule()
      const outcome = await fetchAntigravityUsage(
        'app',
        offlineDeps({ readKeyring: keyringLogin(HOUR_MS, MARKER, `refresh-${MARKER}`) }),
      )
      expect(outcome.available).toBe(true)
      // The token was really used, so the two checks below are not vacuous
      expect(quotaAuthorizations(fetchMock)).toEqual([`Bearer ${MARKER}`])
      expect(JSON.stringify(outcome)).not.toContain(MARKER)
      expect(output.text()).not.toContain(MARKER)
    } finally {
      output.restore()
    }
  })

  it('keeps to itself what a failed helper printed', async () => {
    const output = captureOutput()
    try {
      // The blob and the error text both carry the token, as a real failure could
      child.queue.push({ exit: 2, stdout: `${keyringBlob(HOUR_MS, MARKER)}\n`, stderr: `win32=5 ${MARKER}` })
      const outcome = await probeKeyring('app', 'win32')
      expect(outcome).toMatchObject({ available: false, reason: 'keyring-unavailable' })
      expect(JSON.stringify(outcome)).not.toContain(MARKER)
      expect(output.text()).not.toContain(MARKER)
    } finally {
      output.restore()
    }
  })

  /** Cloud Code answering with an account identifier next to everything */
  function stubCloudCodeWithAccount(account: string) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith(':loadCodeAssist')) {
        return new Response(
          JSON.stringify({ cloudaicompanionProject: 'acct-project', currentTier: { id: 'paid-tier', email: account } }),
          { status: 200 },
        )
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return new Response(
          JSON.stringify({
            project: 'acct-project',
            user: { email: account },
            groups: [
              {
                displayName: 'Gemini Models',
                account,
                buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5, remainingAmount: 12345 }],
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('returns only the quota, not what the service wraps around it', async () => {
    const account = 'ACCT-HOLDER-MARKER'
    stubCloudCodeWithAccount(account)
    const { fetchAntigravityUsage } = await loadModule()
    const outcome = await fetchAntigravityUsage('app', offlineDeps({ readKeyring: keyringLogin(HOUR_MS) }))
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      groups: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 }] },
      ],
    })
    expect(outcome.body).not.toContain(account)
  })

  it('narrows the IDE route the same way', async () => {
    await putStore(Math.floor(Date.now() / 1000) + 3600)
    stubCloudCodeWithAccount('ACCT-HOLDER-MARKER')
    const { fetchAntigravityUsage } = await loadModule()
    const outcome = await fetchAntigravityUsage('ide', offlineDeps())
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({
      groups: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 }] },
      ],
    })
  })
})

describe('asking the uninstall registry', () => {
  async function installFromMachine(flavour: 'ide' | 'app' | 'cli'): Promise<boolean | null | undefined> {
    const { fetchAntigravityUsage } = await loadModule()
    return (await fetchAntigravityUsage(flavour, { platform: 'win32', readKeyring: NO_LOGIN })).installed
  }

  const registry = 'Antigravity 2.34.0\r\nAntigravity IDE\r\n\r\n'

  it('reads one display name per line and tells the three clients apart', async () => {
    child.queue.push({ exit: 0, stdout: registry })
    expect(await installFromMachine('app')).toBe(true)
    child.queue.push({ exit: 0, stdout: registry })
    expect(await installFromMachine('ide')).toBe(true)
    child.queue.push({ exit: 0, stdout: registry })
    expect(await installFromMachine('cli')).toBe(false)
  })

  it('a registry that answers with nothing means nothing is installed', async () => {
    child.queue.push({ exit: 0, stdout: '' })
    expect(await installFromMachine('cli')).toBe(false)
  })

  it('a registry that could not be asked leaves the question open', async () => {
    child.queue.push({ exit: 1, stderr: 'Get-ItemProperty : access denied' })
    expect(await installFromMachine('cli')).toBeNull()
    // No PowerShell at all
    expect(await installFromMachine('cli')).toBeNull()
  })

  it('looks in no relative path when the machine has no LOCALAPPDATA', async () => {
    delete process.env.LOCALAPPDATA
    child.queue.push({ exit: 0, stdout: '' })
    // Not `true`: nothing was mistaken for an install in the working directory
    expect(await installFromMachine('cli')).toBe(false)
  })
})