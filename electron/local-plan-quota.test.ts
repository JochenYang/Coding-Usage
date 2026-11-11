import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchCopilotUsage, fetchCursorUsage, resetCursorProbeCaches, userDataOfStateDb } from './local-plan-quota'

/**
 * The point of these probes is that the user never pastes a token: the login
 * the client already wrote is read in place. These tests build the real files
 * (hosts.json, a state.vscdb with its ItemTable row) so the discovery paths —
 * including the sealed-token refusal — are exercised rather than assumed.
 */

const dirs: string[] = []

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plan-quota-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  resetCursorProbeCaches()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A real state.vscdb under a temp appData root; returns that root */
async function writeStateDb(home: string, value: string | Uint8Array): Promise<string> {
  const appData = join(home, 'AppData', 'Roaming')
  const dir = join(appData, 'Cursor', 'User', 'globalStorage')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.vscdb')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', value)
  db.close()
  return appData
}

function jwt(sub: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ sub })}.sig`
}

describe('copilot local login', () => {
  it('reads hosts.json and sends the editor identity', async () => {
    const home = await tempHome()
    const appData = join(home, 'AppData', 'Local')
    await mkdir(join(appData, 'github-copilot'), { recursive: true })
    await writeFile(
      join(appData, 'github-copilot', 'hosts.json'),
      JSON.stringify({ 'github.com': { user: 'octocat', oauth_token: 'gho_example' } }),
    )

    let seen: Record<string, string> | null = null
    const outcome = await fetchCopilotUsage(
      async (_url, init) => {
        seen = init.headers as Record<string, string>
        return new Response(JSON.stringify({ copilot_plan: 'individual' }), { status: 200 })
      },
      home,
      { LOCALAPPDATA: appData },
    )

    expect(outcome.available).toBe(true)
    expect(seen!.Authorization).toBe('token gho_example')
    expect(seen!['Editor-Version']).toBeTruthy()
  })

  it('reports no-login when the extension has never signed in', async () => {
    const home = await tempHome()
    const outcome = await fetchCopilotUsage(async () => new Response('', { status: 200 }), home, {
      LOCALAPPDATA: join(home, 'missing'),
    })
    expect(outcome).toEqual({ available: false, reason: 'no-login' })
  })
})

describe('cursor local login', () => {
  it('builds the session cookie from the token stored in state.vscdb', async () => {
    const home = await tempHome()
    const token = jwt('user_01|acct-42')
    const appData = await writeStateDb(home, token)

    let seen: Record<string, string> | null = null
    const outcome = await fetchCursorUsage(
      async (_url, init) => {
        seen = init.headers as Record<string, string>
        return new Response(JSON.stringify({ individual_usage: {} }), { status: 200 })
      },
      home,
      { APPDATA: appData, XDG_CONFIG_HOME: join(home, 'no-config') },
    )

    expect(outcome.available).toBe(true)
    expect(seen!.Cookie).toBe(`WorkosCursorSessionToken=acct-42%3A%3A${token}`)
  })

  it('refuses a sealed token instead of sending a request that cannot work', async () => {
    const home = await tempHome()
    const appData = await writeStateDb(home, 'cursor-safe-storage:v1:AQEAAA==')
    let called = false
    const outcome = await fetchCursorUsage(
      async () => {
        called = true
        return new Response('', { status: 200 })
      },
      home,
      { APPDATA: appData, XDG_CONFIG_HOME: join(home, 'no-config') },
    )
    expect(outcome).toEqual({ available: false, reason: 'sealed-token' })
    expect(called).toBe(false)
  })

  it('reads the cursor-agent auth.json when the IDE is not installed', async () => {
    const home = await tempHome()
    const token = jwt('google-oauth2|acct-7')
    await mkdir(join(home, 'xdg', 'cursor'), { recursive: true })
    await writeFile(join(home, 'xdg', 'cursor', 'auth.json'), JSON.stringify({ accessToken: token }))

    let seen: Record<string, string> | null = null
    const outcome = await fetchCursorUsage(
      async (_url, init) => {
        seen = init.headers as Record<string, string>
        return new Response('{}', { status: 200 })
      },
      home,
      { XDG_CONFIG_HOME: join(home, 'xdg') },
    )
    expect(outcome.available).toBe(true)
    expect(seen!.Cookie).toContain('WorkosCursorSessionToken=acct-7%3A%3A')
  })

  it('maps a rejected session to an http reason', async () => {
    const home = await tempHome()
    const appData = await writeStateDb(home, jwt('user_01|acct-42'))
    const outcome = await fetchCursorUsage(
      async () => new Response('', { status: 401 }),
      home,
      { APPDATA: appData, XDG_CONFIG_HOME: join(home, 'no-config') },
    )
    expect(outcome).toEqual({ available: false, reason: 'http-401' })
  })
})

describe('cursor current-period probe', () => {
  const env = (home: string, appData: string) => ({
    APPDATA: appData,
    XDG_CONFIG_HOME: join(home, 'no-config'),
  })

  /** Route mocks by URL so the period path and the legacy fallback can differ */
  function routed(routes: Record<string, () => Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const impl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      const handler = routes[url]
      return handler ? handler() : new Response('{}', { status: 404 })
    }
    return { impl, calls }
  }

  const PERIOD = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
  const PLAN = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo'
  const SUMMARY = 'https://cursor.com/api/usage-summary'

  it('prefers the current-period endpoint and sends it as the app does', async () => {
    const home = await tempHome()
    const token = jwt('user_01|acct-42')
    const { impl, calls } = routed({
      [PERIOD]: () =>
        new Response(
          JSON.stringify({ planUsage: { totalPercentUsed: 68.45, autoPercentUsed: 68.45 }, billingCycleEnd: '1794928800853' }),
          { status: 200 },
        ),
      [PLAN]: () => new Response(JSON.stringify({ planInfo: { planName: 'Premium' } }), { status: 200 }),
    })
    const outcome = await fetchCursorUsage(impl, home, env(home, await writeStateDb(home, token)))

    expect(outcome.available).toBe(true)
    const period = calls.find((c) => c.url === PERIOD)!
    expect(period.init.method).toBe('POST')
    expect((period.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`)
    expect((period.init.headers as Record<string, string>)['Connect-Protocol-Version']).toBe('1')
    expect(period.init.body).toBe('{}')
    // The legacy endpoint must not be asked once the current one answered
    expect(calls.some((c) => c.url === SUMMARY)).toBe(false)
    expect(JSON.parse(outcome.body!)).toMatchObject({ cursorPlanName: 'Premium' })
  })

  it('falls back to the summary when planUsage carries no usable number', async () => {
    const home = await tempHome()
    const { impl, calls } = routed({
      // A payload the renderer could not read: adopting it would report
      // "no data" and never reach the fallback.
      [PERIOD]: () => new Response(JSON.stringify({ planUsage: { totalPercentUsed: null } }), { status: 200 }),
      [PLAN]: () => new Response(JSON.stringify({ planInfo: { planName: 'Premium' } }), { status: 200 }),
      [SUMMARY]: () =>
        new Response(JSON.stringify({ individualUsage: { plan: { totalPercentUsed: 12 } } }), { status: 200 }),
    })
    const outcome = await fetchCursorUsage(impl, home, env(home, await writeStateDb(home, jwt('user_01|acct-42'))))

    expect(outcome.available).toBe(true)
    expect(calls.some((c) => c.url === SUMMARY)).toBe(true)
    expect(JSON.parse(outcome.body!)).toMatchObject({ individualUsage: { plan: { totalPercentUsed: 12 } } })
  })

  it('accepts a percentage sent as a string, like other 64-bit fields', async () => {
    const home = await tempHome()
    const { impl } = routed({
      [PERIOD]: () => new Response(JSON.stringify({ planUsage: { totalPercentUsed: '31.5' } }), { status: 200 }),
      [PLAN]: () => new Response('{}', { status: 200 }),
    })
    const outcome = await fetchCursorUsage(impl, home, env(home, await writeStateDb(home, jwt('user_01|acct-42'))))
    expect(outcome.available).toBe(true)
    expect(JSON.parse(outcome.body!)).toMatchObject({ planUsage: { totalPercentUsed: '31.5' } })
  })

  it('does not send a stored value that is not a token', async () => {
    const home = await tempHome()
    const { impl, calls } = routed({})
    const outcome = await fetchCursorUsage(impl, home, env(home, await writeStateDb(home, 'not-a-jwt')))
    expect(calls).toEqual([])
    expect(outcome).toEqual({ available: false, reason: 'unexpected-token' })
  })
})

describe('userDataOfStateDb', () => {
  it('lands on the app userData root that holds Local State', () => {
    // A wrong level here silently breaks every sealed-token recovery, so the
    // three-level climb is pinned for all three platform layouts.
    expect(userDataOfStateDb(join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))).toBe(
      join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Cursor'),
    )
    expect(userDataOfStateDb(join('', 'home', 'x', '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))).toBe(
      join('', 'home', 'x', '.config', 'Cursor'),
    )
  })
})
