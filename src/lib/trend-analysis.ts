/**
 * Trend analysis helpers for the "usage trends" page.
 *
 * Everything here is pure and DOM-free so the bucketing / rate maths can be
 * reasoned about (and unit-tested) independently of the chart components.
 * Data granularity constraint: the tokscale scan reports ONE entry per
 * calendar day (`date: "YYYY-MM-DD"`) with a day-level `activeTimeMs`, and
 * days without usage are simply absent from the payload — a real 388-day span
 * arrived as 213 rows. The series is therefore sparse, and `densifySeries`
 * restores the calendar grid before anything windows or buckets it. There are
 * no per-call timestamps, so sub-day buckets cannot be built without inventing
 * data — the range selector only ever narrows the day window, it never
 * subdivides it.
 */
import type { DayPointVM, ModelDailySeriesVM } from './agent-usage'

/** Selectable look-back windows, in days (null = the entire scanned span) */
export const RANGE_DAYS = [7, 14, 30, 90, null] as const
export type TrendRange = (typeof RANGE_DAYS)[number]

/**
 * Narrow a daily series to its trailing `days` entries (null = unchanged).
 *
 * Expects the contiguous calendar grid from {@link densifySeries}: on a sparse
 * series "the last 30 entries" is not "the last 30 days". A series that could
 * not be densified (legacy points without dates) keeps the row-count behaviour,
 * which is the coarse window it already had.
 */
export function sliceRange(points: DayPointVM[], range: TrendRange): DayPointVM[] {
  if (range === null || points.length <= range) return points
  return points.slice(-range)
}

/** One calendar day — the grid step for {@link densifySeries} */
const DAY_MS = 86_400_000

/**
 * Session-active milliseconds that may be used as a duration.
 *
 * `activeTimeMs` is a sum of session spans, and some upstream readers report a
 * span that outlives the day it is filed under — on a real scan 30 of 211 days
 * exceeded 24 h, the worst by two orders of magnitude (2471 h on a day holding
 * 6 calls from a single client). A calendar day cannot contain more than a day
 * of elapsed time, so such a value is not a duration and must not be used as
 * one: counting those days took 97% of the denominator and dragged the
 * headline speed from ~35 tok/s down to 1.06.
 *
 * Token and call totals keep every day; only the rates drop these.
 */
function measurableActiveMs(ms: number): number {
  return ms > 0 && ms <= DAY_MS ? ms : 0
}

/** Convenience over {@link measurableActiveMs} for a day point */
function measurableActiveMsOf(p: DayPointVM): number {
  return measurableActiveMs(p.activeTimeMs)
}

/** The only shape a fallback source can produce: a total, nothing else */
export interface FallbackPoint {
  label: string
  value: number
  /** Present when the producer knows the real date; absent on legacy points */
  day?: string
}

/**
 * Expand a sparse day series onto a contiguous calendar grid.
 *
 * The scan emits one contribution per day that HAS usage, so `dailySeries` is
 * sparse in practice (388-day span, 213 rows, 175 days missing, worst gap 49
 * days). Charting those rows as consecutive columns made "last 30 days" mean
 * "last 30 recorded days", and turned 7-row "weeks" into buckets spanning
 * anything from 3 to 98 days.
 *
 * A missing day is a day with no usage, so it is inserted as a zero row rather
 * than left out: the x axis has to carry every day in the window or its spacing
 * lies. Only points carrying a `day` key can be placed on the grid — a series
 * without them (legacy archived points) is returned untouched, because inventing
 * dates is worse than the coarse window it already has.
 *
 * `models` are index-aligned with `points` by construction (`summarizeScan`
 * builds both in one pass), so every row is expanded by the same insertion map.
 */
