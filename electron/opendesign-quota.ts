import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { QuotaOutcome } from './subscription-quotas'
import { isTimeoutError } from './fetch-errors'

/**
 * OpenDesign (open-design.ai) Go subscription quota via the Cloud account API.
 * Contract verified against third-party implementations (dsh-cost-meter
 * lib/opendesign.js + lib/opendesign-login.js, CodexBar PR #4859): the
 * inference API key (sk-amr-…) belongs to model calls and cannot read quota —
 * the account side speaks either a Cloud console Cookie or the
 * `vela_ctrl_…` control key obtained through the official device-code flow
 * (the same one `vela login` runs).
 *
 * Primary route: device authorization — the card asks the main process to
 * start a session, the user approves `https://open-design.ai/cloud/cli/activate`
 * in their browser, and polling returns only the control key, which is stored
 * encrypted here and never crosses IPC. Manual fallback: a pasted Cookie.
 *
 * Fields resolve by name; counters arrive as digit strings (proto JSON) and
 * must satisfy remaining + used ≤ limit with the exact remainder — anything
 * else is a drifted payload and fails closed. No credential or account
 * identifier ever crosses the IPC boundary.
 */

const API_BASE = 'https://amr-api.open-design.ai/api/v1'
const DEVICE_URL = `${API_BASE}/cli/device-authorizations`
const CURRENT_WORKSPACE_URL = `${API_BASE}/workspaces/current`
/** The activation page is always assembled locally from validated fields. */
const ACTIVATE_URL_PREFIX = 'https://open-design.ai/cloud/cli/activate?deviceId='
const PROBE_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 20_000
/** Control keys this long are not control keys. */
const MAX_CREDENTIAL_CHARS = 16_384
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

// ===== Credential slot (single entry, encrypted, main process only) =====

export type OpendesignCredential =
  | { kind: 'control-key'; authorization: string }
  | { kind: 'cookie'; header: string }

let storeDir: string | null = null
let cachedCredential: OpendesignCredential | null | undefined

export function initOpendesignStore(userDataDir: string): void {
  storeDir = userDataDir
  cachedCredential = undefined
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Accept either credential form: a `vela_ctrl_…` control key from the device
 * flow, or a full Cookie request header pasted from the browser's Network
 * panel (with or without a `cookie:` prefix). Control-character, newline and
 * oversized values are rejected here so nothing hostile is ever decrypted
 * back out of the store; an inference key is refused by name — it cannot read
 * quota and storing it would only produce confusing 401s.
 */
export function normalizeOpendesignCredential(value: unknown): OpendesignCredential | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw || raw.length > MAX_CREDENTIAL_CHARS || /[\r\n\x00-\x1f\x7f]/.test(raw)) return null
  // A control key is a bare token; anything with `=` / `;` pair structure (or
  // an explicit cookie: prefix) is a Cookie header — route on shape, not on
  // the name, so a cookie pair named like a control key stays a cookie.
  const withoutBearer = raw.replace(/^Bearer\s+/i, '')
  const looksCookie = /^cookie:/i.test(raw) || withoutBearer.includes('=') || withoutBearer.includes(';')
  if (!looksCookie && /^vela_ctrl_[A-Za-z0-9._-]{10,4080}$/.test(withoutBearer)) {
    return { kind: 'control-key', authorization: `Bearer ${withoutBearer}` }
  }
  if (/^sk-amr/i.test(withoutBearer)) return null
  const cookie = raw.replace(/^cookie:\s*/i, '')
  const parts = cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  if (parts.some((part) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21-\x3a\x3c-\x7e]*$/.test(part))) return null
  return { kind: 'cookie', header: parts.join('; ') }
}

