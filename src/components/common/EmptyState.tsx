import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  icon?: ReactNode
  /**
   * Brand illustration (DESIGN_SYSTEM §1.2) shown in place of `icon`: for a
   * surface whose empty state is the one spot with room for one. The caller
   * passes the already sized `<img>`; it is decorative.
   */
  illustration?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

/**
 * Shared placeholder for list/table views with no data yet. Every piece of
 * copy arrives via props so the component never reaches into i18n itself;
 * `action` renders untouched so callers decide between buttons and links.
 */
export function EmptyState({ icon, illustration, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 py-16 text-center', className)}>
      {illustration ??
        (icon && (
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card text-subtle">
            {icon}
          </div>
        ))}
      <div className="text-base font-semibold text-foreground">{title}</div>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  )
}