export function densifySeries(
  points: readonly DayPointVM[],
  models: readonly ModelDailySeriesVM[] = [],
): { points: DayPointVM[]; models: ModelDailySeriesVM[] } {
  const unchanged = { points: [...points], models: [...models] }
  if (points.length < 2) return unchanged

  const days: string[] = []
  const dayMs: number[] = []
  for (const p of points) {
    if (typeof p.day !== 'string') return unchanged
    const ms = Date.parse(`${p.day}T00:00:00Z`)
    // Reject anything that is not exactly a valid calendar day. A shape check
    // alone lets "2026-02-30" through, and Date.parse normalises that to
    // 2026-03-02 — the original point would never land on the grid while a
    // ghost day appeared in its place.
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== p.day) return unchanged
    days.push(p.day)
    dayMs.push(ms)
  }
  // Strictly ascending: an out-of-order or repeated day would make the grid
  // overwrite one contribution with another instead of placing both.
  for (let i = 1; i < days.length; i++) if (days[i]! <= days[i - 1]!) return unchanged

  const firstMs = dayMs[0]!
  const lastMs = dayMs[dayMs.length - 1]!
  const total = Math.round((lastMs - firstMs) / DAY_MS) + 1
  if (total <= points.length) return unchanged
  // A bogus far-future date would otherwise allocate one row per day up to it,
  // times every model row, synchronously during render.
  if (total > MAX_GRID_DAYS) return unchanged

  const at = new Map<string, number>()
  for (let i = 0; i < days.length; i++) at.set(days[i]!, i)

  const grid: DayPointVM[] = []
  const modelGrid = models.map((m) => ({
    model: m.model,
    tokens: m.tokens,
    input: [] as number[],
    output: [] as number[],
    messages: [] as number[],
    total: [] as number[],
  }))
  for (let k = 0; k < total; k++) {
    const day = new Date(firstMs + k * DAY_MS).toISOString().slice(0, 10)
    const src = at.get(day)
    if (src === undefined) {
      grid.push({
        day,
        label: day.slice(5),
        value: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        activeTimeMs: 0,
        messages: 0,
      })
      for (const row of modelGrid) {
        row.input.push(0)
        row.output.push(0)
        row.messages.push(0)
        row.total.push(0)
      }
      continue
    }
    grid.push(points[src]!)
    for (let mi = 0; mi < models.length; mi++) {
      const row = modelGrid[mi]!
      row.input.push(models[mi]!.input[src] ?? 0)
      row.output.push(models[mi]!.output[src] ?? 0)
      row.messages.push(models[mi]!.messages[src] ?? 0)
      row.total.push(models[mi]!.total[src] ?? 0)
    }
  }
  return { points: grid, models: modelGrid }
}

/** What the trends page is charting, and whether model detail describes it */
export interface TrendSource {
  kind: 'scan' | 'archive' | 'snapshots' | 'none'
  /** Charted day series, oldest first */
  points: DayPointVM[]
  /** Per-model rows aligned with `points`; empty unless `kind === 'scan'` */
  models: ModelDailySeriesVM[]
  /**
   * True only when `models` describes `points`.
   *
   * The per-model arrays are built from the scan alone, so a fallback source
   * must not offer a model filter or the split view: mapping scan-indexed rows
   * onto archive-indexed columns plotted a model's FIRST day at the window's
   * LAST label, and the model-filtered KPI row was summed from those same
   * misplaced rows.
   */
  hasModelDetail: boolean
}

/** Fallback points carry a total only; the split dimensions are genuinely absent */
function fallbackPoint(p: FallbackPoint): DayPointVM {
  return {
    day: p.day,
    label: p.label,
    value: p.value,
    input: p.value,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    activeTimeMs: 0,
    messages: 0,
  }
}

/**
 * True when the per-model rows can be placed on the day grid.
 *
 * `summarizeScan` always builds them at the series' full length, so a short row
 * means the two came from different series — the exact mismatch that plotted a
 * model's first day under the window's last label. Such rows are dropped rather
 * than zero-padded into a shape they never had.
 */
function modelsDescribePoints(
  points: readonly DayPointVM[],
  models: readonly ModelDailySeriesVM[],
): boolean {
  return (
    models.length > 0 &&
    models.every(
      (m) =>
        m.input.length === points.length &&
        m.output.length === points.length &&
        m.messages.length === points.length &&
        m.total.length === points.length,
    )
  )
}

