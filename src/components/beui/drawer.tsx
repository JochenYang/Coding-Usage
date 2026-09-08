import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { EASE_OUT } from '@/lib/ease'
import { cn } from '@/lib/cn'

/**
 * Simplified drawer: modeled on beui.dev/components/motion/drawer, with the
 * PresenceGate dependency removed. AnimatePresence drives both the backdrop
 * and the panel in/out together; Escape closes automatically; body scroll is
 * locked while open.
 *
 * Animation timing (avoids the "blink-and-miss-it" look):
 *   backdrop: immediate 250ms ease-out fade-in
 *   panel:    after an 80ms delay, spring slides in from 100% off the
 *             side of the screen (right by default)
 *             spring stiffness:220 / damping:26 / mass:0.9 ≈ 600ms visual
 *             length with a slight overshoot
 *   exit:     backdrop and panel leave together; spring slide-out is slightly
 *             faster than slide-in
 */
export interface DrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: 'left' | 'right'
  children: ReactNode
  className?: string
  backdropClassName?: string
  ariaLabel?: string
  dismissable?: boolean
}

const PANEL_SPRING = { type: 'spring', stiffness: 220, damping: 26, mass: 0.9 } as const
/** Exit spring: slightly faster and crisper than entry, avoiding any lingering tail (visually ~350ms) */
const EXIT_SPRING = { type: 'spring', stiffness: 260, damping: 30 } as const

export function Drawer({
  open,
  onOpenChange,
  side = 'right',
  children,
  className,
  backdropClassName,
  ariaLabel,
  dismissable = true,
}: DrawerProps) {
  const reduce = useReducedMotion()
  const offscreen = side === 'right' ? '100%' : '-100%'

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onOpenChange])

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.button
            key="backdrop"
            type="button"
            aria-label="Close"
            tabIndex={dismissable ? 0 : -1}
            onClick={() => dismissable && onOpenChange(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className={cn(
              'fixed inset-0 z-40 h-full w-full cursor-default bg-black/40 backdrop-blur-sm',
              backdropClassName,
            )}
          />
          <motion.aside
            key="panel"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            initial={reduce ? { opacity: 0 } : { x: offscreen }}
            animate={
              reduce
                ? { opacity: 1, transition: { duration: 0.2, ease: EASE_OUT } }
                : { x: 0, transition: { ...PANEL_SPRING, delay: 0.08 } }
            }
            exit={
              reduce
                ? { opacity: 0, transition: { duration: 0.2, ease: EASE_OUT } }
                : { x: offscreen, transition: EXIT_SPRING }
            }
            className={cn(
              'fixed inset-y-0 z-50 flex w-full max-w-[min(560px,50vw)] flex-col border-l border-border bg-card shadow-[0_30px_60px_-15px_rgba(0,0,0,0.25)] dark:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.6)] sm:min-w-[440px]',
              side === 'right' ? 'right-0' : 'left-0 border-r border-l-0',
              className,
            )}
          >
            {children}
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  )
}
