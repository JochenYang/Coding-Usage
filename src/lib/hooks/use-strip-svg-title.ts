import { useLayoutEffect, useRef } from 'react'

/**
 * Drops the `<title>` that @lobehub/icons bakes into every brand mark.
 *
 * Chromium renders an SVG `<title>` as a NATIVE hover tooltip: a system-styled
 * box outside our theming, drawn on top of the themed tooltips these marks sit
 * next to (the balance KPI chip sits right above the figure whose breakdown
 * panel opens on hover). The wrappers keep the name they need — `aria-label` on
 * provider marks, `aria-hidden` where the name is printed beside the mark — so
 * the element itself only ever produced noise.
 *
 * Attach it to brand-mark wrappers ONLY: our own charts use `<title>` for real
 * per-slice data tooltips (see DonutChart), which must survive.
 *
 * Returns the ref to put on the wrapper element.
 */
export function useStripSvgTitle<T extends HTMLElement>() {
  const ref = useRef<T>(null)

  // Deliberately no dependency list. React goes on believing the element it
  // rendered is still in the tree, so the only thing that can bring a <title>
  // back is a remount — and re-sweeping after every commit is what catches it.
  useLayoutEffect(() => {
    ref.current?.querySelectorAll('title').forEach((node) => node.remove())
  })

  return ref
}
