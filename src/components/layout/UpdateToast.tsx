import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { RefreshCw } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { EASE_OUT } from '@/lib/ease'

/**
 * Update-ready toast: consumes the main process's `desktop:update-downloaded`
 * event and offers a one-click install. Browser dev (no bridge) renders
 * nothing. "Later" only hides the current toast — a newly downloaded version
 * re-opens it.
 */
export function UpdateToast() {
  const t = useT()
  const reducedMotion = useReducedMotion()
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    return bridge.onUpdateDownloaded((v) => {
      setVersion(v)
      setDismissed(false)
    })
  }, [])

  const visible = version != null && !dismissed

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={
            reducedMotion ? { duration: 0.2 } : { duration: 0.28, ease: EASE_OUT }
          }
          role="status"
          className="fixed right-5 bottom-5 z-50 w-80 rounded-2xl border border-border bg-card p-4 shadow-lg"
        >
          <div className="flex items-start gap-3">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"
              aria-hidden
            >
              <RefreshCw className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{t.updater.readyTitle}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t.updater.readyBody(version)}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void window.desktopBridge?.installUpdate()}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-strong"
                >
                  {t.updater.installNow}
                </button>
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
                >
                  {t.updater.later}
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
