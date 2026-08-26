import { useReducedMotion } from 'motion/react'
import { cn } from '@/lib/cn'

export interface StatusDotProps {
  online: boolean
  className?: string
}

/**
 * Online state uses a two-layer dot (halo + core) matching the sidebar's
 * status card. The halo's ping animation collapses to a static glow when the
 * OS prefers reduced motion, keeping the affordance without the motion.
 */
export function StatusDot({ online, className }: StatusDotProps) {
  const reduceMotion = useReducedMotion()

  if (!online) {
    // Offline dots deliberately carry no halo: silence should look silent.
    return <span className={cn('h-2 w-2 shrink-0 rounded-full bg-offline', className)} />
  }

  return (
    <span className={cn('relative flex h-2 w-2 shrink-0', className)}>
      <span
        aria-hidden
        className={cn(
          'absolute inline-flex h-full w-full rounded-full bg-online opacity-60',
          !reduceMotion && 'animate-ping',
        )}
      />
      <span className="relative inline-flex h-2 w-2 shrink-0 rounded-full bg-online" />
    </span>
  )
}
