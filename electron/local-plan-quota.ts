import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Local-login quota probes for Cursor and GitHub Copilot.
 *
 * Both services only expose their allowance to a signed-in client, so the
 * token is read from the client's own on-disk login — the same shape as the
 * Codex/Claude/Gemini probes: the credential never leaves the main process and
 * only the usage JSON crosses the IPC boundary.
 *
 * Cursor is the awkward one. The dashboard authenticates with a
 * `WorkosCursorSessionToken` cookie built from the editor's OAuth token, and
 * recent builds seal that cell with Electron safeStorage (whose key lives in
 * the OS keychain and belongs to Cursor, not to us). A sealed token is reported
 * as such instead of guessing; the user can still paste a token on the
 * providers page.
 */

export interface LocalQuotaOutcome {
  available: boolean
  body?: string
  reason?: string
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

const PROBE_TIMEOUT_MS = 10_000
const CURSOR_USAGE_URL = 'https://cursor.com/api/usage-summary'
/** The endpoint gates on a client identity, not on the token alone */
const CURSOR_UA = 'cursor-agent/2026.07.07'
const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user'
/** Cursor's sealed-token prefix (Chromium safeStorage ciphertext, base64) */
const SEALED_PREFIX = 'cursor-safe-storage:v1:'

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function jsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw == null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** JWT payload → JSON; base64url without padding */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(base64 + '='.repeat((4 - (base64.length % 4)) % 4), 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ===== GitHub Copilot =====

/**
 * Candidates for the Copilot extension's login file, most specific first.
 * `hosts.json` holds one entry per GitHub host:
 * `{"github.com": {"user": "...", "oauth_token": "gho_…"}}`.
 */
function copilotCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'github-copilot', 'hosts.json'))
  out.push(join(home, '.config', 'github-copilot', 'hosts.json'))
  if (env.APPDATA) out.push(join(env.APPDATA, 'github-copilot', 'hosts.json'))
  return out
}

async function readCopilotToken(home: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const path of copilotCandidates(home, env)) {
    const parsed = jsonObject(await readText(path))
    if (!parsed) continue
    // Prefer the public host, but any entry carrying a token will do
    const entries = Object.entries(parsed).sort(([a], [b]) =>
      a === 'github.com' ? -1 : b === 'github.com' ? 1 : 0,
    )
    for (const [, value] of entries) {
      if (!value || typeof value !== 'object') continue
      const token = (value as { oauth_token?: unknown }).oauth_token
      if (typeof token === 'string' && token.trim() !== '') return token.trim()
    }
  }
  return null
}

export async function fetchCopilotUsage(
  fetchImpl: FetchImpl,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalQuotaOutcome> {
  try {
    const token = await readCopilotToken(home, env)
    if (!token) return { available: false, reason: 'no-login' }
    const res = await fetchImpl(COPILOT_USER_URL, {
      method: 'GET',
      headers: {
        Authorization: `token ${token}`,
        'Editor-Version': 'vscode/1.96.2',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'X-Github-Api-Version': '2025-04-01',
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) return { available: false, reason: `http-${res.status}` }
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    return { available: true, body: await res.text() }
  } catch {
    return { available: false, reason: 'probe-failed' }
  }
}

// ===== Cursor =====

/** Cursor CLI login (`cursor-agent login`) and the IDE's global state database */
function cursorCandidates(home: string, env: NodeJS.ProcessEnv): { auth: string[]; state: string[] } {
  const auth: string[] = []
  const state: string[] = []
  const configRoot = env.XDG_CONFIG_HOME ?? join(home, '.config')
  auth.push(join(configRoot, 'cursor', 'auth.json'))
  if (env.APPDATA) auth.push(join(env.APPDATA, 'cursor', 'auth.json'))
  if (env.LOCALAPPDATA) auth.push(join(env.LOCALAPPDATA, 'cursor-agent', 'auth.json'))

  if (env.APPDATA) state.push(join(env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
  state.push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
  state.push(join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
  return { auth, state }
}

/** The token row may be TEXT, or UTF-16 BLOB in older builds — handle both */
function tokenFromCell(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) {
    const utf16 = Buffer.from(value).toString('utf16le').replace(/\0+$/, '').trim()
    if (utf16) return utf16
    return Buffer.from(value).toString('utf8').replace(/\0+$/, '').trim() || null
  }
  return null
}

function readCursorStateToken(path: string): { token: string | null; sealed: boolean } {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('cursorAuth/accessToken') as { value?: unknown } | undefined
    const token = tokenFromCell(row?.value)
    if (!token) return { token: null, sealed: false }
    if (token.startsWith(SEALED_PREFIX)) return { token: null, sealed: true }
    return { token, sealed: false }
  } catch {
    return { token: null, sealed: false }
  } finally {
    try {
      db?.close()
    } catch {
      // already closed / never opened
    }
  }
}

async function readCursorToken(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<{ token: string | null; sealed: boolean }> {
  const { auth, state } = cursorCandidates(home, env)
  for (const path of auth) {
    const parsed = jsonObject(await readText(path))
    const token = parsed?.accessToken
    if (typeof token === 'string' && token.trim() !== '') {
      if (token.startsWith(SEALED_PREFIX)) return { token: null, sealed: true }
      return { token: token.trim(), sealed: false }
    }
  }
  for (const path of state) {
    const found = readCursorStateToken(path)
    if (found.token || found.sealed) return found
  }
  return { token: null, sealed: false }
}

export async function fetchCursorUsage(
  fetchImpl: FetchImpl,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalQuotaOutcome> {
  try {
    const { token, sealed } = await readCursorToken(home, env)
    if (sealed) return { available: false, reason: 'sealed-token' }
    if (!token) return { available: false, reason: 'no-login' }

    // The web session authenticates with a cookie whose account id is the tail
    // of the JWT `sub` claim; the raw token alone is not accepted.
    const claims = decodeJwtPayload(token)
    const sub = typeof claims?.sub === 'string' ? claims.sub : ''
    const accountId = sub.split('|').pop() ?? ''
    if (!accountId) return { available: false, reason: 'unexpected-token' }

    const res = await fetchImpl(CURSOR_USAGE_URL, {
      method: 'GET',
      headers: {
        Cookie: `WorkosCursorSessionToken=${accountId}%3A%3A${token}`,
        'User-Agent': CURSOR_UA,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    return { available: true, body: await res.text() }
  } catch {
    return { available: false, reason: 'probe-failed' }
  }
}
