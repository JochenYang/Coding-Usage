import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

export interface TooltipProps {
  /** Bubble text; empty renders children alone (no bubble, no wrapper behavior change) */
  text: string
  /** Bubble placement relative to the trigger (default top) */
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
  /** Extra classes on the trigger wrapper */
  className?: string
  /** Extra classes on the bubble (e.g. max width for long text) */
  bubbleClassName?: string
  /**
   * Portal the bubble to `document.body` with fixed positioning instead of an
   * absolutely-positioned CSS bubble. Use it when the trigger sits inside an
   * `overflow` container or a low stacking context — both clip or bury a CSS
   * bubble (collapsed sidebar items). Hover + keyboard focus reveal it the
   * same way, but a plain mouse click does not stick it open.
   */
  floating?: boolean
}

const POS: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'left-1/2 top-full mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
}

/** Gap between the trigger edge and the floating bubble */
const GAP = 6

/** Fixed-position coordinates for one bubble placement */
function floatingPos(rect: DOMRect, side: NonNullable<TooltipProps['side']>) {
  switch (side) {
    case 'right':
      return { top: rect.top + rect.height / 2, left: rect.right + GAP, transform: 'translateY(-50%)' }
    case 'left':
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - GAP,
        transform: 'translate(-100%, -50%)',
      }
    case 'bottom':
      return { top: rect.bottom + GAP, left: rect.left + rect.width / 2, transform: 'translateX(-50%)' }
    default:
      return { top: rect.top - GAP, left: rect.left + rect.width / 2, transform: 'translate(-50%, -100%)' }
  }
}

const BUBBLE =
  'pointer-events-none whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md'

/**
 * Themed hover tooltip replacing the native `title` attribute app-wide.
 * Default is pure CSS (group-hover + focus-visible), so there is no JS timing,
 * no animation to degrade, and keyboard focus reveals the same text; a mouse
 * click does not stick it open. `floating` portals the bubble instead — see
 * {@link TooltipProps.floating}.
 */
export function Tooltip({ text, side = 'top', children, className, bubbleClassName, floating }: TooltipProps) {
  if (!text) return <>{children}</>
  if (floating) {
    return (
      <FloatingTooltip
        text={text}
        side={side}
        className={className}
        bubbleClassName={bubbleClassName}
      >
        {children}
      </FloatingTooltip>
    )
  }
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md group-hover/tip:block group-has-[:focus-visible]/tip:block',
          POS[side],
          bubbleClassName,
        )}
      >
        {text}
      </span>
    </span>
  )
}

function FloatingTooltip({
  text,
  side = 'top',
  children,
  className,
  bubbleClassName,
}: TooltipProps) {
  const [anchor, setAnchor] = useState<{ top: number; left: number; transform: string } | null>(null)

  const show = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setAnchor(floatingPos(rect, side))
  }

  return (
    <span
      className={cn('inline-flex', className)}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setAnchor(null)}
      onFocus={(e) => {
        // Same focus-visible rule as the CSS variant: a mouse click leaves
        // focus behind and must not stick the bubble open after navigation
        if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget)
      }}
      onBlur={() => setAnchor(null)}
    >
      {children}
      {anchor &&
        createPortal(
          <span
            role="tooltip"
            style={{ top: anchor.top, left: anchor.left, transform: anchor.transform }}
            className={cn(BUBBLE, 'fixed z-[100]', bubbleClassName)}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  )
}
