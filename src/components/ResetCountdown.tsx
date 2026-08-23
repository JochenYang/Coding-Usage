import { useEffect, useState } from 'react'
import { formatCountdown } from '../lib/format'
import { useT } from '../i18n/useT'

/** Relative reset countdown; refreshes the local clock every second. */
export function ResetCountdown({ resetsAt }: { resetsAt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  const t = useT()
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!resetsAt) return null
  return (
    <span className="text-xs text-slate-400 tabular-nums">{formatCountdown(resetsAt, now, t)}</span>
  )
}