import type { ProviderResult } from '../types'
import { AGENT_CLIENTS, readPricingMeta, type AgentPeriodVM, type AgentUsageVM } from './agent-usage'

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

// Replay-worthy terminal states only: a persisted error would re-paint a
// stale failure (e.g. a 401 from undecrypted keys) on the next first paint
const CACHED_STATUSES: ReadonlySet<string> = new Set(['ok', 'unconfigured'])

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

/** Best-effort persist; ok/unconfigured results only (loading/error excluded) */
export function saveCachedResults(results: Record<string, ProviderResult>): void {
  try {
    const out: Record<string, ProviderResult> = {}
    for (const [key, r] of Object.entries(results)) {
      if (CACHED_STATUSES.has(r.status)) out[key] = r
    }
    localStorage.setItem(RESULTS_KEY, JSON.stringify(out))
  } catch {
    // Storage full / unavailable — the cache is an optimization, not data
  }
}

/**
 * Whether a cache key is one of `providerId`'s own account keys. Keys are
 * `providerId-index`, and a plain prefix test would also match a provider
 * whose id extends this one (`kimi-intl-0` starts with `kimi-`), so the part
 * after the id has to be the index.
 */
function isAccountKey(key: string, providerId: string): boolean {
  if (!key.startsWith(`${providerId}-`)) return false
  return /^\d+$/.test(key.slice(providerId.length + 1))
}

/**
 * The results minus every account of the listed providers. This is the
 * in-memory counterpart of {@link dropCachedResults}: a caller that has
 * already read the cache into state cannot be helped by rewriting storage.
 */
export function withoutAccountResults<T>(
  results: Record<string, T>,
  providerIds: readonly string[],
): Record<string, T> {
  if (providerIds.length === 0) return results
  return Object.fromEntries(
    Object.entries(results).filter(([key]) => !providerIds.some((id) => isAccountKey(key, id))),
  )
}

/**
 * Forget every cached reading of one provider's accounts. Keys are
 * `providerId-index`, so moving accounts between providers re-indexes them: a
 * reading left in place would paint one account's numbers on another's card
 * until the next refresh replaced it. Accounts cached under another provider
 * are untouched, including one whose id extends `providerId`.
 */
