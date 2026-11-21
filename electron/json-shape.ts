/**
 * Store-boundary helpers shared by the quota probes. `quota-cache.json`
 * persists `QuotaOutcome.body` verbatim under a "normalized payload only"
 * declaration (quota-store.ts), so a probe must narrow the vendor response to
 * the fields the cards actually parse before returning it — the raw response
 * of an account endpoint can carry account identifiers that are neither usage
 * numbers nor something this app should write to disk. Picking also fixes the
 * body's shape at one place: a field the renderer cannot read is dropped on
 * purpose, never forwarded in hope.
 */

/** A plain (non-array, non-null) object member, or null */
export function objOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Copy the listed members (when present) into a fresh object, verbatim */
export function pickMembers(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}
