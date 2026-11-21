import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { QuotaOutcome } from './subscription-quotas'
import { isTimeoutError } from './fetch-errors'

/**
 * Devin (Devin CLI) subscription quota.
 *
 * The Devin CLI writes its own `credentials.toml` at a documented per-OS
 * location; only the `windsurf_api_key` value is read, in memory, and sent as
 * the `metadata.apiKey` field of a Connect-RPC JSON call to the fixed
 * Cognition host. The file is never written back and the key never crosses
 * IPC — only quota numbers are returned.
 *
 * The endpoint is undocumented; field names below follow protobuf-JSON naming
 * captured from the wire by third-party clients (OmniRoute's live proto
 * capture maps `userStatus.planStatus` to `dailyQuotaRemainingPercent`,
 * `weeklyQuotaRemainingPercent` and the Unix-second `*QuotaResetAtUnix`).
 * Protobuf JSON omits zero-valued fields, so a reset timestamp without a
 * remaining percentage reads as an exhausted window, and values may arrive as
 * strings (int64). Anything missing or contradictory degrades — never 0%.
 */

const GET_USER_STATUS_URL =
  'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'
/** Unix seconds for a plausible reset stamp (mirrors kiro-quota.ts bounds). */
const RESET_MIN = 1_000_000_000
const RESET_MAX = 4_200_000_000
const PLAN_MAX_LENGTH = 80

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface DevinWindow {
  id: 'devinDaily' | 'devinWeekly'
  percent: number
  resetsAt: number | null
}

export function devinCredentialsCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = []
  if (env.APPDATA) paths.push(join(env.APPDATA, 'devin', 'credentials.toml'))
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg) {
    const expand = xdg === '~' ? home : xdg.startsWith('~/') || xdg.startsWith('~\\') ? join(home, xdg.slice(2)) : xdg
    paths.push(join(expand, 'devin', 'credentials.toml'))
  }
  paths.push(join(home, '.local', 'share', 'devin', 'credentials.toml'))
  return paths
}

/**
 * The only value this probe takes from the CLI's credentials file. `smol-toml`
 * (an existing dependency) does the parsing; the key is accepted at the file's
 * top level or inside the first section that carries it, since the CLI's
 * section layout is not documented. A file the CLI wrote but that cannot be
 * parsed means no usable credential, same as the sibling probes.
 */
export function windsurfApiKeyFromToml(raw: string): string | null {
  let root: unknown
  try {
    root = parseToml(raw)
  } catch {
    return null
  }
  const tables = [root, ...Object.values(objOf(root) ?? {})]
  for (const table of tables) {
    const obj = objOf(table)
    const key = obj?.windsurf_api_key
    if (typeof key !== 'string') continue
    const trimmed = key.trim()
    if (trimmed === '' || /[\r\n\u0000-\u001f]/.test(trimmed)) continue
    return trimmed
  }
  return null
}

function objOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Proto JSON sends int64 as strings; a percent may follow the same rule. */
function num(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** Unix-second reset stamp → epoch ms; present but implausible drops the window. */
function resetMs(value: unknown): { absent: true } | { absent: false; ok: boolean; at: number } {
  if (value == null) return { absent: true }
  const seconds = num(value)
  if (seconds == null || seconds < RESET_MIN || seconds > RESET_MAX) return { absent: false, ok: false, at: 0 }
  return { absent: false, ok: true, at: seconds * 1000 }
}

/**
 * Daily/weekly remaining percentages inverted into the consumed percentage the
 * cards render. A reset without a remaining percentage is an exhausted window;
 * a remaining percentage without a reset keeps `resetsAt: null`.
 */
export function windowsFromUserStatus(payload: unknown): DevinWindow[] | null {
  const root = objOf(payload)
  const userStatus = objOf(root?.userStatus)
  const planStatus = objOf(userStatus?.planStatus)
  if (!planStatus) return null
  const windows: DevinWindow[] = []
  const pools: Array<{ remainingKey: 'dailyQuotaRemainingPercent' | 'weeklyQuotaRemainingPercent'; resetKey: 'dailyQuotaResetAtUnix' | 'weeklyQuotaResetAtUnix'; id: DevinWindow['id'] }> = [
    { remainingKey: 'dailyQuotaRemainingPercent', resetKey: 'dailyQuotaResetAtUnix', id: 'devinDaily' },
    { remainingKey: 'weeklyQuotaRemainingPercent', resetKey: 'weeklyQuotaResetAtUnix', id: 'devinWeekly' },
  ]
  for (const pool of pools) {
    const remaining = num(planStatus[pool.remainingKey])
    const reset = resetMs(planStatus[pool.resetKey])
    if (remaining == null && reset.absent) continue
    if (!reset.absent && !reset.ok) continue
    const used = remaining == null ? 100 : clampPercent(100 - remaining)
    windows.push({ id: pool.id, percent: used, resetsAt: reset.absent ? null : reset.at })
  }
  return windows.length > 0 ? windows : null
}

export function planFromUserStatus(payload: unknown): string | null {
  const root = objOf(payload)
  const userStatus = objOf(root?.userStatus)
  const planStatus = objOf(userStatus?.planStatus)
  const planInfo = objOf(planStatus?.planInfo)
  const name = typeof planInfo?.planName === 'string' ? planInfo.planName.trim() : ''
  return name !== '' ? name.slice(0, PLAN_MAX_LENGTH) : null
}

export async function fetchDevinQuota(
  fetchImpl: FetchImpl,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<QuotaOutcome> {
  const path = devinCredentialsCandidates(home, env).find((candidate) => existsSync(candidate))
  if (!path) return { available: false, reason: 'no-auth' }
  let apiKey: string | null = null
  try {
    apiKey = windsurfApiKeyFromToml(await readFile(path, 'utf8'))
  } catch {
    // The file vanished between the existence check and the read; no credential.
  }
  if (!apiKey) return { available: false, reason: 'no-auth' }
  try {
    const res = await fetchImpl(GET_USER_STATUS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: JSON.stringify({
        // The version fields carry the CLI's own convention: the endpoint
        // accepts any SemVer, and third-party clients send 0.0.0 when the CLI
        // has recorded none. Extra unknown fields are ignored server-side.
        metadata: {
          apiKey,
          ideName: 'devin-cli',
          extensionName: 'devin-cli',
          ideVersion: '0.0.0',
          extensionVersion: '0.0.0',
        },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) return { available: false, reason: 'reauth' }
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    let parsed: unknown
    try {
      parsed = JSON.parse(await res.text())
    } catch {
      return { available: false, reason: 'bad-response' }
    }
    const windows = windowsFromUserStatus(parsed)
    if (!windows) return { available: false, reason: 'parse-failed' }
    return {
      available: true,
      body: JSON.stringify({ plan: planFromUserStatus(parsed), windows, topUpCredits: null, stale: false }),
    }
  } catch (error) {
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}