export function dropCachedResults(providerId: string): void {
  try {
    const raw = localStorage.getItem(RESULTS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    localStorage.setItem(RESULTS_KEY, JSON.stringify(withoutAccountResults(parsed, [providerId])))
  } catch {
    // An unreadable cache has nothing worth keeping; the next refresh rewrites it
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

/**
 * Repair the per-model rows read from a cache written before a field existed.
 *
 * The trends page reads `input` per index to honour the no-cache display mode,
 * so an absent array would turn that arithmetic into `undefined`. The best an
 * old row can offer is `total - output` — input plus cache — and the next scan
 * replaces it; leaving the array empty would understate every row instead.
 *
 * `cacheRead` arrived later still. What a row's total has left once input and
 * output are taken out is cache read plus cache write, so that remainder
 * stands in for the reads: a model filter then keeps a split that is off by
 * the writes alone, and only until the next scan.
 */
function normalizeModelRows(value: unknown): AgentUsageVM['modelDaily'] {
  if (!Array.isArray(value)) return []
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return value.map((entry) => {
    const row = (entry ?? {}) as AgentUsageVM['modelDaily'][number]
    const total = Array.isArray(row.total) ? row.total : []
    const output = Array.isArray(row.output) ? row.output : []
    const input = Array.isArray(row.input)
      ? row.input
      : total.map((v, i) =>
          Math.max(0, (typeof v === 'number' ? v : 0) - (typeof output[i] === 'number' ? output[i]! : 0)),
        )
    const cacheRead = Array.isArray(row.cacheRead)
      ? row.cacheRead
      : total.map((v, i) => Math.max(0, num(v) - num(input[i]) - num(output[i])))
    return { ...row, input, cacheRead }
  })
}

/**
 * Repair the per-client rows read from a cache written before `models`
 * existed, and drop rows whose client id this build no longer knows.
 *
 * Two independent crash paths are closed here:
 *   1. `models` missing → the card maps it unconditionally.
 *   2. `client` missing or not in AGENT_CLIENTS → the card resolves the row's
 *      label as `AGENT_LABELS[client.client][0]`, which dereferences undefined.
 * Either one throws during render, and there is no error boundary above the
 * page, so the whole window would stay blank until a scan replaced the cache.
 * A cache written by another build (downgrade, or a client later removed) is
 * exactly where such an id comes from.
 */
function normalizeClientRows(value: unknown): AgentUsageVM['clients'] {
  if (!Array.isArray(value)) return []
  const known = new Set<string>(AGENT_CLIENTS)
  const out: AgentUsageVM['clients'] = []
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue
    const row = entry as AgentUsageVM['clients'][number]
    if (typeof row.client !== 'string' || !known.has(row.client)) continue
    out.push(
      dropMissingWindows({
        ...row,
        today: withPeriodDefaults(row.today),
        month: withPeriodDefaults(row.month),
        week: isPeriod(row.week) ? withPeriodDefaults(row.week) : undefined,
        last7: isPeriod(row.last7) ? withPeriodDefaults(row.last7) : undefined,
        allTime: withPeriodDefaults(row.allTime),
        models: Array.isArray(row.models)
          ? row.models.map((m) =>
              dropMissingWindows({
                ...m,
                today: withPeriodDefaults(m.today),
                month: withPeriodDefaults(m.month),
                week: isPeriod(m.week) ? withPeriodDefaults(m.week) : undefined,
                allTime: withPeriodDefaults(m.allTime),
              }),
            )
          : [],
      }),
    )
  }
  return out
}

/** A usage period as cached: an object of counters. An array or a scalar is not one. */
function isPeriod(value: unknown): value is AgentPeriodVM {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Remove the week windows (`week`, `last7`) a cache does not really carry. A
 * summary written before a window existed deserializes without it (or with
 * null), and a zero put in its place would read like a measurement; absent,
 * the card shows a dash (or leaves the agent out of a ranking) until the next
 * scan fills it in.
 */
function dropMissingWindows<T extends { week?: unknown; last7?: unknown }>(value: T): T {
  if (!isPeriod(value.week)) delete value.week
  if (!isPeriod(value.last7)) delete value.last7
  return value
}

/**
 * Fill per-period fields a cache written before they existed is missing:
 * `cacheWrite` (prompt-cache writes) and `credits` (the billing unit of a
 * gateway that reports no tokens, e.g. Qoder global). Both are counters, so 0 is
 * the honest default; leaving either undefined would turn the breakdown
 * arithmetic into NaN the moment a caller sums it.
 */
function withPeriodDefaults(period: AgentUsageVM['clients'][number]['today'] | undefined) {
  if (period == null || typeof period !== 'object') {
    return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0, credits: 0 }
  }
  return {
    ...period,
    cacheWrite: typeof period.cacheWrite === 'number' ? period.cacheWrite : 0,
    credits: typeof period.credits === 'number' ? period.credits : 0,
  }
}

export function loadCachedAgentUsage(): AgentUsageVM | null {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isValidUsageVM(parsed)) return null
    // Normalize the newer fields: caches written before a field existed
    // deserialize without it (undefined), which is not the declared type.
    //
    // `modelDaily` must be normalized here rather than trusted, because the
    // trends page iterates it unconditionally — a cache from a build that
    // predates it would otherwise throw during render, and with no error
    // boundary above the page that unmounts the whole tree and blanks the
    // window for every upgrading user until a scan completes.
    return {
      ...parsed,
      skippedClients: Array.isArray(parsed.skippedClients) ? parsed.skippedClients : null,
      modelDaily: normalizeModelRows(parsed.modelDaily),
      pricing: readPricingMeta(parsed.pricing),
      priceCoverage: {
        monthUnknownTokens:
          typeof parsed.priceCoverage?.monthUnknownTokens === 'number' ? parsed.priceCoverage.monthUnknownTokens : 0,
        monthFallbackTokens:
          typeof parsed.priceCoverage?.monthFallbackTokens === 'number' ? parsed.priceCoverage.monthFallbackTokens : 0,
      },
      clients: normalizeClientRows(parsed.clients),
      todayTotal: withPeriodDefaults(parsed.todayTotal),
      monthTotal: withPeriodDefaults(parsed.monthTotal),
      // Same rule as the rows: the week windows stay absent on an old cache
      weekTotal: isPeriod(parsed.weekTotal) ? withPeriodDefaults(parsed.weekTotal) : undefined,
      last7Total: isPeriod(parsed.last7Total) ? withPeriodDefaults(parsed.last7Total) : undefined,
      last7ByAgent: Array.isArray(parsed.last7ByAgent) ? parsed.last7ByAgent : undefined,
      allTimeTotal: withPeriodDefaults(parsed.allTimeTotal),
      other:
        parsed.other && typeof parsed.other === 'object'
          ? dropMissingWindows({
              today: withPeriodDefaults(parsed.other.today),
              month: withPeriodDefaults(parsed.other.month),
              week: isPeriod(parsed.other.week) ? withPeriodDefaults(parsed.other.week) : undefined,
              all: withPeriodDefaults(parsed.other.all),
            })
          : null,
    }
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
