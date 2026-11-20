import { createCipheriv } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { decryptChromiumV10, readChromiumKey } from './safe-storage'

/**
 * Read-only Chromium cookie access for a caller-supplied host allowlist.
 *
 * Chrome and Edge keep cookie values in a SQLite file, sealed with the same
 * `v10` AES-256-GCM key as other Chromium apps (`Local State` + DPAPI, see
 * safe-storage.ts). This module opens that file in place, read-only, and reads
 * only rows whose host the caller named. Nothing is copied, so no plaintext
 * cookie database is ever written to a temp directory.
 *
 * Two rules keep the result honest:
 *
 * - A cookie is returned only when the browser itself would send it to
 *   `forHost`. A host-only cookie from another console host is not forwarded,
 *   and one browser profile is used, not a merge of all of them.
 * - `v20` app-bound cookies use a key this process cannot unwrap. If any
 *   allowlisted row is app-bound, the read reports `app-bound` even when other
 *   cookies decrypted — shipping a jar with the session cookie missing would
 *   read as "your login expired" and send the user in circles.
 *
 * There is no IPC method here: a probe in the main process is the only caller.
 */

const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
/** Characters that would split or terminate a Cookie header value. */
const UNSAFE_VALUE = /[\s;,"\\\u0000-\u001f\u007f]/
/** Public suffixes a two-label allowlist entry must not be. */
const PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'co.jp',
  'co.kr',
  'com.au',
  'com.br',
  'com.tw',
  'com.hk',
])

export interface DecryptedCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  /** Null means a session cookie. */
  expiresAt: number | null
}

export interface CookieReadOk {
  ok: true
  cookies: DecryptedCookie[]
  /** False when a row was skipped for an unusable name or value. */
  complete: boolean
}

export interface CookieReadMiss {
  ok: false
  reason: 'empty-allowlist' | 'unsupported-platform' | 'no-browser' | 'no-key' | 'locked' | 'no-match' | 'app-bound'
}

export type CookieReadResult = CookieReadOk | CookieReadMiss

export interface CookieReadOptions {
  /** Epoch ms. Injected by tests so expiry does not depend on the clock. */
  now?: number
  /** Absolute user-data roots to read instead of the installed Chrome and Edge. */
  userDataDirs?: string[]
  /** Skip DPAPI and decrypt with this key. Tests only. */
  key?: Buffer
  /**
   * The host the probe will actually request. Only cookies the browser would
   * send there are returned. Defaults to the first allowlisted host.
   */
  forHost?: string
}

/** Hosts a domain cookie may cover. A single-label parent is never a candidate. */
export function candidateHostKeys(host: string): string[] {
  const bare = host.toLowerCase()
  const labels = bare.split('.').filter(Boolean)
  const keys = new Set<string>([bare, `.${bare}`])
  for (let i = 1; i < labels.length - 1; i += 1) {
    keys.add(`.${labels.slice(i).join('.')}`)
  }
  return [...keys]
}

/**
 * Whether the browser would send this cookie to `requestedHost`.
 * A host-only cookie matches only that exact host; a domain cookie matches it
 * and its subdomains, never a sibling, and never a bare public suffix.
 */
export function cookieMatchesHost(cookieHost: string, requestedHost: string): boolean {
  const requested = requestedHost.toLowerCase()
  const domainCookie = cookieHost.startsWith('.')
  const cookie = cookieHost.toLowerCase().replace(/^\./, '')
  if (!domainCookie) return cookie === requested
  if (cookie.split('.').filter(Boolean).length < 2) return false
  if (PUBLIC_SUFFIXES.has(cookie)) return false
  return requested === cookie || requested.endsWith(`.${cookie}`)
}

/** Chrome stores expiry as microseconds since 1601-01-01, which does not fit in a JS number. */
export function chromeExpiryToMs(expiresUtc: string | number | bigint | null): number | null {
  if (expiresUtc == null || expiresUtc === '' || expiresUtc === 0 || expiresUtc === 0n) return null
  let us: bigint
  try {
    us = BigInt(expiresUtc)
  } catch {
    return null
  }
  if (us <= 0n) return null
  const ms = Number((us - CHROME_EPOCH_OFFSET_US) / 1000n)
  return Number.isFinite(ms) ? ms : null
}

function normalizeHosts(hosts: string[]): string[] | null {
  const out: string[] = []
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase().replace(/^\./, '')
    if (!HOST_PATTERN.test(host)) return null
    if (PUBLIC_SUFFIXES.has(host)) return null
    out.push(host)
  }
  return out.length > 0 ? out : null
}

type BlobRead = { kind: 'value'; value: string } | { kind: 'undecryptable'; appBound: boolean } | { kind: 'empty' }

/** Decrypt one cookie cell. `v20` is refused; a failed `v10` tag is not returned as text. */
export function decryptCookieBlob(encrypted: Uint8Array | null, plaintext: string, key: Buffer): BlobRead {
  if (encrypted && encrypted.byteLength >= 3) {
    const prefix = Buffer.from(encrypted.subarray(0, 3)).toString('latin1')
    if (prefix === 'v20') return { kind: 'undecryptable', appBound: true }
    if (prefix === 'v10') {
      const value = decryptChromiumV10(Buffer.from(encrypted), key)
      return value == null ? { kind: 'undecryptable', appBound: false } : { kind: 'value', value }
    }
  }
  if (plaintext !== '') return { kind: 'value', value: plaintext }
  return { kind: 'empty' }
}