/** Decrypt the stored credential; absent, unreadable or undecryptable means none. */
export async function readOpendesignCredential(): Promise<OpendesignCredential | null> {
  if (cachedCredential !== undefined) return cachedCredential
  if (!storeDir || !canEncrypt()) {
    cachedCredential = null
    return null
  }
  try {
    const raw = JSON.parse(await readFile(join(storeDir, 'opendesign-cookie.json'), 'utf8')) as {
      version?: unknown
      credential?: unknown
    }
    // An unknown version is not this build's file: refusing it beats silently
    // misreading a future format.
    if (raw.version !== 2) {
      cachedCredential = null
      return null
    }
    if (typeof raw.credential !== 'string' || raw.credential === '') {
      cachedCredential = null
      return null
    }
    // The blob is the JSON of the stored credential (see save) — parse it back
    // and re-validate the inner value, so a tampered or stale ciphertext can
    // never turn into an arbitrary request header.
    const plain = safeStorage.decryptString(Buffer.from(raw.credential, 'base64'))
    const stored = JSON.parse(plain) as { kind?: unknown; authorization?: unknown; header?: unknown }
    if (stored.kind === 'control-key' && typeof stored.authorization === 'string') {
      const re = normalizeOpendesignCredential(stored.authorization)
      cachedCredential = re && re.kind === 'control-key' ? re : null
    } else if (stored.kind === 'cookie' && typeof stored.header === 'string') {
      const re = normalizeOpendesignCredential(stored.header)
      cachedCredential = re && re.kind === 'cookie' ? re : null
    } else {
      cachedCredential = null
    }
  } catch {
    cachedCredential = null
  }
  return cachedCredential
}

export async function saveOpendesignCredential(
  value: unknown,
): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'no-keystore' | 'write-failed' }> {
  const credential = normalizeOpendesignCredential(value)
  if (!credential) return { ok: false, reason: 'invalid' }
  if (!storeDir || !canEncrypt()) return { ok: false, reason: 'no-keystore' }
  try {
    const blob = safeStorage.encryptString(JSON.stringify(credential)).toString('base64')
    await writeFile(join(storeDir, 'opendesign-cookie.json'), JSON.stringify({ version: 2, credential: blob }), 'utf8')
    cachedCredential = credential
    return { ok: true }
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
}

export async function clearOpendesignCredential(): Promise<void> {
  cachedCredential = null
  if (!storeDir || !canEncrypt()) return
  try {
    await writeFile(join(storeDir, 'opendesign-cookie.json'), JSON.stringify({ version: 2, credential: '' }), 'utf8')
  } catch {
    // A failed clear leaves the old blob; the next save overwrites it anyway.
  }
}

// ===== Device-code login (the official `vela login` flow) =====

export interface OpendesignLoginSession {
  loginId: number
  /** The 6-character approval code, shown on the card so the user can confirm */
  userCode: string
  /** Browser approval page, assembled locally from validated fields */
  url: string
  intervalMs: number
  expiresAtMs: number
}

interface DeviceSession {
  deviceId: string
  deviceSecret: string
  expiresAtMs: number
  intervalMs: number
}

/** In-memory device sessions: the secret never leaves the main process. */
const loginSessions = new Map<number, DeviceSession>()
let nextLoginId = 1

export function dropOpendesignLogin(loginId: number): void {
  loginSessions.delete(loginId)
}

/**
 * Start a device-code authorization. Nothing is opened here — the caller
 * opens the locally assembled approval URL. Fields are validated against the
 * official response shape before anything is used.
 */
export type OpendesignLoginStartResult =
  | { ok: true; session: OpendesignLoginSession }
  | { ok: false; reason: 'start-failed' | 'invalid' | 'network' }

/** The IPC-facing shape: flattened, and the approval URL stays in the main process. */
export type OpendesignLoginStartIpcResult =
  | { ok: true; loginId: number; userCode: string; intervalMs: number; expiresAtMs: number }
  | { ok: false; reason: 'start-failed' | 'invalid' | 'network' }

/** The device-code flow identifies its client version; matches the desktop vela CLI generation. */
const CLI_VERSION = '0.0.33'

export async function startOpendesignLogin(
  fetchImpl: FetchImpl,
  host: string,
): Promise<OpendesignLoginStartResult> {
  let res: Response
  try {
    res = await fetchImpl(DEVICE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliVersion: CLI_VERSION, host, profile: 'prod' }),
      redirect: 'error',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, reason: isTimeoutError(error) ? 'start-failed' : 'network' }
  }
  if (!res.ok) return { ok: false, reason: 'start-failed' }
  let data: unknown
  try {
    data = JSON.parse(await res.text())
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const record = (data ?? {}) as Record<string, unknown>
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId : ''
  const deviceSecret = typeof record.deviceSecret === 'string' ? record.deviceSecret : ''
  const userCode = typeof record.userCode === 'string' ? record.userCode : ''
  const advertised = typeof record.activationUrl === 'string' ? record.activationUrl : ''
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(deviceId) ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(deviceSecret) ||
    !/^[A-Za-z0-9]{4,16}$/.test(userCode) ||
    !advertised.startsWith('https://open-design.ai/')
  ) {
    return { ok: false, reason: 'invalid' }
  }
  const intervalSeconds = typeof record.pollIntervalSeconds === 'number' && record.pollIntervalSeconds > 0 ? record.pollIntervalSeconds * 1000 : 2000
  const expiresAtText = typeof record.expiresAt === 'string' ? record.expiresAt : ''
  const advertisedExpiry = Number.isFinite(Date.parse(expiresAtText)) ? Date.parse(expiresAtText) : Date.now() + 10 * 60_000
  const expiresAtMs = Math.min(advertisedExpiry, Date.now() + 15 * 60_000)
  // Sweep sessions that expired without ever being polled — their device
  // secrets would otherwise linger in memory until process exit.
  for (const [id, session] of loginSessions) {
    if (Date.now() >= session.expiresAtMs) loginSessions.delete(id)
  }
  const loginId = nextLoginId++
  loginSessions.set(loginId, { deviceId, deviceSecret, expiresAtMs, intervalMs: Math.min(15_000, Math.max(1_000, intervalSeconds)) })
  return {
    ok: true,
    // The approval page is assembled locally from validated fields — the
    // upstream body URL is only checked, never opened.
    session: {
      loginId,
      userCode,
      url: `${ACTIVATE_URL_PREFIX}${encodeURIComponent(deviceId)}&userCode=${encodeURIComponent(userCode)}`,
      intervalMs: loginSessions.get(loginId)!.intervalMs,
      expiresAtMs,
    },
  }
}

