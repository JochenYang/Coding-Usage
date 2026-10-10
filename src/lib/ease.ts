/**
 * Single motion authority for the app's easing curves (see docs/DESIGN_SYSTEM.md §7).
 *
 * Springs deliberately do NOT live here: each animated surface owns the spring
 * its own gesture needs, defined next to that gesture (see
 * `components/beui/drawer.tsx`).
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
/** Symmetric in-out curve: Loader cadence shifts. */
export const EASE_IN_OUT = [0.45, 0, 0.55, 1] as const;