interface CookieRow {
  host_key: string
  name: string
  value: string
  encrypted_value: Uint8Array | null
  path: string
  expires_utc: string
  is_secure: number
}

/**
 * Cookie databases that recently refused to open, with the time of the miss.
 *
 * A running Chrome holds its cookie file, and opening it fails after a fixed
 * ~1.4 s of internal retries regardless of the SQLite busy timeout. Remembering
 * the miss keeps a refresh tick from paying that cost again for every card.
 */
const DB_LOCKED = new Map<string, number>()
const DB_LOCKED_MS = 5 * 60_000

/**
 * Matching rows, longest path first so the header follows RFC 6265 precedence.
 * Opened read-only in place; a live database that cannot be opened is reported
 * as a miss, never copied.
 */
function readRows(dbPath: string, hostKeys: string[]): CookieRow[] | null {
  const lockedAt = DB_LOCKED.get(dbPath)
  if (lockedAt != null && Date.now() - lockedAt < DB_LOCKED_MS) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const marks = hostKeys.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure ` +
          `FROM cookies WHERE host_key IN (${marks}) ORDER BY length(path) DESC`,
      )
      .all(...hostKeys) as unknown as CookieRow[]
    DB_LOCKED.delete(dbPath)
    return rows
  } catch {
    DB_LOCKED.set(dbPath, Date.now())
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
}

function profileDirs(userData: string, names: string[]): string[] {
  return names.filter((name) => name === 'Default' || name.startsWith('Profile ')).map((name) => join(userData, name))
}

async function cookieFiles(profileDir: string): Promise<string[]> {
  const found: string[] = []
  for (const relative of ['Network/Cookies', 'Cookies']) {
    const path = join(profileDir, relative)
    try {
      if ((await stat(path)).isFile()) found.push(path)
    } catch {
      // absent profile file
    }
  }
  return found
}

function browserRoots(env: NodeJS.ProcessEnv): string[] {
  if (!env.LOCALAPPDATA) return []
  return [
    join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
    join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
  ]
}

/**
 * Cookies the browser would send to the named host, decrypted in this process.
 * The allowlist is required. One profile wins; profiles are never merged, so a
 * request cannot mix two accounts' sessions.
 */
export async function readAllowlistedCookies(
  hosts: string[],
  options: CookieReadOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CookieReadResult> {
  const allowed = normalizeHosts(hosts)
  if (!allowed) return { ok: false, reason: 'empty-allowlist' }
  const target = (options.forHost ?? allowed[0] ?? '').toLowerCase()
  if (!HOST_PATTERN.test(target)) return { ok: false, reason: 'empty-allowlist' }
  const roots = options.userDataDirs ?? browserRoots(env)
  const existing: string[] = []
  for (const root of roots) {
    try {
      if ((await stat(root)).isDirectory()) existing.push(root)
    } catch {
      // browser not installed
    }
  }
  if (existing.length === 0) return { ok: false, reason: 'no-browser' }
  if (!options.key && process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' }

  const hostKeys = [...new Set(allowed.flatMap(candidateHostKeys))]
  const now = options.now ?? Date.now()
  let sawKey = false
  let sawFile = false
  let locked = false
  let appBound = false
  let complete = true

  for (const root of existing) {
    const key = options.key ?? (await readChromiumKey(root))
    if (!key) continue
    sawKey = true
    let rootLocked = false
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      continue
    }
    for (const profile of profileDirs(root, names)) {
      // A running browser holds its active profile's database. Once one file
      // under this root refuses to open, the others are almost certainly the
      // same instance; probing each costs another 1.4 s stall for a page that
      // is already loading.
      if (rootLocked) {
        locked = true
        break
      }
      for (const file of await cookieFiles(profile)) {
        sawFile = true
        const rows = readRows(file, hostKeys)
        if (!rows) {
          locked = true
          if (DB_LOCKED.has(file)) rootLocked = true
          continue
        }
        const cookies: DecryptedCookie[] = []
        for (const row of rows) {
          if (!cookieMatchesHost(row.host_key, target)) continue
          const expiresAt = chromeExpiryToMs(row.expires_utc)
          if (expiresAt != null && expiresAt <= now) continue
          const decoded = decryptCookieBlob(row.encrypted_value, row.value ?? '', key)
          if (decoded.kind === 'empty') continue
          if (decoded.kind === 'undecryptable') {
            if (decoded.appBound) appBound = true
            complete = false
            continue
          }
          if (!COOKIE_NAME.test(row.name) || UNSAFE_VALUE.test(decoded.value)) {
            complete = false
            continue
          }
          cookies.push({
            name: row.name,
            value: decoded.value,
            domain: row.host_key,
            path: row.path || '/',
            secure: row.is_secure === 1,
            expiresAt,
          })
        }
        // First profile with a usable session wins; merging profiles mixes accounts.
        if (cookies.length > 0 && !appBound) return { ok: true, cookies, complete }
      }
    }
  }

  // An app-bound row outranks a partial jar: it explains why the session is
  // missing instead of asking the user to sign in again.
  if (appBound) return { ok: false, reason: 'app-bound' }
  if (!sawKey) return { ok: false, reason: 'no-key' }
  if (!sawFile) return { ok: false, reason: 'no-browser' }
  if (locked) return { ok: false, reason: 'locked' }
  return { ok: false, reason: 'no-match' }
}

/** Test helper: seal a cookie value in the same `v10` envelope Chromium writes. */
export function sealCookieValue(plain: string, key: Buffer, nonce = Buffer.alloc(12, 3)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, cipher.getAuthTag()])
}
