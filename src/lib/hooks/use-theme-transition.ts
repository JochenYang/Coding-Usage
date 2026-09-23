import { useCallback } from 'react'
import { useReducedMotion } from 'motion/react'

/**
 * Theme switch transition — ported from beui.dev/components/motion/theme-toggle
 * (the stylesheet side lives in src/index.css).
 *
 * `document.startViewTransition` snapshots the page, runs the callback, then
 * animates between the two frames. The callback must therefore make the DOM flip
 * happen synchronously: ThemeProvider applies the `dark` class inside setTheme
 * for exactly that reason, instead of leaving it to the effect that runs after
 * the next commit.
 *
 * Reduced motion (and engines without the API) fall back to an instant switch.
 */

export type ThemeTransitionVariant = 'rect' | 'circle' | 'circle-blur' | 'blinds'

/** Where the reveal starts from. `blinds` sweeps the viewport and ignores it. */
export type ThemeTransitionOrigin =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'bottom-up'

const RECT_FROM: Record<ThemeTransitionOrigin, string> = {
  'top-left': 'inset(0 100% 100% 0)',
  'top-right': 'inset(0 0 100% 100%)',
  'bottom-left': 'inset(100% 100% 0 0)',
  'bottom-right': 'inset(100% 0 0 100%)',
  center: 'inset(50% 50% 50% 50%)',
  'bottom-up': 'inset(100% 0 0 0)',
}

const CIRCLE_ORIGIN: Record<ThemeTransitionOrigin, string> = {
  'top-left': '0% 0%',
  'top-right': '100% 0%',
  'bottom-left': '0% 100%',
  'bottom-right': '100% 100%',
  center: '50% 50%',
  'bottom-up': '50% 100%',
}

export interface ThemeTransitionOptions {
  /** Reveal shape. Default: "circle-blur". */
  variant?: ThemeTransitionVariant
  /**
   * Reveal origin. Default: "top-right" — the theme button sits in the top bar's
   * right cluster, so the circle opens away from the control that started it.
   */
  origin?: ThemeTransitionOrigin
}

export function useThemeTransition({
  variant = 'circle-blur',
  origin = 'top-right',
}: ThemeTransitionOptions = {}): { runTransition: (apply: () => void) => void } {
  const reduce = useReducedMotion() ?? false

  const runTransition = useCallback(
    (apply: () => void) => {
      // `startViewTransition` is typed as always present; the typeof check is the
      // runtime guard for engines that predate it.
      if (reduce || typeof document.startViewTransition !== 'function') {
        apply()
        return
      }
      const root = document.documentElement
      if (variant === 'rect') {
        root.style.setProperty('--theme-vt-from', RECT_FROM[origin])
      } else if (variant !== 'blinds') {
        root.style.setProperty('--theme-vt-origin', CIRCLE_ORIGIN[origin])
      }
      root.dataset.themeVt = variant
      // The callback is where the theme actually flips; the dataset must stay
      // until the animation ends or the new frame loses its animation-name.
      const transition = document.startViewTransition(apply)
      void transition.finished.finally(() => {
        delete root.dataset.themeVt
      })
    },
    [reduce, variant, origin],
  )

  return { runTransition }
}
