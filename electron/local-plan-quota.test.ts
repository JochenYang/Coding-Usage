import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchCopilotUsage, fetchCursorUsage } from './local-plan-quota'

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
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

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
