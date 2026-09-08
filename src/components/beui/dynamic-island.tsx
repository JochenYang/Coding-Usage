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
 */

type IslandContextValue = {
  view: string | null
}

const IslandContext = createContext<IslandContextValue | null>(null)

// Shell physics, tuned to the iOS island feel: the expansion is quick with a
// pronounced overshoot (bounce ≈ 8-10% visual overshoot); the collapse is
// shorter and much more damped — Apple sucks the island back in rather than
// letting it wobble shut.
const SHELL_SPRING_IN = { type: 'spring', duration: 0.45, bounce: 0.45 } as const
const SHELL_SPRING_OUT = { type: 'spring', duration: 0.3, bounce: 0.18 } as const

// Content travels with the shell but settles a touch springier.
const CONTENT_SPRING = { type: 'spring', duration: 0.45, bounce: 0.35 } as const

// Constant radius — never animated. The browser clamps it to half the shell
// height, so the pill-to-rounded-rect morph comes for free.
const RADIUS = 32

// iPhone pill dimensions. Also the shell's pre-measure animate target: if
// the first commit already has a view active, the shell blooms from the pill
// instead of rendering expanded with no animation.
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
}: {
  keyId: string
  children: ReactNode
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      key={keyId}
      initial={reduce ? { opacity: 0, filter: 'blur(0px)' } : { opacity: 0, scale: 0.9, y: -8, filter: 'blur(5px)' }}
      animate={reduce ? { opacity: 1, filter: 'blur(0px)' } : { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
      // Exit gets sucked up into the pill — fast, blur-free, before the
      // shrinking shell can clip it.
      exit={
        reduce
          ? { opacity: 0, filter: 'blur(0px)', transition: { duration: 0.06 } }
          : { opacity: 0, scale: 0.92, y: -5, filter: 'blur(0px)', transition: { duration: 0.07, ease: EASE_OUT } }
      }
      // One spring drives transform, opacity and blur together — content
      // travels with the shell.
      transition={reduce ? { duration: 0.15 } : CONTENT_SPRING}
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
}

export function DynamicIsland({ view, compact, children, className }: DynamicIslandProps) {
  const reduce = useReducedMotion()
  const expanded = view !== null
  const [sizerRef, size] = useContentSize()
  const contextValue = useMemo(() => ({ view }), [view])

  return (
    <IslandContext.Provider value={contextValue}>
      <motion.div
        role="status"
        aria-live="polite"
        initial={false}
        animate={size ? { width: size.width, height: size.height } : { width: PILL_WIDTH, height: PILL_HEIGHT }}
        // Direction-aware physics: blooming out is bouncy, sucking back in is
        // quick and damped.
        transition={reduce ? { duration: 0 } : expanded ? SHELL_SPRING_IN : SHELL_SPRING_OUT}
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
            shell springs toward it. */}
        <div ref={sizerRef} className="w-max">
          <AnimatePresence mode="popLayout" initial={false}>
            {!expanded && compact ? (
              <Slot
                keyId="compact"
                // iPhone pill proportions (~126x37): intentionally outside the
                // spacing scale to mirror the device, not the layout grid.
                className="min-h-[37px] min-w-[126px] gap-2 px-4 py-1.5 text-xs font-medium"
              >
                {compact}
              </Slot>
            ) : null}
          </AnimatePresence>
          {children}
        </div>
      </motion.div>
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
    <AnimatePresence mode="popLayout" initial={false}>
      {active ? (
        <Slot keyId={id} className={cn('px-6 py-4', className)}>
          {children}
        </Slot>
      ) : null}
    </AnimatePresence>
  )
}
