import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '@/lib/ease'
import { Bell, Copy, Minus, Monitor, Moon, RefreshCw, Settings, Square, Sun, X } from 'lucide-react'
import { useTheme, type ThemeMode } from '../ThemeProvider'
import { LocaleSwitcher } from '../LocaleSwitcher'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../beui/select'
import { Switch } from '../beui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '../beui/popover'
import { AlertsPanel } from '../overview/AlertsPanel'
import { Tooltip } from '../common/Tooltip'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import type { View } from '@/lib/router'

/** system → light → dark → system */
function nextTheme(t: ThemeMode): ThemeMode {
  if (t === 'system') return 'light'
  if (t === 'light') return 'dark'
  return 'system'
}

const GHOST_BTN =
  'flex items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

/** How many notifications the hover preview shows (and marks as seen) */
const NOTIF_PREVIEW_COUNT = 4

/** "Don't ask again" choice remembered for the current app run only */
let rememberedClose: 'tray' | 'quit' | null = null

/** Windows-style caption button: full header height, edge-to-edge hover fill */
const CAPTION_BTN = 'flex h-full w-12 items-center justify-center text-muted-foreground transition-colors'

export function TopBar({ onNavigate }: { onNavigate: (v: View) => void }) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const { theme, setTheme } = useTheme()
  const [maximized, setMaximized] = useState(false)
  const {
    settings,
    updateSettings,
    refreshAll,
    refreshingAll,
    alerts,
    unreadAlerts,
    markAlertsRead,
  } = useData()
  // Hover-controlled notification popover; closed again when "view all" jumps
  const [notifOpen, setNotifOpen] = useState(false)
  // Styled close confirmation ("tray or quit"), driven by caption X and Alt+F4
  const [closeOpen, setCloseOpen] = useState(false)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  // Update badge on the settings gear: an available/downloading/downloaded
  // release stays visible on every page (the toast alone is dismissible and
  // only fires after a full download)
  const [updateBadge, setUpdateBadge] = useState(false)

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    const sync = (s: DesktopUpdateState): void => {
      setUpdateBadge(s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded')
    }
    void bridge.updateState().then(sync).catch(() => {})
    return bridge.onUpdateStatus(sync)
  }, [])

  const runCloseChoice = (choice: 'tray' | 'quit') => {
    setCloseOpen(false)
    const bridge = window.desktopBridge
    if (!bridge) return
    if (choice === 'quit') void bridge.quitApp()
    else void bridge.hideWindow()
  }
  // Entry point for both the caption X and the intercepted native close
  const requestClose = () => {
    if (rememberedClose) {
      runCloseChoice(rememberedClose)
      return
    }
    setCloseOpen(true)
  }

  // Track maximize transitions so the caption glyph swaps live; the initial
  // value matters when the OS restores a maximized window
  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    void bridge.getWindowMaximized().then(setMaximized).catch(() => {})
    return bridge.onWindowMaximized(setMaximized)
  }, [])

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge) return
    return bridge.onCloseRequested(requestClose)
    // requestClose is stable enough for this purpose (reads a module ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-refresh options: numeric `value` stays stable across locales so settings.autoRefreshMin
  // migration is unaffected; only the human-readable label is locale-driven.
  const autoOptions: { value: number; label: string }[] = [
    { value: 0, label: t.autoRefresh.manual },
    { value: 0.25, label: t.autoRefresh.sec15 },
    { value: 0.5, label: t.autoRefresh.sec30 },
    { value: 1, label: t.autoRefresh.min1 },
    { value: 3, label: t.autoRefresh.min3 },
    { value: 5, label: t.autoRefresh.min5 },
    { value: 15, label: t.autoRefresh.min15 },
    { value: 30, label: t.autoRefresh.min30 },
  ]
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon

  return (
    <>
      <header
        className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background pl-6 [app-region:drag]"
      // Double-clicking the drag region toggles maximize, matching native
      // title-bar behavior (buttons opt out via the closest('button') guard)
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        void window.desktopBridge?.toggleMaximizeWindow()
      }}
    >
      {/* The old global provider filter lived here; the overview table's own
          search + provider/status filters cover the need with less confusion */}

      <div className="ml-auto flex items-center gap-1.5 [app-region:no-drag]">
        {/* Auto-refresh toggle + interval */}
        <div className="mr-1 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
          <span className="text-xs text-muted-foreground">{t.header.autoRefresh}</span>
          <Switch
            checked={settings.autoRefreshMin > 0}
            ariaLabel={t.header.autoRefresh}
            onCheckedChange={(on) =>
              updateSettings({ ...settings, autoRefreshMin: on ? 0.5 : 0 })
            }
          />
          <Select
            value={String(settings.autoRefreshMin)}
            onValueChange={(v) => updateSettings({ ...settings, autoRefreshMin: Number(v) })}
          >
            <SelectTrigger className="w-24 rounded-md border-none bg-muted px-2 py-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {autoOptions.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Interim compact theme + locale controls; they move into the full
            settings page when the management phase lands */}
        <button
          type="button"
          onClick={() => setTheme(nextTheme(theme))}
          aria-label={t.header.theme[theme]}
          className={GHOST_BTN}
        >
          <ThemeIcon className="h-4 w-4" />
        </button>
        <LocaleSwitcher />

        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={refreshingAll}
          aria-label={t.header.refreshAll}
          className={GHOST_BTN}
        >
          <RefreshCw className={cn('h-4 w-4', refreshingAll && 'animate-spin')} />
        </button>

        {/* Bell: hover previews recent notifications (Notification-Stack
            style); a click still jumps to the full alerts center */}
        <Popover
          open={notifOpen}
          onOpenChange={(open) => {
            setNotifOpen(open)
            // Seeing the preview counts as seeing those alerts: the badge
            // drops without forcing a trip to the alerts center. One batched
            // call — looping markAlertRead would race its stale closure.
            if (open) {
              // Mark exactly what the preview renders (same filter order as
              // AlertsPanel): resolved history never appears in the bell.
              const previewIds = alerts
                .filter((a) => !a.resolved)
                .slice(0, NOTIF_PREVIEW_COUNT)
                .filter((a) => !a.read)
                .map((a) => a.id)
              if (previewIds.length > 0) markAlertsRead(previewIds)
            }
          }}
          trigger="hover"
          align="end"
          sideOffset={10}
        >
          <PopoverTrigger>
            <button
              type="button"
              onClick={() => onNavigate('alerts')}
              aria-label={t.topbar.notifications}
              className={cn(GHOST_BTN, 'relative')}
            >
              <Bell className="h-4 w-4" />
              {unreadAlerts > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold text-white tabular-nums">
                  {unreadAlerts > 9 ? '9+' : unreadAlerts}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[26rem] max-w-none">
            {/* Panel chrome comes from the popover itself; strip the card look */}
            <AlertsPanel
              alerts={alerts}
              max={NOTIF_PREVIEW_COUNT}
              className="rounded-none border-0 bg-transparent p-0 shadow-none"
              onViewAll={() => {
                setNotifOpen(false)
                onNavigate('alerts')
              }}
            />
          </PopoverContent>
        </Popover>

        <Tooltip text={t.nav.settings} side="bottom">
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            aria-label={t.nav.settings}
            className={cn(GHOST_BTN, 'relative')}
          >
            <Settings className="h-4 w-4" />
            {updateBadge && (
              <span
                aria-hidden
                className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-accent"
              />
            )}
          </button>
        </Tooltip>
      </div>

      {/* Custom caption buttons (browser path: no desktop bridge, so they hide;
          in Electron they draw their own hover states and intercept close) */}
      {window.desktopBridge && (
        <div className="-mr-px flex h-full items-stretch [app-region:no-drag]">
          <Tooltip text={t.header.windowMinimize} side="bottom" className="flex h-full">
            <button
              type="button"
              onClick={() => void window.desktopBridge?.minimizeWindow()}
              aria-label={t.header.windowMinimize}
              className={cn(CAPTION_BTN, 'hover:bg-muted hover:text-foreground')}
            >
              <Minus className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip text={t.header.windowMaximize} side="bottom" className="flex h-full">
            <button
              type="button"
              onClick={() => void window.desktopBridge?.toggleMaximizeWindow()}
              aria-label={t.header.windowMaximize}
              className={cn(CAPTION_BTN, 'hover:bg-muted hover:text-foreground')}
            >
              {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
            </button>
          </Tooltip>
          <Tooltip text={t.header.windowClose} side="bottom" className="flex h-full">
            <button
              type="button"
              onClick={requestClose}
              aria-label={t.header.windowClose}
              className={cn(CAPTION_BTN, 'hover:bg-danger hover:text-white')}
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      )}
      </header>

      {/* Tray-or-quit confirmation: matches the app theme instead of a native
          message box; Escape cancels, "don't ask again" holds for this run */}
      <AnimatePresence>
        {closeOpen && (
          <motion.div
            className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40 backdrop-blur-[2px] [app-region:no-drag]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15 }}
            // Backdrop click and Escape both cancel (focus sits on the primary
            // button via autoFocus, so keydown reaches this handler)
            onClick={(e) => {
              if (e.target === e.currentTarget) setCloseOpen(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCloseOpen(false)
            }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              className="w-[26rem] rounded-2xl border border-border bg-card p-5 shadow-xl"
              initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.96 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE_OUT }}
            >
              <h3 className="text-sm font-semibold text-foreground">
                {t.header.closeDialog.title}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t.header.closeDialog.detail}
              </p>
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={dontAskAgain}
                  onChange={(e) => setDontAskAgain(e.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                {t.header.closeDialog.dontAsk}
              </label>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCloseOpen(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {t.common.cancel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    rememberedClose = dontAskAgain ? 'quit' : null
                    runCloseChoice('quit')
                  }}
                  className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
                >
                  {t.header.closeDialog.quit}
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={() => {
                    rememberedClose = dontAskAgain ? 'tray' : null
                    runCloseChoice('tray')
                  }}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-strong"
                >
                  {t.header.closeDialog.toTray}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
