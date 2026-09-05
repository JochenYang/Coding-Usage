import { useEffect, useState } from 'react'

/**
 * Two-phase island entrance: hold the bare pill for one frame, then expand.
 * The shell therefore springs out from the pill (iOS island behavior)
 * instead of popping at full size on first paint.
 */
export function useIslandBloom(active: boolean): boolean {
  const [bloom, setBloom] = useState(false)
  useEffect(() => {
    if (!active) {
      setBloom(false)
      return
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setBloom(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [active])
  return bloom
}
