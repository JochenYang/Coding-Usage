import { cn } from '@/lib/cn'

export interface ProgressBarProps {
  /** Raw percentage value; values outside 0-100 are clamped before rendering */
  percent: number
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Color ladder mirrors the design baseline screenshots: accent while usage
 * feels safe (<70), warning as the window fills up, danger once capacity is
 * reached. Kept next to the component so future thresholds have one home.
 */
function fillColor(percent: number): string {
  if (percent >= 100) return 'bg-danger'
  if (percent >= 70) return 'bg-warning'
  return 'bg-accent'
}

export function ProgressBar({ percent, size = 'md', className }: ProgressBarProps) {
  // Clamp here rather than trusting every caller: raw API ratios can be
  // negative or exceed 100 and would otherwise break the fill geometry.
  const clamped = Math.min(100, Math.max(0, percent))
  const empty = clamped <= 0

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={empty ? 0 : clamped}
      className={cn('rounded-full bg-muted', size === 'sm' ? 'h-1.5' : 'h-2', className)}
    >
      {/* An empty track reads cleaner than a zero-width sliver of rounding */}
      {!empty && (
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            fillColor(clamped),
          )}
          style={{ width: `${clamped}%` }}
        />
      )}
    </div>
  )
}
