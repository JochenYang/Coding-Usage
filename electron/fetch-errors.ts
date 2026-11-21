/**
 * AbortSignal.timeout rejects with a DOMException named `TimeoutError`, while
 * an explicit `AbortController.abort()` surfaces as `AbortError`. Probes that
 * mean "the deadline passed" must treat both as a timeout — classifying the
 * signal-timeout as a generic network error hides the most diagnostic reason a
 * card can show. (Same rule as weixin-session.ts's ilink abort check.)
 */
export function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : null
  return name === 'TimeoutError' || name === 'AbortError'
}
