import { execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Antigravity subscription quota probe (main process).
 *
 * Two routes reach the same numbers, tried in this order:
 *
 * 1. **Cloud Code (preferred, needs no IDE).** Antigravity keeps its OAuth
 *    credentials in its own SQLite store; the stored access token (refreshed
 *    through Google's token endpoint when stale) authenticates the Cloud Code
 *    API directly. Two parts of the protocol decide whether the answer is
 *    complete:
 *
 *    - The **User-Agent** names the Antigravity build,
 *      `antigravity/hub/<version> <os>/<arch>`, with the version read from the
 *      official updater manifest. cloudcode-pa answers `403 "You do not have a
 *      valid license of this product"` without it, and — less obviously — a
 *      1.x build string gets a *reduced* quota summary: only the third-party
 *      pool comes back and the Gemini pool is silently left out, which reads
 *      like an account without Gemini quota. Verified against the live service.
 *    - The **project** from `loadCodeAssist` (`cloudaicompanionProject`), which
 *      the IDE names on every quota request.
 *
 *    `retrieveUserQuotaSummary` is the panel's source: groups (Gemini / Claude
 *    and GPT) each with a weekly and a 5-hour bucket. Some accounts answer it
 *    with no group at all; `fetchAvailableModels` then carries the same
 *    allowance per model (`quotaInfo.remainingFraction`, where an omitted
 *    fraction means none is left), so the pools are rebuilt from the models
 *    that still report one.
 *
 * 2. **The IDE's own language server (legacy fallback, IDE must be running).**
 *    Older IDE builds run a Connect/JSON service behind a self-signed loopback
 *    port whose CSRF token sits in the process command line. Current builds
 *    ship no such process, so this route is kept for installs that still have
 *    one and costs one probe when they do not.
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
 * persists on disk and names the language server executable, and the app
 * resources above it carry the IDE's own bundle, whose `cloudCode/common/oauthClient.js`
 * module declares each client id directly followed by that id's secret. The
 * pairs are therefore read *positionally* — a build ships more than one client,
 * and the first id does not necessarily own the first secret. Current builds
 * ship no launcher at all (appx-style installs), so the same bundle is also
 * read straight from the standard install roots, `_` layout included. Nothing
 * is written and nothing leaves the machine; the values live in memory for
 * this probe.
 *
 * A wrong pair cannot corrupt anything: the refresh simply fails with
 * `invalid_client` and the probe moves to the next candidate, falling through to
 * the loopback route (or reporting `refresh-failed`) when none is accepted, so
 * the lookup is verified by its own success rather than by trusting the parse.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Flavours that keep a launcher naming the language server executable */
const LAUNCHER_DIRS = ['antigravity-ide', 'antigravity', 'antigravity-cli'] as const

/** Bounded read: the bundle is ~15 MB and the language server ~135 MB */
const BUNDLE_SCAN_BYTES = 40 * 1024 * 1024
const BINARY_SCAN_BYTES = 140 * 1024 * 1024

/** How far a secret may sit from the id it belongs to (measured: ~80 chars) */
const MAX_PAIR_GAP = 400

interface OAuthClient {
  id: string
  secret: string
}

interface RefreshResult {
  token: string | null
  /** Every candidate failed with at least one `invalid_grant` and none was
   * left unanswered by the network: the refresh token itself is dead. */
  rejected: boolean
}

let cachedClient: OAuthClient | undefined

const ID_PATTERN = /[0-9]{6,}-[a-z0-9]{6,}\.apps\.googleusercontent\.com/g
const SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{10,}/g

/**
 * Client ids paired with the secret that follows each one in the same text.
 *
 * Minified declarations read `<id>="…",<secret>="GOCSPX-…"`, so the literal that
 * comes next after an id is that id's secret; a second id before any secret ends
 * the search for the first. Positional pairing is the whole point of the
 * function — mixing up the two clients makes Google answer `invalid_client`,
 * which the card would then report as an expired login.
 */
function declaredPairs(text: string): OAuthClient[] {
  const marks: Array<{ kind: 'id' | 'secret'; value: string; at: number }> = []
  for (const m of text.matchAll(ID_PATTERN)) marks.push({ kind: 'id', value: m[0], at: m.index ?? 0 })
  for (const m of text.matchAll(SECRET_PATTERN)) marks.push({ kind: 'secret', value: m[0], at: m.index ?? 0 })
  marks.sort((a, b) => a.at - b.at)

  const pairs: OAuthClient[] = []
  const paired = new Set<string>()
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].kind !== 'id' || paired.has(marks[i].value)) continue
    for (let j = i + 1; j < marks.length; j++) {
      if (marks[j].kind === 'id') break
      if (marks[j].at - marks[i].at > MAX_PAIR_GAP) break
      paired.add(marks[i].value)
      pairs.push({ id: marks[i].value, secret: marks[j].value })
      break
    }
  }
  return pairs
}