/**
 * Pick the series the page charts, in the order it always used: the scan's own
 * daily series, then the local archive, then provider snapshots (an account
 * without local agent logs has nothing else, and without that fallback the
 * API-only mode sits on "gathering" placeholders forever).
 *
 * Returning the choice as data — rather than three inline branches — is what
 * lets `hasModelDetail` be structural: the model rows belong to the scan, and
 * no fallback can accidentally claim them.
 */
export function selectTrendSource(input: {
  scan: readonly DayPointVM[]
  models?: readonly ModelDailySeriesVM[]
  archive: readonly FallbackPoint[]
  snapshots: readonly FallbackPoint[]
}): TrendSource {
  if (input.scan.length >= 2) {
    const models = input.models ?? []
    const dense = densifySeries(input.scan, modelsDescribePoints(input.scan, models) ? models : [])
    return {
      kind: 'scan',
      points: dense.points,
      models: dense.models,
      hasModelDetail: dense.models.length > 0,
    }
  }
  if (input.archive.length >= 2) {
    const dense = densifySeries(input.archive.map(fallbackPoint))
    return { kind: 'archive', points: dense.points, models: [], hasModelDetail: false }
  }
  if (input.snapshots.length >= 2) {
    const dense = densifySeries(input.snapshots.map(fallbackPoint))
    return { kind: 'snapshots', points: dense.points, models: [], hasModelDetail: false }
  }
  return { kind: 'none', points: [], models: [], hasModelDetail: false }
}

/**
 * Recompute the day series from a model selection.
 *
 * A day is kept when ANY picked model was active on it; the day's totals are
 * then recomputed from those models alone, so the KPI row, the stacked bars and
 * the comparison chart all describe the same selection. Input is derived as
 * `total - output` and the cache split collapses, because the scan reports the
 * breakdown per day rather than per model — the caller surfaces that as an
 * unavailable hit rate instead of a misleading 0%.
 *
 * `models` must describe `points` (see {@link modelsDescribePoints}); callers
 * only reach this with rows taken from the same series.
 */
export function filterByModels(
  points: readonly DayPointVM[],
  models: readonly ModelDailySeriesVM[],
  picked: readonly string[],
): DayPointVM[] {
  if (picked.length === 0) return [...points]
  const pickedSet = new Set(picked)
  const rows = models.filter((m) => pickedSet.has(m.model))
  if (rows.length === 0) return []
  return points.map((day, i) => {
    let output = 0
    let messages = 0
    let total = 0
    for (const r of rows) {
      messages += r.messages[i] ?? 0
      output += r.output[i] ?? 0
      total += r.total[i] ?? 0
    }
    return { ...day, input: Math.max(0, total - output), output, cacheRead: 0, cacheWrite: 0, value: total, messages }
  })
}

/** One model's all-time cumulative row */
export interface CumulativeModelRow {
  model: string
  /**
   * Mode-aware total: every kind of token, or `input + output` when the caller
   * asked for the no-cache口径. The per-model rows carry both, so this column
   * follows the display mode; only the cache split itself stays day-level.
   */
  tokens: number
  output: number
  messages: number
  /** Share of {@link CumulativeVM.rowSum}, in percent */
  sharePct: number
}

/** The all-time block on the trends page, independent of the range selector */
export interface CumulativeVM {
  /** Mode-aware headline total, supplied by the caller */
  tokens: number
  /** Charted calendar days that carry any usage */
  activeDays: number
  /** First and last charted day, or null when nothing is charted */
  span: { from: string; to: string } | null
  /** Per-model all-time totals, largest first; empty without model detail */
  rows: CumulativeModelRow[]
  /**
   * Sum of `rows`, which is what the table's own total row shows.
   *
   * Kept separate from `tokens` because the two are not the same figure: the
   * headline counts every contribution, while a row exists only for entries
   * that carry a model id, so unattributable usage lands in one and not the
   * other.
   */
  rowSum: number
}

/**
 * Fold the charted series and the per-model rows into the all-time block.
 *
 * `points` and `models` must come from the same source (see
 * {@link selectTrendSource}); a fallback series has no model rows, and the
 * caller passes none.
 */
