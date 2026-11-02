import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { EASE_OUT } from '@/lib/ease'
import { cn } from '@/lib/cn'

/**
 * Modeled on beui.dev/components/blocks/dynamic-island: an iOS-style pill
 * that morphs between live-activity views with a bouncy shell resize and
 * blur crossfades. The shell animates real width/height (not transforms), so
 * slots are never scale-distorted; the constant radius is clamped by the
 * browser to half the shell height, which makes the pill-to-rounded-rect
 * morph fall out of the resize for free.
 *
 * Presence lives here rather than in the caller. `open` keeps the shell
 * mounted while it collapses back into the pill and fades, and
 * `onExitComplete` reports the end of that collapse so a host window can hide
 * only once the island is gone. The shell mounts at the pill size (via
 * `initial`) and springs to the measured content, so an island that is already
 * open on its first commit still blooms instead of appearing at full size.
 */

type IslandContextValue = {
  view: string | null
}

const IslandContext = createContext<IslandContextValue | null>(null)

// One glide out of the pill with a light overshoot. A heavier bounce reads as a
// pop rather than a morph, and Apple's island settles with barely any rebound.
const SHELL_SPRING = { type: 'spring', duration: 0.46, bounce: 0.22 } as const

// Fade-out curve for the collapse: slow at the start holds the words for the
// first frames, then drops them quickly instead of lingering half-visible.
const EASE_IN = [0.4, 0, 1, 1] as const

// The collapse uses the same physics, slightly faster and almost critically
// damped: shrinking *and* fading at once, so it reads as the same gesture
// played backwards rather than a second, unrelated animation.
// Exported in milliseconds: the overlay window must not hide before it ends.
export const ISLAND_COLLAPSE_MS = 280
const SHELL_EXIT_SPRING = { type: 'spring', duration: ISLAND_COLLAPSE_MS / 1000, bounce: 0.04 } as const

// Opacity rides its own short curve in both directions. On the way in the pill
// is visible from the first frame, so the gesture starts as a shape rather than
// a light switch; on the way out the fade is held back until the shrink is well
// under way, otherwise the box empties while it is still large.
const ENTER_FADE = { duration: 0.16, ease: EASE_OUT } as const
const EXIT_FADE = { duration: 0.18, delay: 0.06, ease: EASE_IN } as const

// Content is a short tween rather than a spring: it has to land *before* the
// shell finishes growing, and a spring started late (the previous 0.1s delay +
// 0.45s spring) was still fading text in after the shape had settled, which is
// what made the open feel like two separate steps.
const CONTENT_ENTER = { duration: 0.16, ease: EASE_OUT, delay: 0.08 } as const
// The shell clips its content, so the words must be gone before the pill
// narrows past them: a long fade leaves a chopped line visible for 100ms+, and
// the collapse itself is carried by the shape from there.
const CONTENT_EXIT_MS = 110

// Constant radius — never animated. The browser clamps it to half the shell
// height, so the pill-to-rounded-rect morph comes for free.
const RADIUS = 32

// iPhone pill dimensions. Also the shell's mount and collapse size: opening
// springs out of it, closing shrinks back into it.
const PILL_WIDTH = 126
const PILL_HEIGHT = 37

/** Tracks the natural size of the content so the shell can spring to it. */
function useContentSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  // Synchronous mount measure: the shell must own explicit dimensions before
  // the first interaction. ResizeObserver fires async after mount — a quick
  // first press could beat it, leaving the shell auto-sized so the view
  // snapped open instead of springing.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setSize({ width: el.offsetWidth, height: el.offsetHeight })
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      // An exiting slot is out of flow, so the sizer momentarily measures 0.
      // Recording that would retarget the shell to nothing mid-collapse and
      // make a re-opened island spring out of a zero-size box.
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return
      setSize({ width: el.offsetWidth, height: el.offsetHeight })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}

