/**
 * Shared geometry for the hand-built SVG charts.
 *
 * Every chart draws into the same fixed-width viewBox and needs the same three
 * primitives: rounded tick values, compact path data and a smooth curve through
 * the points. They live here rather than as a private copy per component so the
 * charts stay visually interchangeable — a change to the smoothing or the tick
 * rounding lands in all of them at once.
 */

/** Fixed viewBox width shared by every chart; each SVG scales via width="100%" */
export const CHART_W = 560

/** Approximate number of horizontal grid lines */
export const TICK_COUNT = 4

/** Maximum x-axis labels drawn before they are evenly thinned out */
export const MAX_X_LABELS = 7

/** A point in viewBox coordinates */
export interface PlotCoord {
  x: number
  y: number
}

/** Round to 2 decimals: keeps path data compact and stable across renders */
export function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Build "nice" ticks (steps of 1/2/5 x 10^k) from 0 up to a rounded max covering
 * `max`. A non-positive or non-finite max falls back to 1 so callers always get
 * a usable axis — `Infinity` and `NaN` both fail the comparison, and an infinite
 * max would otherwise divide into a zero step, returning no ticks at all.
 */
export function niceTicks(max: number): number[] {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1
  const rawStep = safeMax / TICK_COUNT
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  const step = factor * magnitude
  const steps = Math.ceil(safeMax / step)
  return Array.from({ length: steps + 1 }, (_, i) => i * step)
}

/**
 * Evenly thin a run of `count` labels down to at most `max`, always keeping the
 * first and the last. A dense axis reads as a smear of overlapping text, and the
 * hover tooltip still carries every value, so a dropped label costs nothing.
 */
export function labelIndexes(count: number, max = MAX_X_LABELS): number[] {
  if (count <= 0) return []
  if (count <= max || max < 2) return Array.from({ length: count }, (_, i) => i)
  const out = new Set<number>([0, count - 1])
  for (let k = 1; k < max - 1; k++) {
    out.add(Math.round((k * (count - 1)) / (max - 1)))
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Monotone cubic interpolation through the points, emitted as cubic Bezier
 * segments.
 *
 * The obvious spline here is Catmull-Rom, and it is the wrong one: it
 * overshoots. Between two points sitting near the baseline it swings below them,
 * so a run of non-negative daily totals renders as a curve that goes negative —
 * a value the data cannot contain, on an axis with no room for it. Limiting the
 * tangents (Fritsch–Carlson, zeroed at every local extremum) keeps each segment
 * inside the range of the two points it joins, which is what a chart of counts
 * needs. Degenerate runs (< 3 points) fall back to straight lines.
 */
export function smoothPath(coords: PlotCoord[]): string {
  if (coords.length === 0) return ''
  if (coords.length < 3) {
    return coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${r2(c.x)} ${r2(c.y)}`).join(' ')
  }

  const n = coords.length

  // Secant slope of each interval
  const secants: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = coords[i + 1]!.x - coords[i]!.x
    secants.push(dx === 0 ? 0 : (coords[i + 1]!.y - coords[i]!.y) / dx)
  }

  // Tangents. The ends take their own secant, which keeps the first and last
  // segment monotone as long as the interior tangents below are limited.
  const tangents: number[] = new Array(n)
  tangents[0] = secants[0]!
  tangents[n - 1] = secants[n - 2]!
  for (let i = 1; i < n - 1; i++) {
    const s0 = secants[i - 1]!
    const s1 = secants[i]!
    const h0 = coords[i]!.x - coords[i - 1]!.x
    const h1 = coords[i + 1]!.x - coords[i]!.x
    // Slope a plain spline would use (the secant average, spacing-weighted),
    // then pulled back to the smallest of the three so the curve cannot leave
    // the data. Opposite-signed secants mean a local extremum: the tangent is
    // zeroed there, which is exactly what stops the overshoot.
    const average = h0 + h1 === 0 ? 0 : (s0 * h1 + s1 * h0) / (h0 + h1)
    const magnitude = Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(average))
    tangents[i] = (Math.sign(s0) + Math.sign(s1)) * magnitude
  }

  let d = `M${r2(coords[0]!.x)} ${r2(coords[0]!.y)}`
  for (let i = 0; i < n - 1; i++) {
    const p1 = coords[i]!
    const p2 = coords[i + 1]!
    const h = p2.x - p1.x
    d += ` C${r2(p1.x + h / 3)} ${r2(p1.y + (tangents[i]! * h) / 3)}, ${r2(p2.x - h / 3)} ${r2(p2.y - (tangents[i + 1]! * h) / 3)}, ${r2(p2.x)} ${r2(p2.y)}`
  }
  return d
}

/**
 * A bar with only its value end rounded.
 *
 * `<rect rx>` rounds all four corners, which detaches the bar from its baseline
 * and reads as a floating pill; a bar is anchored to its axis, so the baseline
 * end has to stay square. Zero-height bars return an empty path so callers can
 * render unconditionally.
 */
export function barPath(x: number, y: number, w: number, h: number, radius = 3): string {
  if (w <= 0 || h <= 0) return ''
  const r = Math.max(0, Math.min(radius, w / 2, h))
  const bottom = y + h
  return [
    `M${r2(x)} ${r2(bottom)}`,
    `L${r2(x)} ${r2(y + r)}`,
    `Q${r2(x)} ${r2(y)} ${r2(x + r)} ${r2(y)}`,
    `L${r2(x + w - r)} ${r2(y)}`,
    `Q${r2(x + w)} ${r2(y)} ${r2(x + w)} ${r2(y + r)}`,
    `L${r2(x + w)} ${r2(bottom)}`,
    'Z',
  ].join(' ')
}
