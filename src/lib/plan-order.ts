/**
 * Plan-card ordering helpers.
 *
 * The persisted order is a flat list of card keys (`providerId:accountIndex`-
 * style). Accounts come and go, filters hide parts of the grid, and an order
 * saved by one version must not swallow cards added by another, so every read
 * degrades to "saved keys first, the rest in their natural order".
 */

export function applyPlanOrder<T extends { key: string }>(
  cards: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...cards]
  const rank = new Map(order.map((key, index) => [key, index]))
  return [...cards].sort((a, b) => {
    const ra = rank.get(a.key)
    const rb = rank.get(b.key)
    // Unknown keys keep their incoming (natural) order and stay behind the
    // known ones: a stable sort leaves their relative sequence untouched.
    if (ra == null && rb == null) return 0
    if (ra == null) return 1
    if (rb == null) return -1
    return ra - rb
  })
}

/**
 * Re-insert a drag result into the full order.
 *
 * A filtered grid only shows part of the cards; dragging must reorder those
 * among themselves without disturbing the hidden ones, so the visible keys take
 * back the slots that visible keys occupied before.
 */
export function mergeVisibleOrder(fullOrder: readonly string[], visibleOrder: readonly string[]): string[] {
  const visible = new Set(visibleOrder)
  let cursor = 0
  return fullOrder.map((key) => (visible.has(key) ? visibleOrder[cursor++] : key))
}

/** Move one key to another index; returns a new array (no-op stays identical). */
export function moveKey(order: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) {
    return [...order]
  }
  const next = [...order]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
