/**
 * Reconcile tokscale's provider attribution on client entries.
 *
 * The kimi session parser stamps every Kimi CLI / Kimi Code session with
 * provider `moonshot` (DEFAULT_PROVIDER in
 * crates/tokscale-core/src/sessions/kimi.rs) — even when the session actually
 * routed through another channel. wire.jsonl records the real route in the
 * model alias, e.g. `opencode/deepseek-v4-flash-free`, and the graph payload
 * carries it as the modelId. Since the channel prefix names the router that
 * really served the traffic, the prefix wins whenever the stamp is the
 * hardcoded default; bare model ids (e.g. `kimi-for-coding`, `kimi-k2.5`)
 * genuinely are Moonshot models and keep the stamp.
 *
 * Only the hardcoded default is touched: providerIds that came from the user's
 * own session data (opencode client, DSH, …) are trusted as-is.
 */

/** providerIds that are parser defaults rather than session-derived facts */
const HARDCODED_PROVIDER_DEFAULTS = new Set(['moonshot'])

/** Real provider for one client entry; undefined keeps the existing value */
export function reconcileProviderId(providerId: string | undefined, modelId: string | undefined): string | undefined {
  if (!providerId || !HARDCODED_PROVIDER_DEFAULTS.has(providerId)) return providerId
  if (typeof modelId !== 'string') return providerId
  const slash = modelId.indexOf('/')
  if (slash <= 0) return providerId
  const prefix = modelId.slice(0, slash).trim()
  return prefix || providerId
}

interface ReconcileTarget {
  providerId?: string | null
  modelId?: unknown
}

/**
 * Walk a `tokscale graph` payload and rewrite the providerId of client
 * entries whose stamp is a hardcoded default. Pure: returns a new root when
 * anything changed, the same root otherwise; never throws.
 */
export function reconcileProviderAttribution(daily: unknown): unknown {
  const root = daily as { contributions?: unknown } | null
  if (root == null || typeof root !== 'object') return daily
  if (!Array.isArray(root.contributions)) return daily

  let changed = false
  for (const c of root.contributions) {
    const contrib = c as { clients?: unknown }
    if (contrib == null || typeof contrib !== 'object' || !Array.isArray(contrib.clients)) continue
    for (const e of contrib.clients) {
      const entry = e as ReconcileTarget
      if (entry == null || typeof entry !== 'object') continue
      const fixed = reconcileProviderId(entry.providerId ?? undefined, typeof entry.modelId === 'string' ? entry.modelId : undefined)
      if (fixed !== entry.providerId) {
        entry.providerId = fixed
        changed = true
      }
    }
  }
  return changed ? root : daily
}
