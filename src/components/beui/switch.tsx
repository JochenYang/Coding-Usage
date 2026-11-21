import { animate, motion, MotionConfig, useReducedMotion } from "motion/react"
import { useEffect, useId, useRef, useState } from "react"
import { cn } from "@/lib/cn"

// Heavy, deliberate thumb — high mass keeps the travel weighty without wobble.
const THUMB_SPRING = { type: "spring", stiffness: 800, damping: 80, mass: 4 } as const

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  ariaLabel?: string
  className?: string
}

/**
 * Spring-driven switch adapted from beui.dev/components/motion/switch.
 * Retokenized for this project's indigo accent: the track consumes
 * `bg-accent` (on) / `bg-muted` (off). The thumb stays pure white as an
 * intentional cross-theme constant (same rationale as destructive-foreground),
 * so it reads on the accent track in both light and dark modes.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  ariaLabel,
  className,
}: SwitchProps) {
  const id = useId()
  const thumbRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const [isPressed, setIsPressed] = useState(false)
  const [isPointer, setIsPointer] = useState(false)
  /** Track travel: w-12 (48) − thumb w-5 (20) − 2×4px inset = 20px */
  const THUMB_TRAVEL = 20
  const restingX = checked ? THUMB_TRAVEL : 0

  useEffect(() => {
    if (!thumbRef.current || reduce) return
    if (disabled && isPressed) {
      // Shake around the resting position, always ending back at it — the
      // resting x is state-driven now, so the keyframes must not end at 0.
      animate(
        thumbRef.current,
        { x: [restingX, restingX - 2, restingX + 2, restingX - 1, restingX] },
        { delay: 0.2, duration: 0.6 },
      )
    }
  }, [disabled, isPressed, reduce, restingX])

  const squish = !disabled && isPointer && isPressed && !reduce

  return (
    <MotionConfig transition={reduce ? { duration: 0 } : THUMB_SPRING}>
      <span className={cn("inline-flex items-center gap-3", className)}>
        <motion.button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={() => !disabled && onCheckedChange(!checked)}
          onPointerDown={(e) => {
            setIsPressed(true)
            setIsPointer(e.type.startsWith("pointer"))
          }}
          onPointerUp={() => setIsPressed(false)}
          onPointerLeave={() => setIsPressed(false)}
          initial={false}
          data-state={checked ? "checked" : "unchecked"}
          className={cn(
            "group peer relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full outline-none transition-colors duration-200",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-60",
            checked ? "bg-accent" : "bg-muted",
          )}
        >
          {/* The slide is an explicit x animation, NOT a layout animation: a
              layout-driven thumb re-animates whenever its row reflows (e.g. a
              filter collapsing siblings), which read as switches "parachuting"
              back into place. Explicit x only moves on checked changes. */}
          <motion.div
            ref={thumbRef}
            initial={false}
            animate={{ x: restingX, scale: squish ? 0.9 : 1 }}
            className="pointer-events-none absolute left-1 top-1 block h-5 w-5 rounded-full bg-white shadow-md"
          >
            <div className={cn("size-5", squish && (checked ? "ml-1" : "mr-1"))} />
          </motion.div>
        </motion.button>
        {label ? (
          <label htmlFor={id} className="cursor-pointer text-sm text-foreground">
            {label}
          </label>
        ) : null}
      </span>
    </MotionConfig>
  )
}