export type OpendesignPollResult =
  | { status: 'approved' }
  | { status: 'pending' }
  | { status: 'failed'; reason: 'expired' | 'denied' | 'cancelled' | 'invalid' }

const controlKeyOf = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : ''
  const normalized = normalizeOpendesignCredential(raw)
  return normalized?.kind === 'control-key' ? raw : null
}

/**
 * One poll round. `approved` stores the control key in the encrypted slot and
 * drops the session — the key itself never leaves this module. Transport
 * jitter and unknown statuses read as `pending`: only explicit terminal
 * states end the flow.
 */
export async function pollOpendesignLogin(
  fetchImpl: FetchImpl,
  loginId: number,
): Promise<OpendesignPollResult> {
  const device = loginSessions.get(loginId)
  if (!device) return { status: 'failed', reason: 'expired' }
  if (Date.now() >= device.expiresAtMs) {
    loginSessions.delete(loginId)
    return { status: 'failed', reason: 'expired' }
  }
  let res: Response
  try {
    res = await fetchImpl(`${DEVICE_URL}/${encodeURIComponent(device.deviceId)}/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecret: device.deviceSecret }),
      redirect: 'error',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
  } catch {
    // Transport jitter is not an authorization failure: keep polling.
    return { status: 'pending' }
  }
  if ([401, 404, 410].includes(res.status)) {
    loginSessions.delete(loginId)
    return { status: 'failed', reason: 'expired' }
  }
  // Status classification happens before the body is read: a WAF page or a
  // plain-text 403 must land in the same bucket as its JSON twin, and a 5xx
  // (with or without a JSON error body) is recoverable — keep polling.
  if (res.status === 403) {
    loginSessions.delete(loginId)
    return { status: 'failed', reason: 'denied' }
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    // A revoked or malformed grant is terminal rather than a 15-minute hang.
    loginSessions.delete(loginId)
    return { status: 'failed', reason: 'invalid' }
  }
  if (res.status === 429 || res.status >= 500) {
    // Rate-limited or server-side trouble is recoverable: keep polling.
    return { status: 'pending' }
  }
  let data: unknown = null
  try {
    data = JSON.parse(await res.text())
  } catch {
    // A 2xx whose body will not parse is drift, but one failed read should not
    // waste an approval the user just gave — keep polling.
    return { status: 'pending' }
  }
  const key = controlKeyOf((data as Record<string, unknown> | null)?.controlKey)
  if (key !== null) {
    const saved = await saveOpendesignCredential(key)
    loginSessions.delete(loginId)
    return saved.ok ? { status: 'approved' } : { status: 'failed', reason: 'invalid' }
  }
  const status = typeof (data as Record<string, unknown> | null)?.status === 'string' ? ((data as Record<string, unknown>).status as string).toLowerCase() : ''
  if (status === 'expired') {
    loginSessions.delete(loginId)
    return { status: 'failed', reason: 'expired' }
  }
  if (status === 'denied' || status === 'rejected') {
    loginSessions.delete(loginId)
    return { status: 'failed', reason: 'denied' }
  }
  if (status === 'canceled' || status === 'cancelled') {
    loginSessions.delete(loginId)
    return { status: 'failed', reason: 'cancelled' }
  }
  return { status: 'pending' }
}

// ===== Quota probe =====

interface FetchOutcome {
  status: number
  json: unknown
}

async function accountGet(
  fetchImpl: FetchImpl,
  url: string,
  credential: OpendesignCredential,
  workspaceId?: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<FetchOutcome> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (credential.kind === 'control-key') headers.Authorization = credential.authorization
  else headers.Cookie = credential.header
  if (workspaceId !== undefined) headers['x-vela-workspace-id'] = workspaceId
  const res = await fetchImpl(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json: unknown = null
  try {
    json = JSON.parse(await res.text())
  } catch {
    // Non-JSON error page (challenge, gateway) — the status carries it.
  }
  return { status: res.status, json }
}

function workspaceIdOf(value: unknown): string | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const id = typeof record?.activeWorkspaceId === 'string' ? record.activeWorkspaceId : typeof record?.workspaceId === 'string' ? record.workspaceId : undefined
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null
}

interface UsageRow {
  id: 'fiveHour' | 'weekly' | 'other'
  percent: number
  resetsAt: number | null
}

/**
 * The usage payload resolves by name and cross-checks its own arithmetic. The
 * preflight form (control-key route) wraps the identical window payload in
 * `codingPlan` with its own member identity — both levels must agree. The
 * window identity is its duration: 5h / 7d carry their own ids, anything else
 * the endpoint may grow lands as `other` rather than being dropped.
 */
export function parseOpendesignUsage(value: unknown, workspaceId: string): UsageRow[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  let payload = value as {
    workspaceId?: unknown
    workspaceMemberId?: unknown
    codingPlan?: unknown
    eligible?: unknown
    windows?: unknown
  }
  const inner = payload.codingPlan
  if (inner !== undefined) {
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null
    const plan = inner as { workspaceId?: unknown; workspaceMemberId?: unknown }
    if (payload.workspaceId !== workspaceId) return null
    if (plan.workspaceId !== undefined && plan.workspaceId !== workspaceId) return null
    payload = { ...payload, ...(inner as object), workspaceMemberId: payload.workspaceMemberId ?? plan.workspaceMemberId }
  }
  if (payload.workspaceId !== workspaceId) return null
  if (payload.workspaceMemberId != null && (typeof payload.workspaceMemberId !== 'string' || !ID_PATTERN.test(payload.workspaceMemberId))) {
    return null
  }
  if (typeof payload.eligible !== 'boolean' || !Array.isArray(payload.windows) || payload.windows.length > 32) return null
  const seen = new Set<string>()
  const rows: UsageRow[] = []
  for (const raw of payload.windows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const row = raw as {
      policyId?: unknown
      durationSeconds?: unknown
      usedCredits?: unknown
      remainingCredits?: unknown
      limitCredits?: unknown
      resetsAt?: unknown
    }
    if (typeof row.policyId !== 'string' || row.policyId === '' || seen.has(row.policyId)) return null
    seen.add(row.policyId)
    if (typeof row.durationSeconds !== 'number' || !Number.isSafeInteger(row.durationSeconds) || row.durationSeconds <= 0) {
      return null
    }
    const counters = [row.usedCredits, row.remainingCredits, row.limitCredits]
    if (!counters.every((c) => typeof c === 'string' && /^\d{1,80}$/.test(c))) return null
    // The regex above proved these are digit strings; BigInt is the only safe
    // arithmetic for allowance numbers that may exceed 2^53.
    const used = BigInt(row.usedCredits as string)
    const remaining = BigInt(row.remainingCredits as string)
    const limit = BigInt(row.limitCredits as string)
    if (limit <= 0n || remaining > limit || remaining !== (used >= limit ? 0n : limit - used)) return null
    const resetsAt = row.resetsAt == null ? null : typeof row.resetsAt === 'string' && Number.isFinite(Date.parse(row.resetsAt)) ? Date.parse(row.resetsAt) : null
    if (row.resetsAt != null && resetsAt === null) return null
    const duration = row.durationSeconds
    rows.push({
      id: duration === 5 * 60 * 60 ? 'fiveHour' : duration === 7 * 24 * 60 * 60 ? 'weekly' : 'other',
      // Three-decimal precision via the same BigInt ratio the contract uses.
      percent: Number((used > limit ? limit : used) * 100000n / limit) / 1000,
      resetsAt,
    })
  }
  if (payload.eligible && rows.length === 0) return null
  if (!payload.eligible && payload.windows.length > 0) return null
  return rows
}

export async function fetchOpendesignQuota(
  fetchImpl: FetchImpl,
  credential: OpendesignCredential | null,
): Promise<QuotaOutcome> {
  if (!credential) return { available: false, reason: 'no-auth' }
  try {
    const current = await accountGet(fetchImpl, CURRENT_WORKSPACE_URL, credential)
    if (current.status === 401 || current.status === 403) return { available: false, reason: 'reauth' }
    if (current.status >= 400) return { available: false, reason: `http-${current.status}` }
    const workspaceId = workspaceIdOf(current.json)
    if (!workspaceId) return { available: false, reason: 'parse-failed' }

    // Control-key route reads preflight (windows wrapped in codingPlan); the
    // cookie route reads coding-plan-usage directly. The wallet endpoint is
    // deliberately NOT called: nothing renders it today, and an unrendered
    // field is not worth a request on the card's critical path.
    const usageUrl = `${API_BASE}/workspaces/${workspaceId}/billing/${credential.kind === 'control-key' ? 'preflight' : 'coding-plan-usage'}`
    const usage = await accountGet(fetchImpl, usageUrl, credential, workspaceId)
    if (usage.status === 401 || usage.status === 403) return { available: false, reason: 'reauth' }
    if (usage.status >= 400) return { available: false, reason: `http-${usage.status}` }
    const rows = parseOpendesignUsage(usage.json, workspaceId)
    if (!rows) return { available: false, reason: 'parse-failed' }
    if (rows.length === 0) return { available: false, reason: 'no-plan' }
    // Fixed display order: the 5-hour window first, then 7-day, then anything
    // else by arrival — matches how the sibling cards order their windows.
    const order = { fiveHour: 0, weekly: 1, other: 2 } as const
    rows.sort((a, b) => order[a.id] - order[b.id])
    return { available: true, body: JSON.stringify({ plan: null, windows: rows, topUpCredits: null, stale: false }) }
  } catch (error) {
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}