export function buildCumulative(
  points: readonly DayPointVM[],
  models: readonly ModelDailySeriesVM[],
  headlineTokens: number,
  mode: 'all' | 'no-cache',
): CumulativeVM {
  // `value` is the raw `totals.tokens`, which the scan documents as able to
  // drift from the breakdown, and a credits-billed day reports calls with no
  // token counters at all. A day counts as active when any of the three says
  // something happened — the same rule `summarizeScan` applies to a client row
  // (`AgentClientVM.exists`).
  let activeDays = 0
  for (const p of points) {
    if (p.value > 0 || p.messages > 0 || p.input + p.output + p.cacheRead + p.cacheWrite > 0) {
      activeDays += 1
    }
  }

  const first = points[0]
  const last = points[points.length - 1]
  const span = first && last ? { from: first.day ?? first.label, to: last.day ?? last.label } : null

  const rows: CumulativeModelRow[] = models
    .map((m) => {
      const output = m.output.reduce((s, v) => s + v, 0)
      const messages = m.messages.reduce((s, v) => s + v, 0)
      const tokens =
        mode === 'no-cache' ? m.input.reduce((s, v) => s + v, 0) + output : m.tokens
      return { model: m.model, tokens, output, messages, sharePct: 0 }
    })
    // A credits-billed agent reports zero token counters but real calls, and
    // the rest of the app still lists it; dropping it here would silently
    // remove usage. Only a row with no signal at all is noise.
    .filter((r) => r.tokens > 0 || r.messages > 0)
    .sort((a, b) => b.tokens - a.tokens)

  const rowSum = rows.reduce((s, r) => s + r.tokens, 0)
  for (const r of rows) r.sharePct = rowSum > 0 ? (r.tokens / rowSum) * 100 : 0

  return { tokens: headlineTokens, activeDays, span, rows, rowSum }
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
  /**
   * Session-active ms in the bucket, and the tok/s denominator.
   *
   * Only days whose clock is a possible duration are counted — see
   * {@link measurableActiveMs}.
   */
  activeTimeMs: number
  /**
   * Output tokens produced on the days `activeTimeMs` actually covers.
   *
   * The rate pairs this with `activeTimeMs`, so a day whose clock was dropped
   * contributes neither time nor output — counting its output against other
   * days' time would inflate the figure instead of losing it.
   */
  measuredOutput: number
  /** Message (call) count in the bucket */
  messages: number
  /** Weighted output speed of the bucket; null when no active time is known */
  tokPerSec: number | null
  /**
   * True when the bucket holds fewer days than the chosen width.
   *
   * Only the trailing bucket can be short. Its bar is naturally lower than its
   * neighbours, which reads as a drop-off unless the UI says otherwise — so the
   * flag travels with the data rather than being re-derived by each consumer.
   */
  partial: boolean
}

/** Widest column count the chart stays readable at */
const MAX_BUCKET_COLUMNS = 30

/** Candidate column widths, in calendar days, finest first */
const BUCKET_WIDTHS = [1, 7, 14, 30, 90, 180, 365] as const

/**
 * Longest span the calendar grid will expand to.
 *
 * Derived from the bucketing budget so the two cannot drift: the coarsest
 * column is {@link BUCKET_WIDTHS}'s last entry, and {@link MAX_BUCKET_COLUMNS}
 * of them is the widest series the chart can still draw. A longer span keeps
 * the sparse series — coarse, but bounded.
 */
const MAX_GRID_DAYS = MAX_BUCKET_COLUMNS * BUCKET_WIDTHS[BUCKET_WIDTHS.length - 1]!

/**
 * Finest column width whose column count stays within {@link MAX_BUCKET_COLUMNS}.
 *
 * The width is derived from the SPAN, never from the row count: on a sparse
 * series "7 rows" meant anything from 3 to 98 days, which made one column
 * incomparable with the next.
 */
export function bucketWidthDays(dayCount: number): number {
  for (const width of BUCKET_WIDTHS) {
    if (Math.ceil(dayCount / width) <= MAX_BUCKET_COLUMNS) return width
  }
  return BUCKET_WIDTHS[BUCKET_WIDTHS.length - 1]!
}

