/**
 * Trend analysis helpers for the "usage trends" page.
 *
 * Everything here is pure and DOM-free so the bucketing / rate maths can be
 * reasoned about (and unit-tested) independently of the chart components.
 *
 * Data granularity constraint: the tokscale scan reports ONE entry per
 * calendar day (`date: "YYYY-MM-DD"`) with a day-level `activeTimeMs`. There
 * are no per-call timestamps, so sub-day buckets cannot be built without
 * inventing data — the range selector therefore only ever narrows the day
 * window, it never subdivides it.
 */
import type { AgentUsageVM, DayPointVM, ModelDailySeriesVM } from './agent-usage'

/** Selectable look-back windows, in days (null = the entire scanned span) */
export const RANGE_DAYS = [7, 14, 30, 90, null] as const
export type TrendRange = (typeof RANGE_DAYS)[number]

/** Range keys survive the settings round-trip as plain strings */
export function rangeKey(range: TrendRange): string {
  return range === null ? 'all' : String(range)
}

/** Narrow a daily series to the trailing `days` entries (null = unchanged) */
export function sliceRange(points: DayPointVM[], range: TrendRange): DayPointVM[] {
  if (range === null || points.length <= range) return points
  return points.slice(-range)
}

/** One bucketed column of the aggregate chart */
export interface TrendBucket {
  /** Short axis label (the bucket's first day), so weekly columns stay separable */
  label: string
  /** Full span of a multi-day bucket, for the hover tooltip */
  rangeLabel: string
  /** Cache-read portion of the stack */
  cacheRead: number
  /** Non-cached input portion of the stack */
  input: number
  /** Output portion of the stack */
  output: number
  /** Input + output + cacheRead + cacheWrite */
  total: number
  /** Session-active ms in the bucket (tok/s denominator) */
  activeTimeMs: number
  /** Message (call) count in the bucket */
  messages: number
  /** Weighted output speed of the bucket; null when no active time is known */
  tokPerSec: number | null
}

/**
 * Bucket a day series into chart columns. Weeks are used once the window is
 * long enough that per-day columns would be unreadably thin (the chart caps
 * out around 30 columns); the trailing bucket may be a partial week, which is
 * reported as-is rather than padded with zeros that would fake a drop-off.
 */
export function bucketize(points: DayPointVM[]): TrendBucket[] {
  const weekBuckets = points.length > 30 ? 7 : 1
  const out: TrendBucket[] = []
  for (let i = 0; i < points.length; i += weekBuckets) {
    const chunk = points.slice(i, i + weekBuckets)
    const first = chunk[0]!
    const last = chunk[chunk.length - 1]!
    const cacheRead = chunk.reduce((s, p) => s + p.cacheRead, 0)
    const input = chunk.reduce((s, p) => s + p.input, 0)
    const output = chunk.reduce((s, p) => s + p.output, 0)
    const cacheWrite = chunk.reduce((s, p) => s + p.cacheWrite, 0)
    const activeTimeMs = chunk.reduce((s, p) => s + p.activeTimeMs, 0)
    const messages = chunk.reduce((s, p) => s + p.messages, 0)
    out.push({
      // The axis takes the short form: a range-quoted label is 11 characters and
      // collides with its neighbours even after thinning. The full span stays
      // available for the tooltip, which has room for it.
      label: first.label,
      rangeLabel: weekBuckets === 1 ? first.label : `${first.label}–${last.label}`,
      cacheRead,
      input,
      output,
      total: input + output + cacheRead + cacheWrite,
      activeTimeMs,
      messages,
      tokPerSec: activeTimeMs > 0 ? output / (activeTimeMs / 1000) : null,
    })
  }
  return out
}

