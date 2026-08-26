import { useCallback, useEffect, useState } from 'react'

/**
 * Hash-based view router. The app is a desktop shell with a fixed set of views;
 * a router library would be overkill, but hash sync keeps deep links, browser
 * back/forward and refresh-to-same-view working for free.
 */
export const VIEWS = [
  'overview',
  'agents',
  'providers',
  'accounts',
  'plans',
  'usage-stats',
  'cost-analysis',
  'trends',
  'alerts',
  'integrations',
  'team',
  'settings',
] as const

export type View = (typeof VIEWS)[number]

function parseHash(): View {
  const h = window.location.hash.replace(/^#\/?/, '')
  return (VIEWS as readonly string[]).includes(h) ? (h as View) : 'overview'
}

/** Current view + a navigate function that mirrors the view into location.hash. */
export function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(parseHash)
  useEffect(() => {
    const onHash = () => setView(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const navigate = useCallback((v: View) => {
    if (parseHash() === v) return
    window.location.hash = `/${v}`
  }, [])
  return [view, navigate]
}
