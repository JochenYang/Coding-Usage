import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QuotaOutcome } from './subscription-quotas'
import { isTimeoutError } from './fetch-errors'

/**
 * Kilo Pass usage from the CLI login, or `KILO_API_KEY` when that file is absent.
 *
 * The request is the same tRPC batch the Kilo app uses. The token stays in the
 * main process. A missing balance is unavailable, not 0%; an explicit zero
 * balance from `totalBalance_mUsd` is the one exhausted state the API reports
 * without credit blocks.
 */

const PROCEDURES = ['user.getCreditBlocks', 'kiloPass.getState', 'user.getAutoTopUpPaymentMethod'] as const
const USAGE_URL = `https://app.kilo.ai/api/trpc/${PROCEDURES.join(',')}?batch=1&input=${encodeURIComponent(
  JSON.stringify({ 0: { json: null }, 1: { json: null }, 2: { json: null } }),
)}`

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export function kiloAuthCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const expand = (value: string): string => {
    if (value === '~') return home
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
    return value
  }
  const paths: string[] = []
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg) paths.push(join(expand(xdg), 'kilo', 'auth.json'))
  paths.push(join(home, '.local', 'share', 'kilo', 'auth.json'))
  if (env.APPDATA) paths.push(join(env.APPDATA, 'kilo', 'auth.json'))
  if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, 'kilo', 'auth.json'))
  return paths
}

export function kiloTokenFromAuth(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { kilo?: { access?: unknown } }
    const access = parsed.kilo?.access
    if (typeof access !== 'string') return null
    const token = access.trim()
    if (token === '' || /[\r\n]/.test(token)) return null
    return token
  } catch {
    return null
  }
}

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  const record = value as Record<string, unknown>
  visit(record)
  for (const child of Object.values(record)) walk(child, visit)
}

function resultJson(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return null
  const result = (entry as { result?: unknown }).result
  if (!result || typeof result !== 'object') return null
  const data = (result as { data?: unknown }).data
  if (data && typeof data === 'object' && 'json' in data) return (data as { json?: unknown }).json ?? null
  return data ?? (result as { json?: unknown }).json ?? null
}

function creditWindow(payload: unknown): { percent: number; resetsAt: number | null } | null {
  const found: { blocks: unknown[] | null; zeroBalance: boolean } = { blocks: null, zeroBalance: false }
  walk(payload, (record) => {
    if (Array.isArray(record.creditBlocks)) found.blocks = record.creditBlocks
    if (record.totalBalance_mUsd === 0) found.zeroBalance = true
  })
  if (found.blocks) {
    let total = 0
    let remaining = 0
    let saw = false
    for (const block of found.blocks) {
      if (!block || typeof block !== 'object') continue
      const amount = finite((block as { amount_mUsd?: unknown }).amount_mUsd)
      const balance = finite((block as { balance_mUsd?: unknown }).balance_mUsd)
      if (amount != null) {
        total += amount / 1_000_000
        saw = true
      }
      if (balance != null) remaining += balance / 1_000_000
    }
    if (saw && total > 0) {
      return { percent: Math.max(0, Math.min(100, ((total - remaining) / total) * 100)), resetsAt: null }
    }
  }
  if (found.zeroBalance) return { percent: 100, resetsAt: null }
  return null
}

function passWindow(payload: unknown): { percent: number; resetsAt: number | null; plan: string | null } | null {
  const found: { subscription: Record<string, unknown> | null; plan: string | null } = { subscription: null, plan: null }
  walk(payload, (record) => {
    if (record.currentPeriodUsageUsd != null || record.currentPeriodBaseCreditsUsd != null) found.subscription = record
    if (typeof record.planName === 'string' && record.planName.trim() !== '') found.plan = record.planName.trim().slice(0, 80)
  })
  if (!found.subscription) return found.plan ? { percent: Number.NaN, resetsAt: null, plan: found.plan } : null
  const used = finite(found.subscription.currentPeriodUsageUsd)
  const base = finite(found.subscription.currentPeriodBaseCreditsUsd)
  const bonus = finite(found.subscription.currentPeriodBonusCreditsUsd) ?? 0
  if (used == null || base == null) return found.plan ? { percent: Number.NaN, resetsAt: null, plan: found.plan } : null
  const total = base + Math.max(0, bonus)
  if (total <= 0) return null
  const resetRaw = found.subscription.nextBillingAt ?? found.subscription.nextRenewalAt ?? found.subscription.renewsAt
  const resetsAt = typeof resetRaw === 'string' ? Date.parse(resetRaw) : null
  return {
    percent: Math.max(0, Math.min(100, (used / total) * 100)),
    resetsAt: resetsAt != null && Number.isFinite(resetsAt) ? resetsAt : null,
    plan: found.plan,
  }
}

/** Map a tRPC batch to credit and pass windows. Unknown shapes stay empty. */
export function windowsFromKiloBatch(payload: unknown): {
  plan: string | null
  windows: Array<{ id: 'kiloCredits' | 'kiloPass'; percent: number; resetsAt: number | null }>
} | null {
  const entries = Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? [payload] : null
  if (!entries) return null
  const credits = creditWindow(resultJson(entries[0]))
  const pass = passWindow(resultJson(entries[1]))
  const windows = []
  if (credits) windows.push({ id: 'kiloCredits' as const, percent: credits.percent, resetsAt: credits.resetsAt })
  if (pass && Number.isFinite(pass.percent)) {
    windows.push({ id: 'kiloPass' as const, percent: pass.percent, resetsAt: pass.resetsAt })
  }
  if (windows.length === 0) return null
  return { plan: pass?.plan ?? null, windows }
}

export async function fetchKiloQuota(
  fetchImpl: FetchImpl,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<QuotaOutcome> {
  let token = env.KILO_API_KEY?.trim() || null
  if (!token) {
    for (const path of kiloAuthCandidates(home, env)) {
      try {
        token = kiloTokenFromAuth(await readFile(path, 'utf8'))
        if (token) break
      } catch {
        // try the next candidate
      }
    }
  }
  if (!token || /[\r\n]/.test(token)) return { available: false, reason: 'no-auth' }
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) return { available: false, reason: 'reauth' }
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    const parsed = windowsFromKiloBatch(JSON.parse(await res.text()))
    if (!parsed) return { available: false, reason: 'parse-failed' }
    return {
      available: true,
      body: JSON.stringify({ plan: parsed.plan, windows: parsed.windows, topUpCredits: null, stale: false }),
    }
  } catch (error) {
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}
