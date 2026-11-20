import { mkdirSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  candidateHostKeys,
  chromeExpiryToMs,
  cookieMatchesHost,
  decryptCookieBlob,
  readAllowlistedCookies,
  sealCookieValue,
} from './browser-cookies'

const KEY = Buffer.alloc(32, 4)

function writeProfile(
  root: string,
  rows: Array<{ host: string; name: string; value?: string; encrypted?: Buffer; path?: string; expires?: number; secure?: number }>,
  profile = 'Default',
): void {
  mkdirSync(join(root, profile, 'Network'), { recursive: true })
  const db = new DatabaseSync(join(root, profile, 'Network', 'Cookies'))
  db.exec(
    'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER)',
  )
  const insert = db.prepare(
    'INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const row of rows) {
    insert.run(row.host, row.name, row.value ?? '', row.encrypted ?? null, row.path ?? '/', row.expires ?? 0, row.secure ?? 1)
  }
  db.close()
}

describe('cookie host allowlist', () => {
  it('sends a parent domain cookie to a subdomain and never a sibling', () => {
    expect(cookieMatchesHost('.aliyun.com', 'bailian.console.aliyun.com')).toBe(true)
    expect(cookieMatchesHost('bailian.console.aliyun.com', 'bailian.console.aliyun.com')).toBe(true)
    expect(cookieMatchesHost('evil.aliyun.com', 'bailian.console.aliyun.com')).toBe(false)
    expect(cookieMatchesHost('aliyun.com', 'bailian.console.aliyun.com')).toBe(false)
    expect(cookieMatchesHost('.com', 'aliyun.com')).toBe(false)
    expect(cookieMatchesHost('.co.uk', 'shop.co.uk')).toBe(false)
  })

  it('does not ask the database for a single-label parent', () => {
    expect(candidateHostKeys('bailian.console.aliyun.com')).not.toContain('.com')
    expect(candidateHostKeys('bailian.console.aliyun.com')).toContain('.aliyun.com')
  })

  it('rejects a public suffix as an allowlist entry', async () => {
    expect(await readAllowlistedCookies(['co.uk'])).toEqual({ ok: false, reason: 'empty-allowlist' })
  })

  it('reads a Chrome microsecond expiry that does not fit in a JS number', () => {
    const futureUs = BigInt(Date.now() + 86_400_000) * 1000n + 11_644_473_600_000_000n
    const ms = chromeExpiryToMs(futureUs.toString())
    expect(ms).not.toBeNull()
    expect(ms! > Date.now()).toBe(true)
  })

  it('refuses an empty allowlist before opening a browser', async () => {
    expect(await readAllowlistedCookies([])).toEqual({ ok: false, reason: 'empty-allowlist' })
    expect(await readAllowlistedCookies(['not a host'])).toEqual({ ok: false, reason: 'empty-allowlist' })
  })
})

describe('cookie decryption', () => {
  it('recovers a v10 value and does not treat v20 as plaintext', () => {
    const sealed = sealCookieValue('session-secret', KEY)
    expect(decryptCookieBlob(sealed, '', KEY)).toEqual({ kind: 'value', value: 'session-secret' })
    expect(decryptCookieBlob(Buffer.concat([Buffer.from('v20'), sealed.subarray(3)]), '', KEY)).toEqual({
      kind: 'undecryptable',
      appBound: true,
    })
    expect(decryptCookieBlob(sealed, '', Buffer.alloc(32, 1)).kind).toBe('undecryptable')
  })

  it('returns only the host the browser would send to, longest path first, and drops an expired row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cu-browser-'))
    const future = (Date.now() + 86_400_000) * 1000 + 11_644_473_600_000_000
    const past = (Date.now() - 86_400_000) * 1000 + 11_644_473_600_000_000
    writeProfile(root, [
      { host: '.aliyun.com', name: 'keep', encrypted: sealCookieValue('yes', KEY), expires: future, path: '/' },
      { host: '.aliyun.com', name: 'narrow', encrypted: sealCookieValue('deeper', KEY), expires: future, path: '/cn-beijing' },
      { host: 'evil.example', name: 'drop', encrypted: sealCookieValue('no', KEY), expires: future },
      { host: 'signin.aliyun.com', name: 'ticket', encrypted: sealCookieValue('ticket', KEY), expires: future },
      { host: '.aliyun.com', name: 'old', encrypted: sealCookieValue('stale', KEY), expires: past },
    ])
    const result = await readAllowlistedCookies(['bailian.console.aliyun.com'], {
      userDataDirs: [root],
      key: KEY,
      forHost: 'bailian-cs.console.aliyun.com',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A host-only cookie from signin.aliyun.com is never forwarded to the data host
    expect(result.cookies.map((cookie) => cookie.name)).toEqual(['narrow', 'keep'])
    expect(result.cookies[0]?.value).toBe('deeper')
    const left = await readdir(tmpdir())
    expect(left.some((name) => name.startsWith('cu-cookies-'))).toBe(false)
  })

  it('uses one profile instead of merging two accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cu-browser-'))
    writeProfile(root, [{ host: '.aliyun.com', name: 'session', encrypted: sealCookieValue('first', KEY) }])
    writeProfile(
      root,
      [{ host: '.aliyun.com', name: 'session', encrypted: sealCookieValue('second', KEY) }],
      'Profile 1',
    )
    const result = await readAllowlistedCookies(['aliyun.com'], { userDataDirs: [root], key: KEY, forHost: 'aliyun.com' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cookies).toHaveLength(1)
    expect(result.cookies[0]?.value).toBe('first')
  })

  it('reports app-bound encryption instead of an empty login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cu-browser-'))
    writeProfile(root, [{ host: 'aliyun.com', name: 'bound', encrypted: Buffer.from('v20-not-a-real-blob'), expires: 0 }])
    expect(await readAllowlistedCookies(['aliyun.com'], { userDataDirs: [root], key: KEY })).toEqual({
      ok: false,
      reason: 'app-bound',
    })
  })

  it('does not ship a partial jar when one cookie is app-bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cu-browser-'))
    writeProfile(root, [
      { host: 'aliyun.com', name: 'cna', encrypted: sealCookieValue('anon', KEY) },
      { host: 'aliyun.com', name: 'session', encrypted: Buffer.from('v20-sealed') },
    ])
    // A jar without the session cookie would read as "your login expired".
    expect(await readAllowlistedCookies(['aliyun.com'], { userDataDirs: [root], key: KEY })).toEqual({
      ok: false,
      reason: 'app-bound',
    })
  })
})
