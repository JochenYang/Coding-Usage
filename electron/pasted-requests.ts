import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'

/**
 * Manually pasted console requests ("copy as cURL").
 *
 * Replaying the console's own request is the only reliable way to read these
 * quotas here: the session token the console holds lives in page runtime state,
 * not in a cookie we can read, so a reconstructed request is rejected as
 * "not logged in". The pasted request already carries the right cookie, body
 * and security token.
 *
 * A pasted request is a credential (its Cookie header is the session), so it is
 * encrypted with the OS keystore before it touches disk. With no keystore
 * available the save is refused rather than written in plaintext.
 */

export interface PastedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export type PastedTarget = 'alibaba' | 'alitoken' | 'qwen'

const ALLOWED_HOSTS = ['aliyun.com', 'alibabacloud.com', 'qwencloud.com']
const FILE = 'pasted-requests.json'

export interface ParseOk {
  ok: true
  request: PastedRequest
  target: PastedTarget
}

export interface ParseFail {
  ok: false
  reason:
    | 'empty'
    | 'no-url'
    | 'bad-url'
    | 'not-https'
    | 'host-not-allowed'
    | 'unknown-console'
    | 'no-cookie'
}

const KEPT_HEADERS = [
  'cookie',
  'content-type',
  'accept',
  'origin',
  'referer',
  'x-xsrf-token',
  'x-csrf-token',
  'x-requested-with',
  'user-agent',
]

function allowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return ALLOWED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Validate a stored request before replaying it.
 *
 * Parse-time checks are not enough on the load path: this file is on disk and
 * could have been written by an older build or edited by hand. Re-applying the
 * host and header allowlists is what keeps the cookie from being sent anywhere
 * else.
 */
function sanitizeStored(raw: unknown): PastedRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<PastedRequest>
  if (typeof candidate.url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(candidate.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !allowedHost(parsed.hostname)) return null
  if (!candidate.headers || typeof candidate.headers !== 'object') return null
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(candidate.headers)) {
    const key = name.toLowerCase()
    if (!KEPT_HEADERS.includes(key) || typeof value !== 'string' || /[\r\n]/.test(value)) continue
    headers[key] = value
  }
  if (!headers.cookie) return null
  return {
    url: parsed.toString(),
    method: candidate.method === 'GET' ? 'GET' : 'POST',
    headers,
    body: typeof candidate.body === 'string' ? candidate.body : '',
  }
}

/** Shell-like tokenizer: single and double quotes, backslash escapes outside them. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[i + 1]
        i += 1
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current !== '') {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    if (char === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      i += 1
      started = true
      continue
    }
    current += char
    started = true
  }
  if (started || current !== '') tokens.push(current)
  return tokens
}

function targetFor(request: PastedRequest): PastedTarget | null {
  const host = new URL(request.url).hostname.toLowerCase()
  if (host.endsWith('qwencloud.com')) return 'qwen'
  if (/tokenplan|\/personal\/api\//i.test(request.url) || /tokenplan|personal/i.test(request.body)) {
    return 'alitoken'
  }
  if (/codingplan/i.test(request.url) || /codingplan/i.test(request.body)) return 'alibaba'
  return null
}

/**
 * Parse a "copy as cURL" command.
 *
 * A bare `Cookie: ...` header cannot carry the URL, so it is not accepted; the
 * console's own request is what makes the replay trustworthy.
 */
