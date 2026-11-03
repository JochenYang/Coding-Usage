import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '@/lib/ease'
import { moveKey } from '@/lib/plan-order'

/**
 * Grid of cards the user can drag into their own order.
 *
 * A dedicated sortable library was not worth a dependency for one screen, and
 * the popular `Reorder` primitive assumes a single axis, which a 2/3-column
 * grid is not. What this does instead:
 *
 * - The dragged card follows the pointer through motion values; the other cards
 *   reflow with a short layout spring, so the grid animates instead of jumping.
 * - The dragged card itself is never layout-animated. Its own grid box already
 *   moves to the new slot, so a second animated transform on top of x/y put it a
 *   frame behind the cursor and let it overlap its neighbour.
 * - Pointer moves are listened for on the window, not on the card. Reordering
 *   moves the card's DOM node, and moving a node silently releases pointer
 *   capture — the card then froze mid-drag while the cursor kept going.
 * - The offset is recomputed from the card's layout position each frame rather
 *   than accumulated, so a reorder can never leave the card offset from the
 *   cursor.
 * - Hit-testing uses the grid cells measured in layout coordinates. Querying the
 *   element under the pointer instead made the list thrash between two
 *   neighbours, because after a swap the dragged card itself sits under it.
 * - The whole card is the handle (plan cards have no controls inside), but any
 *   [data-no-drag] child is excluded.
 * - Keyboard: a focused card moves with the arrow keys, the only way to reorder
 *   without a pointer.
 */

export interface SortableItem {
  key: string
}

interface SortableGridProps<T extends SortableItem> {
  items: T[]
  renderItem: (item: T) => ReactNode
  onOrderChange: (keys: string[]) => void
  /** Announced when a keyboard move lands, so the position change is not silent */
  announce?: (position: number, total: number) => string
  className?: string
  ariaLabel: string
}

/** Pointer travel before a press becomes a drag; below it the press is a click */
const DRAG_THRESHOLD_PX = 5

interface SlotRect {
  left: number
  top: number
  right: number
  bottom: number
}

