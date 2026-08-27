import { useEffect, useState } from 'react'

/**
 * Minute-resolution clock so window countdowns and relative timestamps stay
 * live without any external timer wiring. Shared by every consumer that only
 * needs coarse "now" values (30s default keeps re-renders cheap).
 */
export function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
