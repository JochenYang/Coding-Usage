import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readSealedSecret } from './safe-storage'

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
 * recent builds seal that cell with Electron safeStorage. The sealing is not a
 * dead end: the key is DPAPI-protected inside Cursor's own `Local State`, so on
 * Windows the token is recovered in-process (see safe-storage.ts) and the probe
 * keeps working with the IDE closed. Where that is not possible — another
 * platform, or a store this build cannot read — the state is reported as
 * `sealed-token` instead of guessing, and the user can still paste a token on
 * the providers page.
 */

export interface LocalQuotaOutcome {
  available: boolean
  body?: string
  reason?: string
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

const PROBE_TIMEOUT_MS = 10_000
/**
 * Cursor's current-period allowance (the panel's "Weekly usage limit").
 *
 * `cursor.com/api/usage-summary` still answers, but with the legacy monthly
 * pool: on an account moved to the weekly/unified allowance it reports 0% used
 * while the panel shows real usage. This Connect endpoint is what the current
 * builds call, and its `planUsage` carries the same percentages the panel
 * prints (verified against a live account: 68.45% here, 67% in the IDE).
 */
const CURSOR_PERIOD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
/** Same Connect service: the plan name and whether the pool is weekly */
const CURSOR_PLAN_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo'
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

function readCursorStateToken(path: string): { token: string | null; sealed: boolean; raw?: string } {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('cursorAuth/accessToken') as { value?: unknown } | undefined
    const token = tokenFromCell(row?.value)
    if (!token) return { token: null, sealed: false }
    if (token.startsWith(SEALED_PREFIX)) return { token: null, sealed: true, raw: token }
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

/**
 * Cursor's userData root for a state database path.
 *
 * The database lives at `<userData>/User/globalStorage/state.vscdb`, and the
 * `Local State` holding the safeStorage key sits at `<userData>`. Exported for
 * the path test: a wrong level here silently breaks the whole recovery.
 */
export function userDataOfStateDb(path: string): string {
  return dirname(dirname(dirname(path)))
}

/**
 * Decryption costs a PowerShell child and can never succeed on a store this
 * build cannot read, so a failure is remembered briefly: a card refresh loop
 * must not spawn PowerShell every few seconds.
 */
const SEALED_RETRY_MS = 60_000
let sealedFailedAt = 0

/**
 * Recover a sealed access token from Cursor's own store.
 *
 * The cell is `cursor-safe-storage:v1:` followed by base64 of a Chromium `v10`
 * blob; the key is unwrapped through DPAPI from the same app's `Local State`
 * (verified on a live install: the recovered value is a valid JWT and the
 * quota endpoint answers 200). Null means "cannot read here", not "no login".
 */
async function decryptSealedToken(sealed: string, stateDbPath: string): Promise<string | null> {
  if (Date.now() - sealedFailedAt < SEALED_RETRY_MS) return null
  const body = sealed.slice(SEALED_PREFIX.length)
  if (!body) return null
  const plain = await readSealedSecret(userDataOfStateDb(stateDbPath), Buffer.from(body, 'base64'))
  const token = plain?.trim() ?? ''
  if (token === '') {
    sealedFailedAt = Date.now()
    return null
  }
  sealedFailedAt = 0
  return token
}

async function readCursorToken(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<{ token: string | null; sealed: boolean }> {
  const { auth, state } = cursorCandidates(home, env)
  // A sealed CLI store must not short-circuit the IDE store: the CLI's file has
  // no adjacent key to unwrap, while state.vscdb does — so the sealed verdict is
  // only reached once every candidate has been tried.
  let sawSealed = false
  for (const path of auth) {
    const parsed = jsonObject(await readText(path))
    const token = parsed?.accessToken
    if (typeof token === 'string' && token.trim() !== '') {
      if (token.startsWith(SEALED_PREFIX)) {
        sawSealed = true
        continue
      }
      return { token: token.trim(), sealed: false }
    }
  }
  for (const path of state) {
    const found = readCursorStateToken(path)
    if (found.sealed && found.raw) {
      const decrypted = await decryptSealedToken(found.raw, path)
      if (decrypted) return { token: decrypted, sealed: false }
      return { token: null, sealed: true }
    }
    if (found.token) return found
  }
  return { token: null, sealed: sawSealed }
}

/**
 * The plan name for the card's badge, or null when this build does not say.
 *
 * Best-effort on purpose: the allowance is the card's purpose, and a failed
 * plan lookup must not cost the user their numbers.
 */
async function fetchCursorPlanName(fetchImpl: FetchImpl, token: string): Promise<string | null> {
  try {
    const res = await fetchImpl(CURSOR_PLAN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const parsed: unknown = JSON.parse(await res.text())
    const info =
      parsed != null && typeof parsed === 'object'
        ? (parsed as { planInfo?: unknown }).planInfo
        : null
    const name =
      info != null && typeof info === 'object' ? (info as { planName?: unknown }).planName : null
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null
  }
}

/**
 * Memoised plan name, keyed by a digest of the token.
 *
 * A subscription tier changes at most monthly, while the card refreshes every
 * couple of minutes; without this the badge would cost a request on every
 * refresh for a value that never moves. The digest is the cache key so signing
 * into a different account cannot keep showing the previous account's plan —
 * and the raw token is never used as a map key.
 */
const PLAN_NAME_TTL_MS = 6 * 60 * 60_000
let cachedPlanName: { key: string; value: string; at: number } | null = null

async function cachedCursorPlanName(fetchImpl: FetchImpl, token: string): Promise<string | null> {
  const key = createHash('sha256').update(token).digest('hex').slice(0, 16)
  if (cachedPlanName && cachedPlanName.key === key && Date.now() - cachedPlanName.at < PLAN_NAME_TTL_MS) {
    return cachedPlanName.value
  }
  const value = await fetchCursorPlanName(fetchImpl, token)
  // Only successes are remembered: a transient failure must not pin "no plan".
  if (value) cachedPlanName = { key, value, at: Date.now() }
  return value
}

/** Test seam: drop the in-process caches */
export function resetCursorProbeCaches(): void {
  cachedPlanName = null
  sealedFailedAt = 0
}

/**
 * A finite number from a JSON number or a numeric string.
 *
 * Proto JSON serializes 64-bit integers as strings (`billingCycleEnd` arrives
 * as `"1794928800853"`), so a percentage could follow the same rule. The
 * renderer's parser accepts both as well — the adoption gate and the parser
 * must agree, or a usable payload is swallowed here and never falls back.
 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * The current-period allowance, or null when this account/build cannot supply a
 * usable one.
 *
 * The gate is deliberately the same judgement the renderer applies — at least
 * one of the two percentages parses. Adopting a payload the renderer cannot
 * read would report "no data" instead of falling back to the legacy summary,
 * which is worse than the stale number this change replaces.
 */
async function fetchCursorPeriodUsage(fetchImpl: FetchImpl, token: string): Promise<string | null> {
  try {
    const res = await fetchImpl(CURSOR_PERIOD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = await res.text()
    const parsed: unknown = JSON.parse(body)
    const planUsage =
      parsed != null && typeof parsed === 'object'
        ? (parsed as { planUsage?: unknown }).planUsage
        : null
    if (planUsage == null || typeof planUsage !== 'object') return null
    const usage = planUsage as { totalPercentUsed?: unknown; autoPercentUsed?: unknown }
    const usable = finiteNumber(usage.totalPercentUsed) ?? finiteNumber(usage.autoPercentUsed)
    return usable == null ? null : body
  } catch {
    return null
  }
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

    // Preferred: the endpoint current builds use for the panel's own figure.
    // Guarded by the same "looks like a JWT" check the fallback needs, so a
    // non-token value sitting in the store is never sent as a bearer header.
    // The plan name is a badge, not the allowance: it is fetched alongside and
    // memoised, so it can neither delay the numbers past the card's own race
    // budget nor cost a request per refresh.
    if (token.split('.').length === 3) {
      const [period, planName] = await Promise.all([
        fetchCursorPeriodUsage(fetchImpl, token),
        cachedCursorPlanName(fetchImpl, token),
      ])
      if (period) {
        if (!planName) return { available: true, body: period }
        // Tag the payload with the name so the card can show its badge without a
        // second IPC round-trip. Only this probe writes it; the renderer treats
        // it as optional.
        const merged: unknown = { ...(JSON.parse(period) as object), cursorPlanName: planName }
        return { available: true, body: JSON.stringify(merged) }
      }
    }

    // Legacy fallback: the web session authenticates with a cookie whose account
    // id is the tail of the JWT `sub` claim; the raw token alone is not accepted.
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
