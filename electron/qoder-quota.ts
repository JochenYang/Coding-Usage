import { spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Qoder (global build) account quota probe.
 *
 * The IDE's own account panel calls `openapi.qoder.sh/sash/api/v2/me/usage`
 * (verified 2026-11 on Qoder 0.5.6: `usageType: "credits"`, an add-on pool with
 * total/used/remaining). The same numbers are the only account-level figure the
 * build exposes locally — its session store records credits per message but no
 * account balance — so the card asks the endpoint directly and returns numbers
 * only. The bearer token never crosses the IPC boundary.
 *
 * Credential: the IDE keeps its login in `<userData>/auth.v1.dat`, an Electron
 * `safeStorage` v10 blob (AES-256-GCM) whose key sits DPAPI-protected in the
 * same directory's `Local State`. Another app cannot ask `safeStorage` to
 * decrypt it — that API only knows its own key (verified: it fails) — so on
 * Windows the key is unwrapped through DPAPI once and the token is then cached
 * in memory. The PowerShell child receives the wrapped key on stdin, not on its
 * command line, so the blob does not appear in `Win32_Process.CommandLine`.
 *
 * Windows only: macOS keeps the equivalent key in the Login keychain and Linux
 * in the secret service, neither of which this module implements. Those
 * platforms report `unsupported-platform` — a state the card turns into
 * "cannot be read here" — rather than the misleading "no login".
 *
 * Failure is always a state, never an exception: no install, no login, a
 * blocked/absent PowerShell, a rotated token or an HTTP error all map to
 * `available: false` with a reason the card can act on.
 */

export interface QoderQuotaOutcome {
  available: boolean
  reason?: string
  /** Credits spent in the current pool */
  used?: number
  /** Pool size in credits */
  total?: number
  remaining?: number
  /** 0-100, always derived from the same pool as used/total */
  percent?: number
  isQuotaExceeded?: boolean
  /** Account tier as the vendor names it ("personal_standard", …) */
  userType?: string
  /** Unit label from the vendor ("credits") */
  unit?: string
  fetchedAt: number
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

const USAGE_URL = 'https://openapi.qoder.sh/sash/api/v2/me/usage'

/** Qoder's userData directory name inside the platform appData root */
const USER_DATA_NAME = 'com.qoder.app.stable'

/**
 * DPAPI unwrap script, read by the child from stdin so the wrapped key never
 * appears on a command line (`Win32_Process.CommandLine` is readable by other
 * processes and by admin tooling).
 */
const DPAPI_SCRIPT = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String('$KEY')
$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($p)
`.trim()

const DPAPI_TIMEOUT_MS = 10_000
const HTTP_TIMEOUT_MS = 15_000

/** In-memory token cache: decryption costs a child process, the token is good for a session */
let tokenCache: { token: string; expiresAtMs: number; authMtimeMs: number } | null = null

/** One HTTP response's worth of cached quota, so a page revisit is free */
const QUOTA_CACHE_MS = 2 * 60_000
let quotaCache: { at: number; outcome: QoderQuotaOutcome } | null = null

/**
 * Qoder's userData directory for a given appData root.
 *
 * The caller supplies `app.getPath('appData')`; the IDE's own directory name is
 * not this app's, so the path is resolved here and pinned by a test.
 */
export function qoderUserDataDir(appDataRoot: string): string {
  return join(appDataRoot, USER_DATA_NAME)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Narrow the vendor's response. Everything is optional on purpose: the schema
 * is not published, so a field this build does not know is dropped rather than
 * trusted, and a response without a usable pool reports "no-quota".
 *
 * The pool that carries a size supplies used/total/remaining AND the
 * percentage, so the bar can never disagree with the numbers printed under it.
 * The account-level `totalUsagePercentage` is only a fallback for an account
 * whose pools are both empty — it is computed over every pool, so pairing it
 * with one pool's figures is how a card ends up showing "100 of 200" at 0%.
 */
export function narrowQoderUsage(raw: unknown): Omit<QoderQuotaOutcome, 'fetchedAt'> {
  const usage = asRecord(asRecord(raw)?.qoderUsage)
  if (!usage) return { available: false, reason: 'malformed-response' }

  const pools = [asRecord(usage.userQuota), asRecord(usage.addOnQuota)].filter(
    (pool): pool is Record<string, unknown> => pool != null,
  )
  const sized = pools.find((pool) => (num(pool.total) ?? 0) > 0) ?? null
  const total = sized ? num(sized.total) : null
  const used = sized ? num(sized.used) : null
  const remaining = sized ? num(sized.remaining) : null

  const derived = total != null && total > 0 && used != null ? (used / total) * 100 : null
  const vendorPercent = num(usage.totalUsagePercentage)
  const percentSource = derived ?? (vendorPercent != null ? vendorPercent * 100 : null)
  if (percentSource == null && total == null && used == null) {
    return { available: false, reason: 'no-quota' }
  }

  return {
    available: true,
    used: used ?? undefined,
    total: total ?? undefined,
    remaining: remaining ?? (total != null && used != null ? Math.max(0, total - used) : undefined),
    percent:
      percentSource == null ? undefined : Math.min(100, Math.max(0, Math.round(percentSource * 10) / 10)),
    isQuotaExceeded: usage.isQuotaExceeded === true,
    userType: str(usage.userType) ?? undefined,
    unit: str(sized?.unit) ?? undefined,
  }
}

/** DPAPI-unwrap the Chromium key through a short-lived PowerShell child */
function unwrapDpapiKey(wrapped: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true,
    })
    let out = ''
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, DPAPI_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    // PowerShell writes its own diagnostics on stderr; drained, never parsed
    child.stderr?.resume()
    child.on('error', () => finish(null))
    child.on('close', () => finish(out.trim() ? Buffer.from(out.trim(), 'base64') : null))
    child.stdin?.end(DPAPI_SCRIPT.replace('$KEY', wrapped.toString('base64')))
  })
}

type StoredAuth = { ok: true; token: string; expiresAtMs: number } | { ok: false; reason: string }

/**
 * Decrypt `<userData>/auth.v1.dat` into the bearer token.
 *
 * `mtimeMs` is returned so a login completed (or an account switched) inside the
 * IDE invalidates the in-memory cache even when the old token has not expired.
 */
async function readStoredAuth(userData: string): Promise<StoredAuth & { mtimeMs?: number }> {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' }

  let localState: unknown
  let blob: Buffer
  let mtimeMs: number
  try {
    localState = JSON.parse(await readFile(join(userData, 'Local State'), 'utf8'))
    const authPath = join(userData, 'auth.v1.dat')
    blob = await readFile(authPath)
    mtimeMs = (await stat(authPath)).mtimeMs
  } catch {
    return { ok: false, reason: 'no-login' }
  }

  const encodedKey = str(asRecord(asRecord(localState)?.os_crypt)?.encrypted_key)
  if (!encodedKey) return { ok: false, reason: 'no-login' }
  const wrapped = Buffer.from(encodedKey, 'base64')
  // "DPAPI" prefix: the key itself is DPAPI-protected (Chromium's Windows path)
  if (wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') return { ok: false, reason: 'unsupported-platform' }

  const key = await unwrapDpapiKey(wrapped.subarray(5))
  // PowerShell missing, blocked by policy or the call failed: the state is
  // "cannot read here", not "not signed in".
  if (!key || key.length !== 32) return { ok: false, reason: 'decrypt-failed' }

  // v10: AES-256-GCM with a 12-byte nonce and a trailing 16-byte tag
  if (blob.subarray(0, 3).toString('latin1') !== 'v10' || blob.length < 3 + 12 + 16) {
    return { ok: false, reason: 'decrypt-failed' }
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(3, 15))
    decipher.setAuthTag(blob.subarray(blob.length - 16))
    const plain = Buffer.concat([decipher.update(blob.subarray(15, blob.length - 16)), decipher.final()]).toString(
      'utf8',
    )
    const auth = asRecord(JSON.parse(plain))
    const token = str(auth?.token)
    if (!token) return { ok: false, reason: 'no-login' }
    const expiresMs = typeof auth?.expiresAt === 'string' ? Date.parse(auth.expiresAt) : NaN
    return { ok: true, token, expiresAtMs: Number.isFinite(expiresMs) ? expiresMs : 0, mtimeMs }
  } catch {
    return { ok: false, reason: 'decrypt-failed' }
  }
}

/**
 * Read the account quota. `netFetch` is the main process's session-bound fetch
 * (never a third-party proxy); `appDataRoot` is `app.getPath('appData')`.
 *
 * Cached for two minutes per process: the card re-mounts on every Plans-page
 * visit and the endpoint is rate-limited on the vendor's side.
 */
export async function readQoderQuota(
  netFetch: FetchImpl,
  appDataRoot: string,
  now = Date.now(),
): Promise<QoderQuotaOutcome> {
  if (quotaCache && now - quotaCache.at < QUOTA_CACHE_MS) return quotaCache.outcome

  const outcome = await probe(netFetch, appDataRoot, now)
  // Only successful reads are cached: a login completed in the IDE must show up
  // on the very next visit, exactly like the other quota probes.
  if (outcome.available) quotaCache = { at: now, outcome }
  return outcome
}

async function probe(netFetch: FetchImpl, appDataRoot: string, now: number): Promise<QoderQuotaOutcome> {
  const userData = qoderUserDataDir(appDataRoot)

  if (!tokenCache || tokenCache.expiresAtMs - 60_000 < now) {
    const stored = await readStoredAuth(userData)
    if (!stored.ok) return { available: false, reason: stored.reason, fetchedAt: now }
    tokenCache = { token: stored.token, expiresAtMs: stored.expiresAtMs, authMtimeMs: stored.mtimeMs ?? 0 }
  } else {
    // The IDE rewrites the file on sign-in/sign-out; a changed mtime means a
    // different account (or no account) and the cached token must go.
    try {
      const mtimeMs = (await stat(join(userData, 'auth.v1.dat'))).mtimeMs
      if (mtimeMs !== tokenCache.authMtimeMs) {
        tokenCache = null
        const stored = await readStoredAuth(userData)
        if (!stored.ok) return { available: false, reason: stored.reason, fetchedAt: now }
        tokenCache = { token: stored.token, expiresAtMs: stored.expiresAtMs, authMtimeMs: stored.mtimeMs ?? 0 }
      }
    } catch {
      tokenCache = null
      return { available: false, reason: 'no-login', fetchedAt: now }
    }
  }

  const token = tokenCache?.token
  if (!token) return { available: false, reason: 'no-login', fetchedAt: now }

  let res: Response
  try {
    res = await netFetch(USAGE_URL, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      // A hung socket must not outlive the card's own 15 s race, and a redirect
      // must never replay the bearer header to another host.
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
    })
  } catch {
    return { available: false, reason: 'network', fetchedAt: now }
  }
  if (res.status === 401 || res.status === 403) {
    // The stored token was rotated out from under us; drop it so the next
    // attempt re-reads the file instead of replaying a dead value.
    tokenCache = null
    return { available: false, reason: `http-${res.status}`, fetchedAt: now }
  }
  if (!res.ok) return { available: false, reason: `http-${res.status}`, fetchedAt: now }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { available: false, reason: 'bad-response', fetchedAt: now }
  }
  return { ...narrowQoderUsage(json), fetchedAt: now }
}

/** Test seam: drop the in-process caches */
export function resetQoderQuotaCache(): void {
  tokenCache = null
  quotaCache = null
}
