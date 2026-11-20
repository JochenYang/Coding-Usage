import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QuotaOutcome } from './subscription-quotas'

/**
 * Cline Pass subscription quota.
 *
 * The user already signed in with `cline auth` (or stored a coding key in
 * Cline's own settings). This probe reads that file and asks Cline's plan
 * endpoint. It never starts a login, never refreshes a token, and never
 * returns the credential — only the window numbers cross IPC.
 *
 * Path order matches Cline's own overrides: an explicit settings file, then
 * `CLINE_DATA_DIR`, then `CLINE_DIR`, then `~/.cline/data/settings/providers.json`.
 * Inside the file, OAuth `auth.accessToken` wins over a retained API key, the
 * same order Cline's resolver uses. Refresh tokens and other providers are ignored.
 */

const USAGE_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits'

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const WINDOW_IDS = {
  five_hour: 'clineFiveHour',
  weekly: 'clineWeekly',
  monthly: 'clineMonthly',
} as const

export interface ClineWindow {
  id: (typeof WINDOW_IDS)[keyof typeof WINDOW_IDS]
  percent: number
  resetsAt: number | null
}

export function clineProvidersPath(home: string, env: NodeJS.ProcessEnv): string {
  const expand = (value: string): string => {
    if (value === '~') return home
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
    return value
  }
  const cleaned = (key: string): string | null => {
    const value = env[key]?.trim()
    return value ? expand(value) : null
  }
  const explicit = cleaned('CLINE_PROVIDER_SETTINGS_PATH')
  if (explicit) return explicit
  const dataDir = cleaned('CLINE_DATA_DIR')
  if (dataDir) return join(dataDir, 'settings', 'providers.json')
  const clineDir = cleaned('CLINE_DIR')
  const root = clineDir ? join(clineDir, 'data') : join(home, '.cline', 'data')
  return join(root, 'settings', 'providers.json')
}

function cleanedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Bearer token from Cline's settings file. OAuth tokens are sent with the
 * `workos:` prefix Cline itself uses; a stored API key is sent unchanged.
 * Returns null when the file has no usable Cline credential.
 */
export function credentialFromProviders(raw: string): string | null {
  let root: unknown
  try {
    root = JSON.parse(raw)
  } catch {
    return null
  }
  if (!root || typeof root !== 'object') return null
  const providers = (root as { providers?: unknown }).providers
  if (!providers || typeof providers !== 'object') return null
  const cline = (providers as { cline?: unknown }).cline
  if (!cline || typeof cline !== 'object') return null
  const settings = (cline as { settings?: unknown }).settings
  if (!settings || typeof settings !== 'object') return null
  const auth = (settings as { auth?: unknown }).auth
  const access = auth && typeof auth === 'object' ? cleanedString((auth as { accessToken?: unknown }).accessToken) : null
  if (access) {
    if (/[\r\n]/.test(access)) return null
    return access.startsWith('workos:') ? access : `workos:${access}`
  }
  const key =
    cleanedString((settings as { apiKey?: unknown }).apiKey) ??
    (auth && typeof auth === 'object' ? cleanedString((auth as { apiKey?: unknown }).apiKey) : null)
  if (!key || /[\r\n]/.test(key)) return null
  return key
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Map the plan payload to window numbers. A bad known window is omitted, never shown as 0%. */
export function windowsFromUsageLimits(payload: unknown): ClineWindow[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const body = payload as { success?: unknown; data?: unknown }
  if (body.success !== true) return null
  const data = body.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const limits = (data as { limits?: unknown }).limits
  if (!Array.isArray(limits)) return null
  const windows: ClineWindow[] = []
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const type = (raw as { type?: unknown }).type
    if (typeof type !== 'string' || !(type in WINDOW_IDS)) continue
    const percent = finiteNumber((raw as { percentUsed?: unknown }).percentUsed)
    if (percent == null) continue
    const resetsRaw = (raw as { resetsAt?: unknown }).resetsAt
    let resetsAt: number | null = null
    if (typeof resetsRaw === 'string' && resetsRaw.trim() !== '') {
      const parsed = Date.parse(resetsRaw)
      if (!Number.isFinite(parsed)) continue
      resetsAt = parsed
    } else if (resetsRaw != null) {
      continue
    }
    windows.push({
      id: WINDOW_IDS[type as keyof typeof WINDOW_IDS],
      percent: Math.max(0, Math.min(100, percent)),
      resetsAt,
    })
  }
  return windows
}

export async function fetchClineQuota(
  fetchImpl: FetchImpl,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<QuotaOutcome> {
  let raw: string
  try {
    raw = await readFile(clineProvidersPath(home, env), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { available: false, reason: code === 'ENOENT' ? 'no-auth' : 'probe-failed' }
  }
  const token = credentialFromProviders(raw)
  if (!token) return { available: false, reason: 'no-auth' }
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) return { available: false, reason: 'reauth' }
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    const windows = windowsFromUsageLimits(JSON.parse(await res.text()))
    if (!windows || windows.length === 0) return { available: false, reason: 'parse-failed' }
    return { available: true, body: JSON.stringify({ plan: null, windows, topUpCredits: null, stale: false }) }
  } catch (error) {
    return { available: false, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network' }
  }
}