export function SortableGrid<T extends SortableItem>({
  items,
  renderItem,
  onOrderChange,
  announce,
  className,
  ariaLabel,
}: SortableGridProps<T>) {
  const reduce = useReducedMotion()
  const [order, setOrder] = useState<string[]>(() => items.map((item) => item.key))
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const orderRef = useRef(order)
  orderRef.current = order
  /** Pressed but not yet past the drag threshold */
  const armed = useRef<string | null>(null)
  const dragging = useRef<string | null>(null)
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const pointer = useRef({ x: 0, y: 0 })
  /** Where inside the card the press landed, so the card does not snap to centre */
  const grab = useRef({ x: 0, y: 0 })
  const press = useRef({ x: 0, y: 0 })
  const slots = useRef<SlotRect[]>([])
  const x = useMotionValue(0)
  const y = useMotionValue(0)

  const commit = useRef(onOrderChange)
  commit.current = onOrderChange

  // New cards, deletions and filter changes arrive as a new key list. Adopting
  // it mid-drag would abort the gesture, so it waits for the drop.
  const signature = items.map((item) => item.key).join('|')
  useEffect(() => {
    if (dragging.current) return
    setOrder((prev) => (prev.join('|') === signature ? prev : items.map((item) => item.key)))
  }, [signature, items])

  /**
   * Screen box of an element ignoring its own transform.
   *
   * offsetLeft/offsetTop are unsuitable: they are measured against offsetParent
   * and do not account for the scrolling of that ancestor, so inside the
   * scrollable page body they were off by the scroll offset — the card jumped
   * straight up (or off to the side) the moment a drag began. The bounding rect
   * is viewport-based and correct under scroll; subtracting the element's own
   * translate removes the drag/animation transform so the result is its resting
   * box.
   */
  const staticRect = (el: HTMLElement): SlotRect => {
    const rect = el.getBoundingClientRect()
    let dx = 0
    let dy = 0
    const transform = getComputedStyle(el).transform
    if (transform && transform !== 'none') {
      try {
        const matrix = new DOMMatrixReadOnly(transform)
        dx = matrix.m41
        dy = matrix.m42
      } catch {
        // A malformed matrix is not worth failing a drag over; use the raw rect.
      }
    }
    return {
      left: rect.left - dx,
      top: rect.top - dy,
      right: rect.right - dx,
      bottom: rect.bottom - dy,
    }
  }

  const measureSlots = useCallback((): SlotRect[] => {
    return orderRef.current.map((slotKey) => {
      const el = nodes.current.get(slotKey)
      return el ? staticRect(el) : { left: 0, top: 0, right: 0, bottom: 0 }
    })
  }, [])

  /** Place the dragged card so the grabbed point stays under the pointer. */
  const syncTransform = useCallback(() => {
    const key = dragging.current
    if (!key) return
    const el = nodes.current.get(key)
    if (!el) return
    const base = staticRect(el)
    x.set(pointer.current.x - grab.current.x - base.left)
    y.set(pointer.current.y - grab.current.y - base.top)
  }, [x, y])

  const slotIndexAt = (clientX: number, clientY: number): number => {
    const list = slots.current
    let nearest = -1
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < list.length; index++) {
      const slot = list[index]
      if (clientX >= slot.left && clientX <= slot.right && clientY >= slot.top && clientY <= slot.bottom) {
        return index
      }
      const dx = clientX - (slot.left + slot.right) / 2
      const dy = clientY - (slot.top + slot.bottom) / 2
      const distance = Math.hypot(dx, dy)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = index
      }
    }
    // The gaps between cards belong to the closest cell; further than a cell
    // away is treated as "not over the grid".
    return nearestDistance <= 160 ? nearest : -1
  }

  const onWindowMove = useCallback(
    (event: PointerEvent) => {
      const key = armed.current
      if (!key) return
      if (!dragging.current) {
        const dx = event.clientX - press.current.x
        const dy = event.clientY - press.current.y
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
        dragging.current = key
        setDraggingKey(key)
        const rect = nodes.current.get(key)?.getBoundingClientRect()
        grab.current = {
          x: press.current.x - (rect?.left ?? 0),
          y: press.current.y - (rect?.top ?? 0),
        }
        slots.current = measureSlots()
      }
      pointer.current = { x: event.clientX, y: event.clientY }
      const target = slotIndexAt(event.clientX, event.clientY)
      if (target >= 0) {
        setOrder((prev) => {
          const from = prev.indexOf(key)
          if (from < 0 || from === target) return prev
          const next = moveKey(prev, from, target)
          orderRef.current = next
          return next
        })
      }
      syncTransform()
    },
    [measureSlots, syncTransform],
  )

  const finish = useCallback(() => {
    armed.current = null
    const wasDragging = dragging.current !== null
    dragging.current = null
    setDraggingKey(null)
    slots.current = []
    window.removeEventListener('pointermove', onWindowMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    window.removeEventListener('blur', finish)
    if (!wasDragging) return
    if (reduce) {
      x.set(0)
      y.set(0)
    } else {
      void animate(x, 0, { duration: 0.16, ease: EASE_OUT })
      void animate(y, 0, { duration: 0.16, ease: EASE_OUT })
    }
    commit.current(orderRef.current)
  }, [onWindowMove, reduce, x, y])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, key: string) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    // A press is a drag candidate, not a text selection.
    event.preventDefault()
    armed.current = key
    press.current = { x: event.clientX, y: event.clientY }
    pointer.current = { x: event.clientX, y: event.clientY }
    window.addEventListener('pointermove', onWindowMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  // Unmounting mid-gesture must not leave window listeners behind.
  useEffect(() => () => finish(), [finish])

  /**
   * After a reorder the card's grid box has moved. Recompute its transform from
   * the new layout position (not a delta), and refresh the cell boxes so a drag
   * across rows of differing heights still hits the right cell.
   */
  useLayoutEffect(() => {
    if (!dragging.current) return
    slots.current = measureSlots()
    syncTransform()
  }, [order, measureSlots, syncTransform])

  /** Keyboard reorder: arrows move the focused card one slot at a time */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, key: string) => {
    const step =
      event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : 0
    if (step === 0) return
    event.preventDefault()
    const from = orderRef.current.indexOf(key)
    const to = from + step
    if (from < 0 || to < 0 || to >= orderRef.current.length) return
    const next = moveKey(orderRef.current, from, to)
    orderRef.current = next
    setOrder(next)
    commit.current(next)
    if (announce) setMessage(announce(to + 1, next.length))
    requestAnimationFrame(() => nodes.current.get(key)?.focus())
  }

  const byKey = new Map(items.map((item) => [item.key, item]))
  const ordered = order
    .map((key) => byKey.get(key))
    .filter((item): item is T => item !== undefined)
  const isAnyDragging = draggingKey !== null

  return (
    <>
      <div role="list" aria-label={ariaLabel} aria-busy={isAnyDragging} className={className}>
        {ordered.map((item) => {
          const isDragging = item.key === draggingKey
          return (
            <motion.div
              key={item.key}
              role="listitem"
              tabIndex={0}
              data-sort-key={item.key}
              ref={(node: HTMLDivElement | null) => {
                if (node) nodes.current.set(item.key, node)
                else nodes.current.delete(item.key)
              }}
              // "position" (not the default "size") keeps the reflow honest when
              // cards differ in height; animating size as well made the grid wobble.
              layout={reduce || isDragging ? false : 'position'}
              transition={{ type: 'spring', duration: reduce ? 0 : 0.22, bounce: 0 }}
              style={{
                x: isDragging ? x : 0,
                y: isDragging ? y : 0,
                zIndex: isDragging ? 30 : undefined,
                position: 'relative',
                // While dragging, the card must not be under the pointer: the
                // layout below lifts it visually, and hit-testing it would also
                // fight the cell math. Window-level pointer listeners mean no
                // event handling depends on this element.
                pointerEvents: isDragging ? 'none' : undefined,
                boxShadow: isDragging ? '0 20px 45px -20px rgb(0 0 0 / 0.5)' : undefined,
                cursor: isDragging ? 'grabbing' : 'grab',
                touchAction: isDragging ? 'none' : undefined,
                willChange: isDragging ? 'transform' : undefined,
              }}
              onPointerDown={(event) => onPointerDown(event, item.key)}
              onKeyDown={(event) => onKeyDown(event, item.key)}
              className={
                isDragging
                  ? 'select-none rounded-2xl ring-2 ring-primary/40'
                  : // Hover feedback must not use transform: the same y is the drag
                    // offset, and a hover animation on it overrode the drag every
                    // frame (the card crept back to the cursor instead of following
                    // it). A shadow shift says "draggable" without touching transform.
                    'rounded-2xl transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'
              }
            >
              {renderItem(item)}
            </motion.div>
          )
        })}
      </div>
      {/* Screen readers get the new position after a keyboard move.
          `sr-only` is absolute, and the page body is not a positioned
          ancestor, so leaving it in flow here anchored it to the initial
          containing block past the viewport — that is what put a second
          scrollbar on the document next to the page's own. Fixed keeps it out
          of layout entirely while remaining announced. */}
      <div aria-live="polite" className="sr-only" style={{ position: 'fixed' }}>
        {message}
      </div>
    </>
  )
}