export function parseCurl(input: string): ParseOk | ParseFail {
  const text = input.replace(/\\\r?\n/g, ' ').trim()
  if (text === '') return { ok: false, reason: 'empty' }

  // A pasted header block has no curl command; treat a lone cookie line as one.
  if (!/\bcurl\b/i.test(text) && /^\s*(cookie|accept|content-type)\s*:/im.test(text)) {
    return { ok: false, reason: 'no-url' }
  }

  const tokens = tokenize(text)
  let url = ''
  let method = ''
  const headers: Record<string, string> = {}
  let body = ''

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    const value = (): string => (i + 1 < tokens.length ? (tokens[i + 1] as string) : '')
    if (token === '-H' || token === '--header') {
      const raw = value()
      i += 1
      const colon = raw.indexOf(':')
      if (colon > 0) {
        const name = raw.slice(0, colon).trim()
        const headerValue = raw.slice(colon + 1).trim()
        // Header injection cannot survive a newline in a value.
        if (name !== '' && !/[\r\n]/.test(headerValue)) headers[name.toLowerCase()] = headerValue
      }
      continue
    }
    if (token === '-X' || token === '--request') {
      method = value().toUpperCase()
      i += 1
      continue
    }
    if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary') {
      body = value()
      i += 1
      continue
    }
    if (token === '-b' || token === '--cookie') {
      const raw = value()
      i += 1
      if (!/[\r\n]/.test(raw)) headers.cookie = raw
      continue
    }
    if (token === '--url') {
      url = value()
      i += 1
      continue
    }
    if (token.startsWith('http://') || token.startsWith('https://')) {
      if (url === '') url = token
      continue
    }
  }

  if (url === '') return { ok: false, reason: 'no-url' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'bad-url' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not-https' }
  if (!allowedHost(parsed.hostname)) return { ok: false, reason: 'host-not-allowed' }
  if (!headers.cookie || headers.cookie.trim() === '') return { ok: false, reason: 'no-cookie' }

  // Keep only what a console RPC needs; anything else a page could inject is
  // dropped rather than replayed.
  const kept: Record<string, string> = {}
  for (const name of KEPT_HEADERS) {
    const value = headers[name]
    if (value) kept[name] = value
  }

  const request: PastedRequest = {
    url: parsed.toString(),
    method: method || (body !== '' ? 'POST' : 'GET'),
    headers: kept,
    body,
  }
  const target = targetFor(request)
  if (!target) return { ok: false, reason: 'unknown-console' }
  return { ok: true, request, target }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let storeDir: string | null = null
let cache: Partial<Record<PastedTarget, PastedRequest>> | null = null

export function initPastedRequests(userDataDir: string): void {
  storeDir = userDataDir
  cache = null
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

async function readAll(): Promise<Partial<Record<PastedTarget, PastedRequest>>> {
  if (cache) return cache
  if (!storeDir || !canEncrypt()) {
    cache = {}
    return cache
  }
  try {
    const raw = JSON.parse(await readFile(join(storeDir, FILE), 'utf8')) as {
      entries?: Record<string, string>
    }
    const entries: Partial<Record<PastedTarget, PastedRequest>> = {}
    for (const key of ['alibaba', 'alitoken', 'qwen'] as const) {
      const blob = raw.entries?.[key]
      if (typeof blob !== 'string' || blob === '') continue
      try {
        const plain = safeStorage.decryptString(Buffer.from(blob, 'base64'))
        const request = sanitizeStored(JSON.parse(plain))
        if (request) entries[key] = request
      } catch {
        // An entry this machine cannot decrypt is simply absent.
      }
    }
    cache = entries
  } catch {
    cache = {}
  }
  return cache
}

export async function readPastedRequest(target: PastedTarget): Promise<PastedRequest | null> {
  const all = await readAll()
  return all[target] ?? null
}

export async function savePastedRequest(
  target: PastedTarget,
  request: PastedRequest,
): Promise<{ ok: true } | { ok: false; reason: 'no-keystore' | 'write-failed' }> {
  if (!storeDir || !canEncrypt()) return { ok: false, reason: 'no-keystore' }
  const all = await readAll()
  const next = { ...all, [target]: request }
  try {
    const entries: Record<string, string> = {}
    for (const [key, value] of Object.entries(next)) {
      if (!value) continue
      entries[key] = safeStorage.encryptString(JSON.stringify(value)).toString('base64')
    }
    await writeFile(join(storeDir, FILE), JSON.stringify({ version: 1, entries }), 'utf8')
    cache = next
    return { ok: true }
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
}

export async function clearPastedRequest(target: PastedTarget): Promise<void> {
  // Without a keystore nothing can be decrypted, so writing would wipe the
  // other consoles' entries with an empty store.
  if (!storeDir || !canEncrypt()) return
  const all = await readAll()
  const next = { ...all }
  delete next[target]
  try {
    const entries: Record<string, string> = {}
    for (const [key, value] of Object.entries(next)) {
      if (!value) continue
      entries[key] = safeStorage.encryptString(JSON.stringify(value)).toString('base64')
    }
    await writeFile(join(storeDir, FILE), JSON.stringify({ version: 1, entries }), 'utf8')
    cache = next
  } catch {
    // A failed clear leaves the old request; the card reports the failure.
  }
}

/** Test hook. */
export function resetPastedRequests(): void {
  storeDir = null
  cache = null
}