/** Headline numbers shown above the trend chart */
export interface TrendTotals {
  /** Mode-aware token total (cache included or not) */
  tokens: number
  input: number
  output: number
  cacheRead: number
  messages: number
  /**
   * Cache hit rate as a percentage: cacheRead / (cacheRead + input).
   * 0 when nothing was read — never NaN.
   */
  hitRatePct: number
  /**
   * Weighted output speed: total output tokens over total active seconds.
   * This is deliberately NOT "model generation speed" — session-active time
   * includes thinking, tool calls and idle gaps inside a session, so the
   * figure sits well below a provider-reported tok/s. Null when no active
   * time was recorded at all.
   */
  weightedTokPerSec: number | null
}

/** Fold bucketed columns into the KPI row (mode controls the headline token count) */
export function computeTotals(buckets: TrendBucket[], mode: 'all' | 'no-cache'): TrendTotals {
  let input = 0
  let output = 0
  let cacheRead = 0
  let messages = 0
  let activeTimeMs = 0
  for (const b of buckets) {
    input += b.input
    output += b.output
    cacheRead += b.cacheRead
    messages += b.messages
    activeTimeMs += b.activeTimeMs
  }
  const promptSide = cacheRead + input
  return {
    tokens: mode === 'no-cache' ? input + output : buckets.reduce((s, b) => s + b.total, 0),
    input,
    output,
    cacheRead,
    messages,
    hitRatePct: promptSide > 0 ? (cacheRead / promptSide) * 100 : 0,
    weightedTokPerSec: activeTimeMs > 0 ? output / (activeTimeMs / 1000) : null,
  }
}

/** One model row of the comparison chart */
export interface ModelCompareRow {
  model: string
  /** Total tokens (all kinds) over the selected window */
  tokens: number
  /** Output tokens over the window */
  output: number
  /** Call count over the window */
  messages: number
  /** Estimated active ms attributed to this model (see below) */
  activeTimeMs: number
  /** Estimated weighted output speed; null when no time could be attributed */
  tokPerSec: number | null
}

/**
 * Collapse the scan's provider-qualified model rows into one row per model.
 *
 * tokscale keys a model by the endpoint that served it, so the same model used
 * through three providers arrives as three rows ("zhipuai-coding-plan/glm-5.3",
 * "codingplan.site/glm-5.3", …). Those rows carry the same display name, which
 * is how the split chart ends up drawing three identical legend entries and its
 * tooltip lists "glm-5.3-flash" five times over. Everything on the trends page
 * is read per model, so the rows are summed by their provider-stripped name
 * before anything else touches them — the filter, the split chart and the
 * ranking then all agree on what one model is.
 *
 * The merged row keeps its index alignment with `dailySeries` by adding the
 * per-day arrays index by index.
 */
export function groupModelDaily(models: ModelDailySeriesVM[]): ModelDailySeriesVM[] {
  const byName = new Map<string, ModelDailySeriesVM>()
  for (const m of models) {
    const name = modelBasename(m.model)
    const merged = byName.get(name)
    if (!merged) {
      // Copy the arrays: the caller's rows stay referenced by the raw scan data
      byName.set(name, {
        model: name,
        tokens: m.tokens,
        output: [...m.output],
        messages: [...m.messages],
        total: [...m.total],
      })
      continue
    }
    merged.tokens += m.tokens
    for (let i = 0; i < merged.total.length; i++) {
      merged.output[i] = (merged.output[i] ?? 0) + (m.output[i] ?? 0)
      merged.messages[i] = (merged.messages[i] ?? 0) + (m.messages[i] ?? 0)
      merged.total[i] = (merged.total[i] ?? 0) + (m.total[i] ?? 0)
    }
  }
  return [...byName.values()].sort((a, b) => b.tokens - a.tokens)
}

/**
 * Per-model comparison rows over a day window.
 *
 * Active time is the one figure tokscale does not break down per model, so it
 * is attributed pro-rata by each model's share of that day's CALL COUNT. It is
 * an ESTIMATE — it spreads a day's session time across the models used that
 * day, so the per-model speeds are comparative, not absolute — and the UI
 * labels it as estimated rather than presenting it as measured generation time.
 */
