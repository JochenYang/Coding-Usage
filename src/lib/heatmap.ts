/**
 * Calendar-heatmap data builder (GitHub-contributions style). Pure: given
 * sparse per-day values it returns a fixed week-column grid with zero-filled
 * gaps, Monday-first rows, and 0-4 intensity levels relative to the window
 * maximum. Rendering lives in components/charts/Heatmap.
 */

export interface HeatDay {
  /** Local calendar date key consumed by the grid (YYYY-MM-DD) */
  day: string
  value: number
}

export interface HeatCell {
  /** Full date key; null for padding/future slots that render nothing */
  day: string | null
  value: number
  /** 0 = none, 1-4 = quartiles toward the window maximum */
  level: 0 | 1 | 2 | 3 | 4
  /** Tooltip override (e.g. a week range); defaults to the day key */
  tip?: string
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

function levelOf(value: number, max: number): HeatCell['level'] {
  if (!(value > 0) || !(max > 0)) return 0
  return (1 + Math.min(3, Math.floor((4 * value) / max))) as HeatCell['level']
}

/**
 * Build `weeks` Monday-first columns ending today (oldest first). Days
 * without data read as 0; slots after today render as null. Monday-first
 * matches the work-week reading order of coding activity.
 */
export function buildHeatmapCells(days: HeatDay[], weeks: number): HeatCell[][] {
  const byDay = new Map<string, number>()
  for (const d of days) {
    if (d.day && d.value > 0) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.value)
  }
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayKey = dayKey(today)
  // Oldest visible date, then pad back to Monday so every column is full
  const start = new Date(today)
  start.setDate(start.getDate() - (weeks * 7 - 1))
  const lead = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - lead)

  const max = Math.max(0, ...[...byDay.values()])
  const cols: HeatCell[][] = []
  const cursor = new Date(start)
  while (dayKey(cursor) <= todayKey) {
    const col: HeatCell[] = []
    for (let r = 0; r < 7; r++) {
      const key = dayKey(cursor)
      if (key > todayKey) {
        col.push({ day: null, value: 0, level: 0 })
      } else {
        const value = byDay.get(key) ?? 0
        col.push({ day: key, value, level: levelOf(value, max) })
      }
      cursor.setDate(cursor.getDate() + 1)
    }
    cols.push(col)
  }
  // Monday padding can add one partial leading column — keep it (GitHub
  // renders the same ragged edge) so no real day is ever dropped
  return cols
}

/**
 * Weekly values on the same 7-row wall: every cell in a column carries its
 * week total (same value/level/tip across the column's 7 rows), so the grid
 * keeps one shape across modes and hovering any cell reports the week.
 */
export function toWeeklyCells(cells: HeatCell[][]): HeatCell[][] {
  const sums = cells.map((col) =>
    col.reduce((s, c) => s + (c.day ? c.value : 0), 0),
  )
  const max = Math.max(0, ...sums)
  return cells.map((col, i) => {
    const real = col.filter((c) => c.day !== null)
    if (real.length === 0) return col
    const first = (real[0].day ?? '') as string
    const last = (real[real.length - 1].day ?? '') as string
    const value = sums[i]
    return col.map((c) =>
      c.day === null ? c : { ...c, value, level: levelOf(value, max), tip: `${first} ~ ${last}` },
    )
  })
}

/** Running totals in reading order (growth ramp toward the final total) */
export function toCumulativeCells(cells: HeatCell[][]): HeatCell[][] {
  const flat = cells.flat().filter((c) => c.day !== null)
  const total = flat.reduce((s, c) => s + c.value, 0)
  let run = 0
  const levelByDay = new Map<string, HeatCell['level']>()
  const valueByDay = new Map<string, number>()
  for (const c of flat) {
    run += c.value
    if (c.day) {
      valueByDay.set(c.day, run)
      levelByDay.set(c.day, levelOf(run, total))
    }
  }
  return cells.map((col) =>
    col.map((c) =>
      c.day === null
        ? c
        : { ...c, value: valueByDay.get(c.day) ?? 0, level: levelByDay.get(c.day) ?? 0 },
    ),
  )
}
