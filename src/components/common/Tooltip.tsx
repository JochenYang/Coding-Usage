import type { ReactNode } from 'react'
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
}

const POS: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'left-1/2 top-full mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
}

/**
 * Themed hover tooltip replacing the native `title` attribute app-wide.
 * Pure CSS (group-hover + focus-within), so there is no JS timing, no
 * animation to degrade, and keyboard focus reveals the same text.
 */
export function Tooltip({ text, side = 'top', children, className, bubbleClassName }: TooltipProps) {
  if (!text) return <>{children}</>
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md group-hover/tip:block group-focus-within/tip:block',
          POS[side],
          bubbleClassName,
        )}
      >
        {text}
      </span>
    </span>
  )
}
