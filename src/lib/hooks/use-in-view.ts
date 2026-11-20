import { useEffect, useRef, useState } from 'react'

/**
 * Whether an element has come close to the viewport.
 *
 * The plans page renders every subscription card at once, and each card asks
 * the main process for its quota on mount. Several probes spawn a child
 * process or open a locked database, so a dozen simultaneous requests made the
 * page unresponsive. A card now waits until it is within `rootMargin` of the
 * viewport before it asks.
 *
 * Once true it stays true: scrolling away must not throw the numbers away or
 * re-request them on every pass.
 */
export function useInView<T extends HTMLElement>(
  rootMargin = '240px',
): { ref: React.RefObject<T | null>; inView: boolean } {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (inView) return
    const element = ref.current
    // Without observer support (jsdom, an older webview) load immediately:
    // silently never fetching is worse than paying the cost.
    if (!element || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [inView, rootMargin])

  return { ref, inView }
}