function Slot({
  keyId,
  children,
  className,
  instant,
}: {
  keyId: string
  children: ReactNode
  className?: string
  /** Render at the animate state with no enter transition. */
  instant?: boolean
}) {
  const reduce = useReducedMotion()
  // Exit is deliberately short: the shell clips its content, so words that
  // linger get chopped mid-line as the pill narrows. The shape carries the
  // collapse and the text simply gets out of the way first. No blur either — a
  // per-frame filter on an always-on-top transparent window is the most
  // expensive thing this component could ask the compositor for.
  const exit = instant
    ? { opacity: 0, transition: { duration: 0 } }
    : reduce
      ? { opacity: 0, transition: { duration: 0.12 } }
      : {
          opacity: 0,
          scale: 0.92,
          transition: { duration: CONTENT_EXIT_MS / 1000, ease: EASE_IN },
        }
  // Entry lands before the shell finishes growing, so the open reads as one
  // motion instead of "shape first, words later". The pill itself enters
  // instantly: it only appears while the shell is collapsing.
  const transition = instant
    ? { duration: 0 }
    : reduce
      ? { duration: 0.15 }
      : CONTENT_ENTER

  return (
    <motion.div
      key={keyId}
      initial={instant ? false : reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -3 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={exit}
      transition={transition}
      // Anchored to the pill line: content unfurls downward out of it and is
      // sucked back up into it.
      style={{ transformOrigin: 'top center' }}
      className={cn('flex items-center justify-center', className)}
    >
      {children}
    </motion.div>
  )
}

export interface DynamicIslandProps {
  /** Active view id. `null` shows the compact pill. */
  view: string | null
  /** Compact pill content, shown when no view is active. */
  compact?: ReactNode
  /** DynamicIslandView elements. */
  children?: ReactNode
  className?: string
  /** False collapses the shell into the pill and unmounts it. Defaults to true. */
  open?: boolean
  /** Called after the collapse animation has finished. */
  onExitComplete?: () => void
}

export function DynamicIsland({
  view,
  compact,
  children,
  className,
  open = true,
  onExitComplete,
}: DynamicIslandProps) {
  const reduce = useReducedMotion()
  const [sizerRef, size] = useContentSize()
  const contextValue = useMemo(() => ({ view }), [view])

  return (
    <IslandContext.Provider value={contextValue}>
      {/* AnimatePresence keeps rendering the element it is exiting with the
          props it had when the exit began, so anything that must change during
          the collapse has to sit on a wrapper that re-renders normally: while
          closing, the shell still holds the dismissed text and its buttons, and
          neither may take a click, a tab stop or an announcement. */}
      <div inert={!open} className={open ? undefined : 'pointer-events-none'}>
        <AnimatePresence onExitComplete={onExitComplete}>
          {open ? (
            <motion.div
              key="shell"
              role="status"
              aria-live="polite"
              // Reduced motion mounts at the final size and only fades; sizing
              // from the pill with a zero-duration snap reads as a jump.
              initial={reduce ? { opacity: 0 } : { width: PILL_WIDTH, height: PILL_HEIGHT, opacity: 0 }}
              animate={{
                // Never target less than the pill: a view narrower than 126x37
                // would otherwise animate *inward* when it opens.
                width: size ? Math.max(size.width, PILL_WIDTH) : PILL_WIDTH,
                height: size ? Math.max(size.height, PILL_HEIGHT) : PILL_HEIGHT,
                opacity: 1,
              }}
              // Collapse to the pill and only then fade: the island is sucked back
              // into the notch as a shrinking shape, not dissolved in place.
              exit={
                reduce
                  ? { opacity: 0, transition: { duration: 0.12 } }
                  : {
                      width: PILL_WIDTH,
                      height: PILL_HEIGHT,
                      opacity: 0,
                      transition: { width: SHELL_EXIT_SPRING, height: SHELL_EXIT_SPRING, opacity: EXIT_FADE },
                    }
              }
              // Opacity runs on its own short curve in both directions: riding the
              // size spring would make the pill fade in over half a second and fade
              // out before it has finished shrinking.
              transition={
                reduce
                  ? { width: { duration: 0 }, height: { duration: 0 }, opacity: { duration: 0.15 } }
                  : { width: SHELL_SPRING, height: SHELL_SPRING, opacity: ENTER_FADE }
              }
              style={{ borderRadius: RADIUS }}
              // items-start pins content to the top edge while the shell springs,
              // so expansion reads as unfurling downward out of the pill.
              className={cn(
                'relative inline-flex items-start justify-center overflow-hidden',
                'bg-foreground text-background shadow-2xl',
                className,
              )}
            >
              {/* w-max keeps this at the natural size of the active content; the
                  shell springs toward it. The pill and the view never animate in
                  and out at the same time: an exiting slot keeps contributing its
                  size, and the measured target would jump to pill+view for the
                  length of the crossfade. */}
              <div ref={sizerRef} className="w-max">
                {!view && compact ? (
                  <Slot
                    keyId="compact"
                    // The pill appears when the view leaves, i.e. only while the
                    // shell is collapsing — entering it with the normal spring
                    // would animate a shape that is already fading out.
                    instant
                    // iPhone pill proportions (~126x37): intentionally outside the
                    // spacing scale to mirror the device, not the layout grid.
                    className="min-h-[37px] min-w-[126px] gap-2 px-4 py-1.5 text-xs font-medium"
                  >
                    {compact}
                  </Slot>
                ) : null}
                {children}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </IslandContext.Provider>
  )
}

export interface DynamicIslandViewProps {
  /** Matches the parent `view` prop when active. */
  id: string
  children: ReactNode
  className?: string
}

export function DynamicIslandView({ id, children, className }: DynamicIslandViewProps) {
  const ctx = useContext(IslandContext)
  if (!ctx) throw new Error('DynamicIslandView must be used inside <DynamicIsland>')
  const active = ctx.view === id

  return (
    // No `initial={false}` here: the shell and its first view mount in the same
    // commit (the host opens the island on a state flip), so skipping the
    // child's initial state would pop the body in at full opacity instead of
    // letting it bloom out of the pill with the shell.
    <AnimatePresence mode="popLayout">
      {active ? (
        <Slot keyId={id} className={cn('px-6 py-4', className)}>
          {children}
        </Slot>
      ) : null}
    </AnimatePresence>
  )
}