/**
 * Read the launcher that names the language server executable.
 *
 * It persists on disk with the IDE closed, which is what lets the client be
 * found without the IDE running.
 */
async function readLauncher(flavour: string): Promise<{ exe: string | null; text: string } | null> {
  const launcher = join(homedir(), '.gemini', flavour, 'bin', 'agentapi.bat')
  try {
    const text = await readFile(launcher, 'utf8')
    return { exe: text.match(/"([^"]+\.exe)"/)?.[1] ?? null, text }
  } catch {
    return null // flavour not installed
  }
}

/** First `limit` bytes of a file, as latin1 (byte-preserving) text */
async function readTextBytes(path: string, limit: number): Promise<string | null> {
  try {
    const { open } = await import('node:fs/promises')
    const handle = await open(path, 'r')
    try {
      const size = (await handle.stat()).size
      const length = Math.min(size, limit)
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, 0)
      return buf.toString('latin1')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * The IDE's Electron bundle, found by walking up from the language server.
 *
 * The executable sits at `…/resources/app/extensions/<ext>/bin/`, so the app
 * resources are a few levels above it — but how many depends on the install, and
 * the walk is bounded rather than assumed.
 */
async function readIdeBundle(exe: string): Promise<string | null> {
  let dir = dirname(exe)
  for (let up = 0; up < 8; up++) {
    const found = await readTextBytes(join(dir, 'resources', 'app', 'out', 'main.js'), BUNDLE_SCAN_BYTES)
    if (found) return found
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Install roots for builds that ship no launcher.
 *
 * The appx-style layout keeps the Electron app under `_` inside the install
 * root; legacy layouts keep `resources` at the root itself. Per-user installs
 * default to `%LOCALAPPDATA%\Programs`, machine-wide ones to `%PROGRAMFILES%`;
 * both product directory names the credential store probe knows are tried.
 */
function installRoots(): string[] {
  const bases: string[] = []
  if (process.env.LOCALAPPDATA) bases.push(join(process.env.LOCALAPPDATA, 'Programs'))
  if (process.env.PROGRAMFILES) bases.push(process.env.PROGRAMFILES)
  const roots: string[] = []
  for (const base of bases) {
    for (const name of ['Antigravity IDE', 'Antigravity']) roots.push(join(base, name))
  }
  return roots
}

/**
 * Every OAuth client worth trying, best candidate first.
 *
 * The IDE bundle is the authoritative source and is read first: it declares the
 * real pairs, and trying them costs two small file reads. Launcher-less
 * installs are reached through the install roots next. Only when none is
 * accepted does the search fall back to the language server's string table,
 * where ids and a stray secret are mixed into unrelated API strings — a 135 MB
 * read, so it is kept last and the pairs are tried as a cross-product because
 * nothing there states which secret belongs to which id.
 */
export async function* clientCandidates(): AsyncGenerator<OAuthClient> {
  const tried = new Set<string>()
  const fresh = (list: OAuthClient[]): OAuthClient[] =>
    list.filter((client) => {
      const key = `${client.id}\u0000${client.secret}`
      if (tried.has(key)) return false
      tried.add(key)
      return true
    })

  const exePaths: string[] = []
  for (const flavour of LAUNCHER_DIRS) {
    const launcher = await readLauncher(flavour)
    if (!launcher) continue
    if (launcher.exe) exePaths.push(launcher.exe)

    const sources = [launcher.text]
    if (launcher.exe) {
      const bundle = await readIdeBundle(launcher.exe)
      if (bundle) sources.push(bundle)
    }
    for (const text of sources) {
      for (const client of fresh(declaredPairs(text))) yield client
    }
  }

  // Launcher-less installs: read the bundle straight from the install roots,
  // appx `_` layout first (current builds), legacy layout second. Misses are
  // cheap failed opens; `fresh` dedupes against launcher-derived pairs.
  for (const root of installRoots()) {
    for (const layout of ['_', '']) {
      const bundle = await readTextBytes(join(root, layout, 'resources', 'app', 'out', 'main.js'), BUNDLE_SCAN_BYTES)
      if (bundle) for (const client of fresh(declaredPairs(bundle))) yield client
    }
  }

  const ids: string[] = []
  const secrets: string[] = []
  for (const exe of exePaths) {
    const binary = await readTextBytes(exe, BINARY_SCAN_BYTES)
    if (!binary) continue
    for (const match of binary.matchAll(ID_PATTERN)) if (!ids.includes(match[0])) ids.push(match[0])
    for (const match of binary.matchAll(SECRET_PATTERN)) if (!secrets.includes(match[0])) secrets.push(match[0])
  }
  for (const id of ids) {
    for (const secret of secrets) {
      for (const client of fresh([{ id, secret }])) yield client
    }
  }
}

/**
 * One refresh attempt.
 *
 * The response is read even on failure: Google distinguishes a wrong client
 * (`invalid_client`) from a dead token (`invalid_grant`), and the caller needs
 * the difference to decide whether to try another pair or give up.
 */
async function fetchToken(
  client: OAuthClient,
  refreshToken: string,
): Promise<{ ok: boolean; accessToken: string | null; status: number; error: string | null }> {
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
    const text = await res.text()
    let error: string | null = null
    let token: string | null = null
    try {
      const json = JSON.parse(text) as { access_token?: unknown; error?: unknown }
      if (typeof json.access_token === 'string' && json.access_token) token = json.access_token
      if (typeof json.error === 'string') error = json.error
    } catch {
      error = 'unparseable'
    }
    return { ok: token !== null, accessToken: token, status: res.status, error }
  } catch (e) {
    return { ok: false, accessToken: null, status: 0, error: e instanceof Error ? e.name : 'network' }
  }
}

/**
 * Resolve the OAuth client for one refresh token and refresh with it.
 *
 * Verification happens against the token at hand, which is the only thing that
 * can tell the right pair from the wrong one — a parse that merely looks
 * plausible is not evidence. The pair that works is remembered, and re-resolved
 * from disk if a later refresh is rejected (the IDE may have been updated since).
 * `rejected` separates a dead login (every candidate failed and Google
 * answered `invalid_grant`, re-sign-in is the fix) from a probe that could not
 * refresh (no client found, wrong clients or network): the card must not advise
 * re-login for the latter.
 * Exported for regression tests.
 */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  if (!refreshToken) return { token: null, rejected: false }

  const cached = cachedClient
  if (cached) {
    const res = await fetchToken(cached, refreshToken)
    if (res.ok) return { token: res.accessToken, rejected: false }
    cachedClient = undefined // stale guess: re-resolve below
  }

  let rejected = false
  let unanswered = false
  for await (const client of clientCandidates()) {
    const res = await fetchToken(client, refreshToken)
    if (res.ok) {
      cachedClient = client
      return { token: res.accessToken, rejected: false }
    }
    // invalid_grant is ambiguous: a dead token, or a token issued to another
    // candidate client (RFC 6749 §5.2). Keep trying; only a unanimous failure
    // with at least one invalid_grant counts as a rejected login.
    if (res.error === 'invalid_grant') rejected = true
    // A candidate that never answered (network) cannot vouch for the token's
    // death; stay conservative and report refresh-unavailable instead.
    if (res.status === 0) unanswered = true
  }
  return { token: null, rejected: rejected && !unanswered }
}

/** Cloud Code hosts, daily first: that is the channel the IDE itself uses */
const API_HOSTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']
const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'
const MODELS_PATH = '/v1internal:fetchAvailableModels'
const LOAD_ASSIST_PATH = '/v1internal:loadCodeAssist'

/**
 * Where the current Antigravity build's version is published.
 *
 * The User-Agent has to name a current build: a 1.x version gets a quota summary
 * with the Gemini pool omitted (verified against the live service), so the
 * version is read from the same manifest the updater uses instead of being
 * frozen into this file. The constant below is the offline fallback.
 */
const VERSION_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml'
const FALLBACK_VERSION = '2.28.2'
const VERSION_TTL_MS = 6 * 60 * 60_000

const UA_PLATFORM: Record<string, string> = { win32: 'win32', darwin: 'darwin', linux: 'linux' }
const UA_ARCH: Record<string, string> = { x64: 'x64', arm64: 'arm64' }

let cachedVersion: { value: string; at: number } | null = null

/** Current Antigravity version, cached; the updater manifest is the source */
async function antigravityVersion(): Promise<string> {
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_TTL_MS) return cachedVersion.value
  try {
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(5_000) })
    const text = await res.text()
    const match = text.match(/^version:\s*([0-9.]+)\s*$/m)
    if (match) {
      cachedVersion = { value: match[1], at: Date.now() }
      return match[1]
    }
  } catch {
    // offline or the updater is gone: fall back without caching, so the next
    // probe tries again rather than pinning a guess for six hours
  }
  return FALLBACK_VERSION
}

