/**
 * Merge several per-client `tokscale graph` payloads into one payload.
 *
 * tokscale is a Rust binary we cannot patch. A single client's session data
 * can make it panic (exit 101) — e.g. model ids carrying a non-ASCII provider
 * name (known upstream bug family: byte-slicing mid-codepoint). That must not
 * blank the whole local-usage view, so when the combined scan dies we retry
 * one client at a time and merge the healthy ones. This module is pure:
 * given the same payloads the caller's `overrideCosts` also understands, it
 * returns one payload with the same top-level shape.
 */

interface ClientEntry {
  client: string
  modelId?: string
  providerId?: string
  tokens?: Record<string, number>
  cost?: number
  messages?: number
}

interface Contribution {
  date: string
  totals: Record<string, number>
  tokenBreakdown: Record<string, number>
  clients: ClientEntry[]
  intensity: number
  activeTimeMs: number
}

interface YearRow {
  year: string
  totalTokens: number
  totalCost: number
  start: string
  end: string
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Sum the numeric fields of `src` into `target` (records with unknown shapes pass through) */
function addNumericFields(target: Record<string, number>, src: unknown): void {
  const rec = asRecord(src)
  if (!rec) return
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'number' && Number.isFinite(v)) target[k] = (target[k] ?? 0) + v
  }
}

/**
 * Merge `graph` payloads keyed by contribution date. `meta` comes from the
 * first payload; `summary` and `years` are recomputed so every consumer sees
 * a coherent aggregate; `timeMetrics` is dropped (not rendered by the app).
 */
export function mergeGraphPayloads(payloads: unknown[]): unknown {
  const byDate = new Map<string, Contribution>()
  const years = new Map<string, YearRow>()
  let meta: unknown = null

  for (const payload of payloads) {
    const root = asRecord(payload)
    if (!root) continue
    if (meta == null) meta = root.meta
    const contributions = Array.isArray(root.contributions) ? root.contributions : []
    for (const c of contributions) {
      const rec = asRecord(c)
      if (!rec) continue
      const date = typeof rec.date === 'string' ? rec.date : ''
      if (!date) continue
      let hit = byDate.get(date)
      if (!hit) {
        hit = { date, totals: {}, tokenBreakdown: {}, clients: [], intensity: 0, activeTimeMs: 0 }
        byDate.set(date, hit)
      }
      addNumericFields(hit.totals, rec.totals)
      addNumericFields(hit.tokenBreakdown, rec.tokenBreakdown)
      if (Array.isArray(rec.clients)) hit.clients.push(...(rec.clients as ClientEntry[]))
      hit.intensity += num(rec.intensity)
      hit.activeTimeMs += num(rec.activeTimeMs)

      const year = date.slice(0, 4)
      let row = years.get(year)
      if (!row) {
        row = { year, totalTokens: 0, totalCost: 0, start: date, end: date }
        years.set(year, row)
      }
      row.totalTokens += num((asRecord(rec.totals) as Record<string, unknown> | null)?.tokens)
      row.totalCost += num((asRecord(rec.totals) as Record<string, unknown> | null)?.cost)
      if (date < row.start) row.start = date
      if (date > row.end) row.end = date
    }
  }

  const contributions = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const clients = new Set<string>()
  const models = new Set<string>()
  let totalTokens = 0
  let totalCost = 0
  let maxCostInSingleDay = 0
  for (const c of contributions) {
    totalTokens += num(c.totals.tokens)
    totalCost += num(c.totals.cost)
    maxCostInSingleDay = Math.max(maxCostInSingleDay, num(c.totals.cost))
    for (const cl of c.clients) {
      if (cl.client) clients.add(cl.client)
      if (cl.modelId) models.add(cl.modelId)
    }
  }
  const days = contributions.length
  const modelList = [...models].sort()
  const summary = {
    totalTokens,
    totalCost,
    totalDays: days,
    activeDays: days,
    averagePerDay: days > 0 ? totalCost / days : 0,
    maxCostInSingleDay,
    clients: [...clients].sort(),
    models: modelList,
  }
  const yearRows = [...years.values()].sort((a, b) => (a.year < b.year ? -1 : 1))

  return { meta, summary, years: yearRows, contributions }
}
