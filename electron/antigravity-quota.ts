import { execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Antigravity subscription quota probe (main process).
 *
 * Two routes reach the same numbers, tried in this order:
 *
 * 1. **Cloud Code (preferred, needs no IDE).** Antigravity keeps its OAuth
 *    credentials in its own SQLite store; the stored access token (refreshed
 *    through Google's token endpoint when stale) authenticates
 *    `v1internal:retrieveUserQuotaSummary` directly. The one non-obvious
 *    requirement is the **User-Agent**: cloudcode-pa answers `403 "You do not
 *    have a valid license of this product"` to a request that does not identify
 *    as Antigravity, which reads like an entitlement problem and is not one —
 *    with `antigravity/… windows/amd64` the very same token returns the quota.
 *    (Verified both ways on a live account.)
 *
 * 2. **The IDE's own language server (fallback, IDE must be running).** A plain
 *    Connect/JSON service behind a self-signed loopback port whose CSRF token
 *    sits in the process command line. Used when the Cloud Code route cannot
 *    answer — e.g. a revoked refresh token — because the IDE may hold a fresher
 *    token than the store does.
 *
 * Nothing is written on either route and no credential leaves the machine: only
 * the quota JSON comes back, and the refresh result is used in memory for this
 * probe alone (Antigravity owns that file and re-writes it itself).
 *
 * Method choice on the loopback route follows what the flavours actually
 * implement (verified against a running IDE): `RetrieveUserQuotaSummary` answers
 * with the two grouped pools the panel shows, `GetUserStatus` is the fallback
 * carrying session-level fractions, and `GetCommandModelConfigs` is unimplemented
 * on the IDE (HTTP 501) so it is not attempted.
 *
 * Every step is best-effort: no credential file, an expired refresh token or no
 * IDE running all degrade to `available: false` with a reason, never to an error
 * the card has to explain.
 */

/**
 * OAuth client used to refresh the stored token.
 *
 * Read from the Antigravity installed on this machine rather than shipped here.
 * The token in the store was minted by that client, and Google binds a refresh
 * token to the client that issued it (the Gemini CLI's client answers
 * `unauthorized_client` for it), so the pair has to come from Antigravity
 * itself. Shipping the values would also mean redistributing another
 * application's credentials — GitHub's push protection blocks exactly that.
 *
 * Discovery is what makes this work with the IDE closed: `~/.gemini/<flavour>/bin/agentapi.bat`
 * is a launcher that persists on disk and names the language server executable,
 * whose string table carries the client id and secret. Nothing is written and
 * nothing leaves the machine; the values live in memory for this probe.
 *
 * A wrong pair cannot corrupt anything: the refresh simply fails and the probe
 * falls through to the loopback route (or reports `refresh-failed`), so the
 * lookup is verified by its own success rather than by trusting the parse.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Flavours that keep a launcher naming the language server executable */
const LAUNCHER_DIRS = ['antigravity-ide', 'antigravity', 'antigravity-cli'] as const

/** Bounded read: the binary is ~135 MB; the credentials sit well inside */
const BINARY_SCAN_BYTES = 140 * 1024 * 1024

interface OAuthClient {
  id: string
  secret: string
}

let cachedClient: OAuthClient | null | undefined

/** Pull the client pair out of one binary's string table */
async function readClientFromBinary(path: string): Promise<OAuthClient | null> {
  try {
    const { open } = await import('node:fs/promises')
    const handle = await open(path, 'r')
    try {
      const size = (await handle.stat()).size
      const length = Math.min(size, BINARY_SCAN_BYTES)
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, 0)
      const text = buf.toString('latin1')
      const id = text.match(/[0-9]{6,}-[a-z0-9]{6,}\.apps\.googleusercontent\.com/)?.[0]
      const secret = text.match(/GOCSPX-[A-Za-z0-9_-]{10,}/)?.[0]
      return id && secret ? { id, secret } : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** Locate the Antigravity install and read its OAuth client (cached per run) */
async function resolveClient(): Promise<OAuthClient | null> {
  if (cachedClient !== undefined) return cachedClient
  cachedClient = null
  const home = homedir()
  for (const flavour of LAUNCHER_DIRS) {
    const launcher = join(home, '.gemini', flavour, 'bin', 'agentapi.bat')
    try {
      const text = await readFile(launcher, 'utf8')
      const exe = text.match(/"([^"]+\.exe)"/)?.[1]
      if (!exe) continue
      const client = await readClientFromBinary(exe)
      if (client) {
        cachedClient = client
        return client
      }
    } catch {
      // flavour not installed: try the next one
    }
  }
  return cachedClient
}

/** Cloud Code hosts, daily first: that is the channel the IDE itself uses */
const QUOTA_HOSTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']
const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'

/**
 * Identifies the caller as Antigravity. Not cosmetic: cloudcode-pa rejects an
 * otherwise valid token with a 403 licence error when this is missing.
 */
const USER_AGENT = 'antigravity/1.23.2 windows/amd64'

/** Header the language server requires on every loopback request */
const CSRF_HEADER = 'X-Codeium-Csrf-Token'

/** Connect RPC methods to try on the loopback route, best source first */
const METHODS = ['RetrieveUserQuotaSummary', 'GetUserStatus'] as const

/** Bounds every attempt: these probes are garnish, not critical path */
const REQUEST_TIMEOUT_MS = 8_000

/** Ports beyond this are noise from other per-process sockets */
const MAX_PORT_SCAN = 40

interface Candidate {
  csrf: string
  ports: number[]
}

interface StoredCredentials {
  accessToken: string
  refreshToken: string
  /** Epoch ms, 0 when the store carried no expiry */
  expiresAt: number
}

// ===== route 1: Cloud Code =====

/**
 * Read the credentials Antigravity keeps in its own store.
 *
 * The value is base64 → protobuf → base64 again, ending in a protobuf whose
 * fields are the token trio (`#1` access, `#2` type, `#3` refresh, `#4` expiry
 * as `{seconds}`). Field numbers were recovered by walking the real payload; an
 * empty or unreadable store simply yields null so the caller falls through.
 */
async function readStoredCredentials(): Promise<StoredCredentials | null> {
  const candidates = [
    join(process.env.APPDATA ?? '', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    join(process.env.APPDATA ?? '', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
  ]
  for (const dbPath of candidates) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db
          .prepare('SELECT value FROM ItemTable WHERE key = ?')
          .get('antigravityUnifiedStateSync.oauthToken') as { value?: unknown } | undefined
        const raw = row?.value
        if (raw == null) continue
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
        const parsed = decodeTokenBlob(text)
        if (parsed) return parsed
      } finally {
        db.close()
      }
    } catch {
      // store missing / locked by the IDE: try the next path
    }
  }
  return null
}

/**
 * Walk the nested protobuf/base64 envelope down to the token fields.
 *
 * The envelope's first level carries two field-1 branches — the auth-state blob
 * first, the token info second — so the walk is positional at each step rather
 * than by field number, mirroring the structure observed in the real payload:
 *
 *   state.vscdb value
 *     base64 → { #1 authState…, #1 oauthTokenInfo… }
 *                              └─ { #1 "oauthTokenInfoSentinelKey", #2 payload }
 *                                                                    └─ { #1 base64 }
 *                                                                          └─ { #1 access,
 *                                                                               #2 "Bearer",
 *                                                                               #3 refresh,
 *                                                                               #4 { #1 expiry } }
 */
function decodeTokenBlob(base64: string): StoredCredentials | null {
  const outer = readWireFields(Buffer.from(base64, 'base64'))
  const tokenInfo = outer[1]?.bytes ?? null // second branch, not the auth state
  if (!tokenInfo) return null
  const infoFields = readWireFields(tokenInfo)
  const payload = infoFields.find((f) => f.field === 2 && f.bytes)?.bytes ?? null
  if (!payload) return null
  const wrapped = readWireFields(payload).find((f) => f.bytes)?.bytes ?? null
  if (!wrapped) return null
  const tokens = readWireFields(Buffer.from(wrapped.toString('utf8'), 'base64'))
  const access = pickString(tokens, 1)
  const refresh = pickString(tokens, 3)
  if (!access) return null
  const expiryField = pickMessage(tokens, 4)
  let expiresAt = 0
  if (expiryField) {
    const secondsField = readWireFields(expiryField).find((f) => f.field === 1)
    if (secondsField) expiresAt = secondsField.value * 1000
  }
  return { accessToken: access, refreshToken: refresh, expiresAt }
}

interface WireField {
  field: number
  value: number
  bytes?: Buffer
}

function readWireFields(buf: Buffer): WireField[] {
  const out: WireField[] = []
  let i = 0
  while (i < buf.length) {
    let shift = 0
    let tag = 0
    while (i < buf.length) {
      const byte = buf[i++]
      tag |= (byte & 0x7f) << shift
      shift += 7
      if (!(byte & 0x80)) break
    }
    if (shift > 35 || tag === 0) break
    const wire = tag & 7
    if (wire === 0) {
      let value = 0
      shift = 0
      while (i < buf.length) {
        const byte = buf[i++]
        value |= (byte & 0x7f) << shift
        shift += 7
        if (!(byte & 0x80)) break
      }
      out.push({ field: tag >>> 3, value })
    } else if (wire === 2) {
      let len = 0
      shift = 0
      while (i < buf.length) {
        const byte = buf[i++]
        len |= (byte & 0x7f) << shift
        shift += 7
        if (!(byte & 0x80)) break
      }
      if (len < 0 || i + len > buf.length) break
      out.push({ field: tag >>> 3, value: len, bytes: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else break
  }
  return out
}

const pickMessage = (fields: WireField[], n: number): Buffer | null =>
  fields.find((f) => f.field === n && f.bytes)?.bytes ?? null

const pickString = (fields: WireField[], n: number): string => {
  const bytes = pickMessage(fields, n)
  return bytes ? bytes.toString('utf8').trim() : ''
}

/** Exchange the stored refresh token for a fresh access token */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  if (!refreshToken) return null
  const client = await resolveClient()
  if (!client) return null
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { access_token?: unknown }
    return typeof json.access_token === 'string' && json.access_token ? json.access_token : null
  } catch {
    return null
  }
}

/** Ask Cloud Code for the quota summary with one access token */
async function fetchQuotaSummary(accessToken: string): Promise<{ ok: boolean; status: number; body: string }> {
  let last = { ok: false, status: 0, body: '' }
  for (const host of QUOTA_HOSTS) {
    try {
      const res = await fetch(`${host}${QUOTA_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await res.text()
      if (res.ok && body.length > 2) return { ok: true, status: res.status, body }
      last = { ok: false, status: res.status, body }
    } catch {
      // host unreachable: try the next one
    }
  }
  return last
}

/**
 * Route 1. Uses the stored token when it is still valid, refreshes it when it is
 * not, and reports `auth-required` when Google rejects the refresh token.
 */
async function fetchViaCloudCode(): Promise<{ available: boolean; body?: string; reason?: string }> {
  const creds = await readStoredCredentials()
  if (!creds) return { available: false, reason: 'no-credentials' }

  const stale = creds.expiresAt === 0 || Date.now() + 60_000 >= creds.expiresAt
  let access = creds.accessToken
  if (stale) {
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (refreshed) access = refreshed
    else if (creds.expiresAt !== 0 && Date.now() < creds.expiresAt) {
      // Refresh failed but the stored token has not actually expired yet
    } else {
      return { available: false, reason: 'refresh-failed' }
    }
  }

  const first = await fetchQuotaSummary(access)
  if (first.ok) return { available: true, body: first.body }
  // A stale stored token that was not stale by its own clock: refresh once more
  if (first.status === 401 || first.status === 403) {
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (refreshed) {
      const second = await fetchQuotaSummary(refreshed)
      if (second.ok) return { available: true, body: second.body }
    }
    return { available: false, reason: `http-${first.status}` }
  }
  return { available: false, reason: first.status ? `http-${first.status}` : 'no-response' }
}

/** `--flag value` from a command line */
function flagValue(commandLine: string, flag: string): string {
  const match = commandLine.match(new RegExp(`${flag}\\s+(\\S+)`))
  return match?.[1] ?? ''
}

/**
 * Running language servers and the ports they listen on.
 *
 * The command line is the only place the CSRF token appears, and the port is
 * only discoverable from the OS (the process picks a free one at start), so both
 * come from one query rather than a fixed endpoint.
 */
function findCandidates(): Candidate[] {
  let processes: Array<{ ProcessId: number; Name?: string; CommandLine?: string | null }> = []
  try {
    const raw = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'language_server' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    )
    const parsed: unknown = JSON.parse(raw)
    processes = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean) as typeof processes
  } catch {
    return [] // no PowerShell / no process: the card shows its empty state
  }
  if (processes.length === 0) return []

  const pids = new Set(processes.map((p) => String(p.ProcessId)))
  const portsByPid = new Map<string, number[]>()
  try {
    const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    for (const line of netstat.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5 || cols[3] !== 'LISTENING') continue
      if (!pids.has(cols[4])) continue
      const port = Number(cols[1].split(':').pop())
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      const list = portsByPid.get(cols[4]) ?? []
      if (!list.includes(port) && list.length < MAX_PORT_SCAN) list.push(port)
      portsByPid.set(cols[4], list)
    }
  } catch {
    // netstat unavailable: fall back to the extension port below
  }

  const candidates: Candidate[] = []
  for (const proc of processes) {
    const cmd = proc.CommandLine ?? ''
    const csrf = flagValue(cmd, '--csrf_token')
    if (!csrf) continue
    const ports = portsByPid.get(String(proc.ProcessId)) ?? []
    // The extension port is the IDE's own bridge, not the quota service, but it
    // is known to exist — worth one attempt when netstat came back empty.
    const extensionPort = Number(flagValue(cmd, '--extension_server_port'))
    if (Number.isInteger(extensionPort) && extensionPort > 0 && !ports.includes(extensionPort)) {
      ports.push(extensionPort)
    }
    if (ports.length > 0) candidates.push({ csrf, ports })
  }
  return candidates
}

/**
 * One loopback RPC over HTTPS.
 *
 * `rejectUnauthorized: false` is scoped to this single request via
 * `node:https` rather than disabled globally: the language server mints its own
 * self-signed certificate, and the target is loopback traffic to a process we
 * just identified, so certificate identity adds nothing here.
 */
function callMethod(port: number, method: string, csrf: string): Promise<{ status: number; body: string }> {
  const payload = '{}'
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: csrf,
          'Connect-Protocol-Version': '1',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    request.end(payload)
  })
}

/** Route 2: ask a running IDE's language server (needs the IDE open) */
async function fetchViaLanguageServer(): Promise<{ available: boolean; body?: string; reason?: string }> {
  const candidates = findCandidates()
  if (candidates.length === 0) return { available: false, reason: 'no-server' }

  let lastStatus = 0
  for (const candidate of candidates) {
    for (const port of candidate.ports) {
      for (const method of METHODS) {
        try {
          const res = await callMethod(port, method, candidate.csrf)
          lastStatus = res.status
          if (res.status === 200 && res.body.length > 2) return { available: true, body: res.body }
          // 403 = wrong/rotated token, 404 = port belongs to another service
          if (res.status === 403) return { available: false, reason: 'http-403' }
        } catch {
          // wrong port, TLS refused, timeout: try the next combination
        }
      }
    }
  }
  return { available: false, reason: lastStatus ? `http-${lastStatus}` : 'no-response' }
}

/**
 * Antigravity quota as the IDE panel shows it.
 *
 * Cloud Code first — it needs no IDE, so the card keeps working with Antigravity
 * closed. The loopback route is the fallback for the cases Cloud Code cannot
 * serve: a store the IDE has not written yet, or a rejected refresh token that
 * the running IDE happens to hold a fresher copy of.
 *
 * The returned body is the raw quota JSON the renderer's summarizer parses;
 * both routes answer with the same shape.
 */
export async function fetchAntigravityUsage(): Promise<{ available: boolean; body?: string; reason?: string }> {
  const remote = await fetchViaCloudCode()
  if (remote.available) return remote

  const local = await fetchViaLanguageServer()
  if (local.available) return local

  // Neither worked: report the remote reason unless the IDE is what is missing
  // (that is the actionable one for a card whose text asks the user to act).
  return { available: false, reason: local.reason === 'no-server' ? remote.reason ?? 'unavailable' : local.reason }
}
