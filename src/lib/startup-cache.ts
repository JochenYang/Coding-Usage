import type { ProviderResult } from '../types'
import type { AgentUsageVM } from './agent-usage'

/**
 * Startup cache for the two slow-to-compute surfaces (provider fetch results
 * and the tokscale scan summary). Both are persisted after every successful
 * refresh and replayed synchronously on the next launch, so the dashboard
 * paints last-known numbers immediately while the background refresh runs.
 * Everything is validated on read: a stale/garbage payload degrades to "no
 * cache", never to a crash.
 */

const RESULTS_KEY = 'coding-usage.results.v1'
const USAGE_KEY = 'coding-usage.agent-usage.v1'

const CACHED_STATUSES: ReadonlySet<string> = new Set(['ok', 'error', 'unconfigured'])

/** Load the last persisted fetch results; `loading` entries are never cached */
export function loadCachedResults(): Record<string, ProviderResult> {
  try {
    const raw = localStorage.getItem(RESULTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, ProviderResult> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const r = value as { status?: unknown; metrics?: unknown; error?: unknown; fetchedAt?: unknown }
      if (typeof r.status !== 'string' || !CACHED_STATUSES.has(r.status)) continue
      out[key] = {
        status: r.status as ProviderResult['status'],
        metrics: Array.isArray(r.metrics) ? (r.metrics as ProviderResult['metrics']) : undefined,
        error: typeof r.error === 'string' ? r.error : undefined,
        fetchedAt: typeof r.fetchedAt === 'number' ? r.fetchedAt : undefined,
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Best-effort persist; metrics-bearing results only (loading is transient) */
export function saveCachedResults(results: Record<string, ProviderResult>): void {
  try {
    const out: Record<string, ProviderResult> = {}
    for (const [key, r] of Object.entries(results)) {
      if (r.status !== 'loading') out[key] = r
    }
    localStorage.setItem(RESULTS_KEY, JSON.stringify(out))
  } catch {
    // Storage full / unavailable — the cache is an optimization, not data
  }
}

/**
 * Minimal structural check for a persisted {@link AgentUsageVM}: the fields
 * the overview renders must at least be the right shapes. Numeric content is
 * re-validated downstream by the renderers, same as a fresh scan.
 */
function isValidUsageVM(value: unknown): value is AgentUsageVM {
  if (!value || typeof value !== 'object') return false
  const vm = value as Partial<AgentUsageVM>
  return (
    Array.isArray(vm.clients) &&
    vm.todayTotal != null &&
    vm.monthTotal != null &&
    vm.allTimeTotal != null &&
    Array.isArray(vm.dailySeries) &&
    vm.error === null
  )
}

export function loadCachedAgentUsage(): AgentUsageVM | null {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidUsageVM(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveCachedAgentUsage(vm: AgentUsageVM): void {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(vm))
  } catch {
    // best-effort mirror
  }
}
