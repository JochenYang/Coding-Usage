import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral'

// Tone map kept flat so the semantic token pairing stays scannable at a glance
const toneClasses: Record<BadgeTone, string> = {
  success: 'bg-online/10 text-online',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-muted text-muted-foreground',
}

export interface BadgeProps {
  tone: BadgeTone
  children: ReactNode
  className?: string
}

/** Compact status label; all copy flows in via children so i18n stays external */
export function Badge({ tone, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