/**
 * Identifies the caller as an Antigravity build.
 *
 * Both parts matter: without the header cloudcode-pa answers `403 licence`,
 * and with a stale version it returns a quota summary that silently omits the
 * Gemini pool — the exact failure this probe used to show.
 */
export function antigravityUserAgent(version: string): string {
  const platform = UA_PLATFORM[process.platform] ?? process.platform
  const arch = UA_ARCH[process.arch] ?? process.arch
  return `antigravity/hub/${version} ${platform}/${arch}`
}

async function userAgent(): Promise<string> {
  return antigravityUserAgent(await antigravityVersion())
}

interface ProjectInfo {
  project: string
}

// Keyed by refresh token: switching accounts in the IDE swaps the token, and a
// project cached for the previous account would 403 every quota request.
let cachedProject: { key: string; value: ProjectInfo; at: number } | null = null
const PROJECT_TTL_MS = 60 * 60_000

/** `cloudaicompanionProject` arrives as an id or as `{ id, name }` */
function projectId(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw != null && typeof raw === 'object') {
    const id = (raw as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return ''
}

/** Header the language server requires on every loopback request */
const CSRF_HEADER = 'X-Codeium-Csrf-Token'

/** Connect RPC methods to try on the loopback route, best source first */
const METHODS = ['RetrieveUserQuotaSummary', 'GetUserStatus'] as const

/** Bounds every attempt: these probes are garnish, not critical path */
const REQUEST_TIMEOUT_MS = 6_000

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

interface LoadAssistReply {
  cloudaicompanionProject?: unknown
}

/**
 * The Code Assist project the account runs on.
 *
 * The IDE asks this once at start-up and names the project on every later
 * request. `metadata.ideType` alone is accepted; `metadata.platform` is
 * validated against the service's own enum and a wrong spelling is a 400, so it
 * is left out.
 */
async function loadCodeAssist(accessToken: string, accountKey: string): Promise<ProjectInfo | null> {
  if (cachedProject && cachedProject.key === accountKey && Date.now() - cachedProject.at < PROJECT_TTL_MS) {
    return cachedProject.value
  }
  const ua = await userAgent()
  for (const host of API_HOSTS) {
    try {
      const res = await fetch(`${host}${LOAD_ASSIST_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': ua,
        },
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) continue
      const reply = (await res.json()) as LoadAssistReply
      const project = projectId(reply.cloudaicompanionProject)
      if (!project) return null
      const value: ProjectInfo = { project }
      cachedProject = { key: accountKey, value, at: Date.now() }
      return value
    } catch {
      // host unreachable: try the next one
    }
  }
  return null
}

/** Whether a quota summary carries a usable pool; empty groups/buckets are a miss */
export function hasQuotaGroups(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { groups?: unknown }
    if (!Array.isArray(parsed.groups)) return false
    return parsed.groups.some((group) => {
      if (group == null || typeof group !== 'object') return false
      const buckets = (group as { buckets?: unknown }).buckets
      return Array.isArray(buckets) && buckets.length > 0
    })
  } catch {
    return false
  }
}

/** Ask Cloud Code for the quota summary with one access token */
async function fetchQuotaSummary(
  accessToken: string,
  project: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  // A 200 that carries no usable pool still matters: it means the endpoint
  // answered, so the caller should try the per-model route rather than treat a
  // later host's 500 as the result.
  let empty: { ok: boolean; status: number; body: string } | null = null
  let last = { ok: false, status: 0, body: '' }
  const ua = await userAgent()
  const payload = JSON.stringify(project ? { project } : {})
  for (const host of API_HOSTS) {
    try {
      const res = await fetch(`${host}${QUOTA_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': ua,
        },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await res.text()
      if (res.ok && hasQuotaGroups(body)) return { ok: true, status: res.status, body }
      if (res.ok) empty ??= { ok: false, status: res.status, body }
      else last = { ok: false, status: res.status, body }
    } catch {
      // host unreachable: try the next one
    }
  }
  return empty ?? last
}

export interface ModelQuota {
  /** 0..1 remaining; the service omits the field once none is left */
  remaining: number
  resetsAt: string
}

interface ModelsReply {
  models?: Record<
    string,
    { disabled?: boolean; quotaInfo?: { remainingFraction?: unknown; resetTime?: unknown } }
  >
}

/**
 * Per-model allowance, keyed by model id.
 *
 * `fetchAvailableModels` is the second half of the protocol: each model carries
 * its own `quotaInfo` (the 5-hour window; weekly pools only exist in the
 * summary). A model the account is not served is `disabled` and is skipped; a
 * missing `remainingFraction` means the allowance is used up, not unknown.
 */
async function fetchModelQuotas(
  accessToken: string,
  project: string,
): Promise<Map<string, ModelQuota> | null> {
  const ua = await userAgent()
  for (const host of API_HOSTS) {
    try {
      const res = await fetch(`${host}${MODELS_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': ua,
        },
        body: JSON.stringify({ project }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) continue
      const reply = (await res.json()) as ModelsReply
      if (!reply.models) continue
      const out = new Map<string, ModelQuota>()
      for (const [id, model] of Object.entries(reply.models)) {
        if (model.disabled === true || !model.quotaInfo) continue
        const fraction = model.quotaInfo.remainingFraction
        out.set(id, {
          remaining: typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : 0,
          resetsAt: typeof model.quotaInfo.resetTime === 'string' ? model.quotaInfo.resetTime : '',
        })
      }
      if (out.size > 0) return out
    } catch {
      // host unreachable: try the next one
    }
  }
  return null
}

/**
 * Rebuild the summary's pools from per-model quotas.
 *
 * Only the 5-hour allowance exists per model; the weekly figure has no
 * per-model equivalent, so the synthesized body carries the 5-hour bucket
 * alone. A family's share is the tightest of its models, which is what the
 * shared pool would report.
 */
export function quotaGroupsFromModels(models: Map<string, ModelQuota>): unknown {
  const families = new Map<string, { remaining: number; resetsAt: string }>()
  for (const [id, quota] of models) {
    const family =
      id.startsWith('claude') || id.startsWith('gpt') ? 'thirdParty' : id.includes('gemini') ? 'gemini' : null
    if (!family) continue
    const current = families.get(family)
    if (!current) {
      families.set(family, { remaining: quota.remaining, resetsAt: quota.resetsAt })
      continue
    }
    current.remaining = Math.min(current.remaining, quota.remaining)
    if (quota.resetsAt && (!current.resetsAt || quota.resetsAt < current.resetsAt)) current.resetsAt = quota.resetsAt
  }
  const groups = [...families.entries()].map(([family, quota]) => ({
    displayName: family === 'gemini' ? 'Gemini Models' : 'Claude and GPT models',
    buckets: [
      {
        bucketId: family === 'gemini' ? 'gemini-5h' : '3p-5h',
        displayName: 'Five Hour Limit Remaining',
        window: '5h',
        ...(quota.resetsAt ? { resetTime: quota.resetsAt } : {}),
        remainingFraction: quota.remaining,
      },
    ],
  }))
  return { groups, description: '' }
}

/**
 * Route 1. Uses the stored token when it is still valid, refreshes it when it
 * is not, and reports `refresh-failed` when Google rejects the refresh token
 * itself (`invalid_grant`) or `refresh-unavailable` when the probe could not
 * refresh (no client found / network) — the two need different advice.
 * Exported for regression tests.
 */
export async function fetchViaCloudCode(): Promise<{ available: boolean; body?: string; reason?: string }> {
  const creds = await readStoredCredentials()
  if (!creds) return { available: false, reason: 'no-credentials' }

  const stale = creds.expiresAt === 0 || Date.now() + 60_000 >= creds.expiresAt
  let access = creds.accessToken
  if (stale) {
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (refreshed.token) access = refreshed.token
    else if (creds.expiresAt !== 0 && Date.now() < creds.expiresAt) {
      // Refresh failed but the stored token has not actually expired yet
    } else {
      return { available: false, reason: refreshed.rejected ? 'refresh-failed' : 'refresh-unavailable' }
    }
  }

  const info = await loadCodeAssist(access, creds.refreshToken)
  const project = info?.project ?? ''

  const first = await fetchQuotaSummary(access, project)
  if (first.ok) return { available: true, body: first.body }

  // A stale stored token that was not stale by its own clock: refresh once more
  if (first.status === 401 || first.status === 403) {
    // A different account may be signed in behind the refreshed token
    cachedProject = null
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (!refreshed.token) {
      return { available: false, reason: refreshed.rejected ? 'refresh-failed' : 'refresh-unavailable' }
    }
    const retryInfo = await loadCodeAssist(refreshed.token, creds.refreshToken)
    const retryProject = retryInfo?.project ?? project
    const retry = await fetchQuotaSummary(refreshed.token, retryProject)
    if (retry.ok) return { available: true, body: retry.body }
    const retryModels = await fetchModelQuotas(refreshed.token, retryProject)
    if (retryModels) return { available: true, body: JSON.stringify(quotaGroupsFromModels(retryModels)) }
    return { available: false, reason: `http-${first.status}` }
  }

  // The summary answered without a pool: the per-model allowance still has one.
  // Only when it answered at all — a network failure would just be repeated by
  // the second endpoint.
  if (first.status === 200) {
    const models = await fetchModelQuotas(access, project)
    if (models) return { available: true, body: JSON.stringify(quotaGroupsFromModels(models)) }
    return { available: false, reason: 'no-groups' }
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
