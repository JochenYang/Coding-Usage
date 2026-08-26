import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface StatCardProps {
  title: string
  icon: LucideIcon
  iconClassName?: string
  value: string
  footer?: ReactNode
  className?: string
}

/** Metric card: title + icon chip, large tabular value, optional footer line */
export function StatCard({ title, icon, iconClassName, value, footer, className }: StatCardProps) {
  const Icon = icon

  return (
    <div className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{title}</span>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft">
          <Icon className={cn('h-4 w-4 text-accent', iconClassName)} />
        </div>
      </div>
      <div className="mt-2 text-[28px] font-semibold leading-tight tabular-nums text-foreground">
        {value}
      </div>
      {footer && <div className="mt-1 text-xs">{footer}</div>}
    </div>
  )
}