/**
 * Bucket a dense day series into chart columns.
 *
 * `points` must be contiguous by calendar day (see {@link densifySeries}): a
 * 30-day window keeps daily columns, a quarter steps up to weeks, a multi-year
 * history to fortnights. The trailing bucket is often shorter than the others
 * and is reported as-is rather than padded with zeros that would fake a
 * drop-off; `partial` marks it so the UI can say so.
 */
export function bucketize(points: DayPointVM[]): TrendBucket[] {
  const width = bucketWidthDays(points.length)
  const out: TrendBucket[] = []
  for (let i = 0; i < points.length; i += width) {
    const chunk = points.slice(i, i + width)
    const first = chunk[0]!
    const last = chunk[chunk.length - 1]!
    const cacheRead = chunk.reduce((s, p) => s + p.cacheRead, 0)
    const input = chunk.reduce((s, p) => s + p.input, 0)
    const output = chunk.reduce((s, p) => s + p.output, 0)
    const cacheWrite = chunk.reduce((s, p) => s + p.cacheWrite, 0)
    const messages = chunk.reduce((s, p) => s + p.messages, 0)

    // A calendar day cannot contain more than a day of elapsed time. Some
    // upstream readers report a session span that outlives the day it is filed
    // under: on a real scan 30 of 211 days exceeded 24 h, the worst by 100x
    // (2471 h on a day with 6 calls, one client). Such a value is not a
    // duration, and counting it took 97% of the denominator and dragged the
    // headline from ~35 tok/s to 1.06. Token and call totals keep every day;
    // only the rate drops these.
    const activeTimeMs = chunk.reduce((s, p) => s + measurableActiveMsOf(p), 0)
    const measuredOutput = chunk.reduce((s, p) => s + (measurableActiveMsOf(p) > 0 ? p.output : 0), 0)
    out.push({
      // The axis takes the short form: a range-quoted label is 11 characters and
      // collides with its neighbours even after thinning. The full span stays
      // available for the tooltip, which has room for it.
      label: first.label,
      rangeLabel: width === 1 || chunk.length === 1 ? first.label : `${first.label}–${last.label}`,
      cacheRead,
      input,
      output,
      total: input + output + cacheRead + cacheWrite,
      activeTimeMs,
      measuredOutput,
      messages,
      tokPerSec: activeTimeMs > 0 ? measuredOutput / (activeTimeMs / 1000) : null,
      partial: chunk.length < width,
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
   *
   * Deliberately NOT "model generation speed": session-active time includes
   * thinking, tool calls and idle gaps inside a session, so the figure sits
   * below a provider-reported tok/s. It is also not the raw sum of the scan's
   * `activeTimeMs` — days whose clock cannot be a duration are left out (see
   * {@link measurableActiveMs}). Null when no usable active time was recorded.
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
  let measuredOutput = 0
  for (const b of buckets) {
    input += b.input
    output += b.output
    cacheRead += b.cacheRead
    messages += b.messages
    activeTimeMs += b.activeTimeMs
    measuredOutput += b.measuredOutput
  }
  const promptSide = cacheRead + input
  return {
    tokens: mode === 'no-cache' ? input + output : buckets.reduce((s, b) => s + b.total, 0),
    input,
    output,
    cacheRead,
    messages,
    hitRatePct: promptSide > 0 ? (cacheRead / promptSide) * 100 : 0,
    weightedTokPerSec: activeTimeMs > 0 ? measuredOutput / (activeTimeMs / 1000) : null,
  }
}

/** One model row of the comparison chart */
export interface ModelCompareRow {
  model: string
  /** Palette entry for this model's canonical rank, so it matches the chart above */
  color: string
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
        input: [...m.input],
        output: [...m.output],
        messages: [...m.messages],
        total: [...m.total],
      })
      continue
    }
    merged.tokens += m.tokens
    for (let i = 0; i < merged.total.length; i++) {
      merged.input[i] = (merged.input[i] ?? 0) + (m.input[i] ?? 0)
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
  slots: Map<string, number>,
): ModelCompareRow[] {
  const from = Math.max(0, activeTimePerDay.length - dayCount)
  return models
    .map((m) => {
      let tokens = 0
      let output = 0
      let messages = 0
      let activeTimeMs = 0
      let measuredOutput = 0
      const start = Math.max(0, m.output.length - dayCount)
      for (let i = start; i < m.output.length; i++) {
        const dayCalls = m.messages[i] ?? 0
        tokens += m.total[i] ?? 0
        output += m.output[i] ?? 0
        messages += dayCalls
        const dayIndex = from + (i - start)
        const dayActive = measurableActiveMs(activeTimePerDay[dayIndex] ?? 0)
        const totalDayCalls = dayMessages[dayIndex] ?? 0
        // Only attribute time when both sides are known; a day with active
        // time but no recorded calls contributes nothing (rather than the
        // whole day) so one model cannot absorb an entire session's time.
        if (dayCalls > 0 && totalDayCalls > 0) {
          activeTimeMs += dayActive * (dayCalls / totalDayCalls)
          // Same pairing as the bucket: only days with a usable clock feed the
          // rate, so its numerator and denominator describe the same days.
          if (dayActive > 0) measuredOutput += m.output[i] ?? 0
        }
      }
      return {
        model: m.model,
        color: modelColor(slots.get(m.model) ?? 0),
        tokens,
        output,
        messages,
        activeTimeMs,
        tokPerSec: activeTimeMs > 0 ? measuredOutput / (activeTimeMs / 1000) : null,
      }
    })
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
}

/**
 * Fixed categorical palette for model series.
 *
 * The slot comes from `modelSlots`, never from a model's position in the list
 * currently being rendered: the filter chips, the split legend and the
 * comparison rows order models differently, so a positional slot gave one model
 * several colours on one screen and repainted every bar when the comparison
 * metric changed.
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

/**
 * Palette slot per model, for every list on the page.
 *
 * One slot per model, so a model wears one colour in the filter chips, the split
 * legend and the comparison rows alike — a colour taken from a list's own order
 * gave one model several colours at once, and repainted the comparison whenever
 * its metric changed.
 *
 * The models the plot actually draws are placed first, in canonical order, so
 * the at-most-eight curves on that chart are eight different colours. That
 * ordering matters because the palette has exactly eight entries: the split
 * chart picks its series by OUTPUT while ranks come from total tokens, so a
 * drawn model ranked ninth would otherwise wrap onto a colour another drawn
 * curve already holds. Everyone else keeps their canonical rank modulo the
 * palette, where a repeat is unavoidable — the page lists far more models than
 * the palette has entries — and harmless, since those models are not plotted
 * together.
 */
export function modelSlots(
  ranked: readonly { model: string }[],
  drawn: readonly { model: string }[],
  paletteSize = MODEL_PALETTE.length,
): Map<string, number> {
  const canonical = new Map<string, number>()
  for (const m of ranked) if (!canonical.has(m.model)) canonical.set(m.model, canonical.size)

  const slots = new Map<string, number>()
  const drawnOrdered = [...new Set(drawn.map((m) => m.model))].sort(
    (a, b) => (canonical.get(a) ?? 0) - (canonical.get(b) ?? 0),
  )
  for (const model of drawnOrdered) {
    if (slots.size >= paletteSize) break
    slots.set(model, slots.size)
  }
  for (const [model, rank] of canonical) {
    if (!slots.has(model)) slots.set(model, rank % paletteSize)
  }
  return slots
}

/**
 * Palette entry for a slot.
 *
 * Wraps past the end: `modelSlots` hands the drawn models distinct slots, but a
 * list longer than the palette still repeats entries, which is unavoidable.
 */
export function modelColor(slot: number): string {
  const size = MODEL_PALETTE.length
  return MODEL_PALETTE[((slot % size) + size) % size]!
}

/**
 * Human-readable model label.
 *
 * tokscale emits some model ids percent-encoded (non-ASCII provider names are
 * URL-escaped in its `models` list), which would render as an unreadable
 * `%e6%96%b0...` in the UI — decode those, keeping the tail when decoding
 * fails. The provider prefix is deliberately left in place here; dropping it is
 * {@link modelBasename}'s job, and callers that want the short form use that.
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
