import type { Transition } from 'motion/react'

/** Expo-out easing: used for panel/drawer enter and exit */
export const EASE_OUT: Transition['ease'] = [0.16, 1, 0.3, 1]
/** Symmetric in-out curve: used for Loader cadence shifts */
export const EASE_IN_OUT: Transition['ease'] = [0.45, 0, 0.55, 1]
/** Drawer panel spring: tracks the finger closely without wobble */
export const SPRING_PANEL: Transition = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }
/** Button-press spring: short and snappy */
export const SPRING_PRESS: Transition = { type: 'spring', stiffness: 600, damping: 28 }