export function buildModelRows(
  models: ModelDailySeriesVM[],
  dayCount: number,
  activeTimePerDay: number[],
  dayMessages: number[],
): ModelCompareRow[] {
  const from = Math.max(0, activeTimePerDay.length - dayCount)
  return models
    .map((m) => {
      let tokens = 0
      let output = 0
      let messages = 0
      let activeTimeMs = 0
      const start = Math.max(0, m.output.length - dayCount)
      for (let i = start; i < m.output.length; i++) {
        const dayCalls = m.messages[i] ?? 0
        tokens += m.total[i] ?? 0
        output += m.output[i] ?? 0
        messages += dayCalls
        const dayIndex = from + (i - start)
        const dayActive = activeTimePerDay[dayIndex] ?? 0
        const totalDayCalls = dayMessages[dayIndex] ?? 0
        // Only attribute time when both sides are known; a day with active
        // time but no recorded calls contributes nothing (rather than the
        // whole day) so one model cannot absorb an entire session's time.
        if (dayCalls > 0 && totalDayCalls > 0) {
          activeTimeMs += dayActive * (dayCalls / totalDayCalls)
        }
      }
      return {
        model: m.model,
        tokens,
        output,
        messages,
        activeTimeMs,
        tokPerSec: activeTimeMs > 0 ? output / (activeTimeMs / 1000) : null,
      }
    })
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
}

/**
 * Fixed categorical palette for model series. Index-based so a model keeps its
 * colour while the filter changes the visible set (a "first N" assignment
 * would recolour everything on each toggle).
 */
const MODEL_PALETTE = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
  'var(--color-chart-7)',
  'var(--color-chart-8)',
] as const

/** Stable colour for a model, hashed so the same name always maps the same way */
export function modelColor(model: string, index: number): string {
  // Prefer the ordinal when the caller already sorted by size (the common
  // case: the biggest model gets the accent colour); fall back to a hash so an
  // arbitrary ordering still stays stable for a given name.
  const slot = index >= 0 && index < MODEL_PALETTE.length ? index : hashName(model) % MODEL_PALETTE.length
  return MODEL_PALETTE[slot]!
}

function hashName(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * Human-readable model label.
 *
 * tokscale emits some model ids percent-encoded (non-ASCII provider names are
 * URL-escaped in its `models` list), which render as an unreadable
 * `%e6%96%b0...` in the UI — decode those. The provider prefix is dropped
 * because every entry already sits in a model list, and the fallback keeps the
 * tail when decoding fails.
 */
export function modelLabel(model: string): string {
  let decoded = model
  if (model.includes('%')) {
    try {
      decoded = decodeURIComponent(model)
    } catch {
      // A malformed escape is not worth losing the label over
      decoded = model
    }
  }
  return decoded
}

/**
 * Provider-stripped model name.
 *
 * The tail is what the UI shows, and it is also what tells two models of the
 * same family apart — the provider prefix is long and repeats across a list.
 */
export function modelBasename(model: string): string {
  const full = modelLabel(model)
  return full.includes('/') ? full.slice(full.lastIndexOf('/') + 1) : full
}

/**
 * Legend/filter label: the provider-stripped tail, truncated.
 *
 * Truncation can collide across providers (two "deepseek-v4.1-fla…"), so
 * callers must not use this as a React key — use the raw `model` id for
 * identity, which is unique by construction.
 */
export function shortModelName(model: string, max = 18): string {
  const tail = modelBasename(model)
  return tail.length > max ? `${tail.slice(0, max - 1)}…` : tail
}

/** Provider portion of a model id, or null when it has no prefix */
export function modelProvider(model: string): string | null {
  const full = modelLabel(model)
  const i = full.lastIndexOf('/')
  return i > 0 ? full.slice(0, i) : null
}

/** Convenience: how many days the aggregate series covers for a usage VM */
export function spanDays(usage: AgentUsageVM): number {
  return usage.dailySeries.length
}
