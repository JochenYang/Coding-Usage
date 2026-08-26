import { Bell, Monitor, Moon, RefreshCw, Settings, Sun } from 'lucide-react'
import { useTheme, type ThemeMode } from '../ThemeProvider'
import { LocaleSwitcher } from '../LocaleSwitcher'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../beui/select'
import { Switch } from '../beui/switch'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { PROVIDERS } from '@/providers/registry'
import type { View } from '@/lib/router'

/** system → light → dark → system */
function nextTheme(t: ThemeMode): ThemeMode {
  if (t === 'system') return 'light'
  if (t === 'light') return 'dark'
  return 'system'
}

const GHOST_BTN =
  'flex items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

export function TopBar({ onNavigate }: { onNavigate: (v: View) => void }) {
  const t = useT()
  const { theme, setTheme } = useTheme()
  const {
    settings,
    updateSettings,
    refreshAll,
    refreshingAll,
    agentFilter,
    setAgentFilter,
    unreadAlerts,
  } = useData()

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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background pl-6 pr-36 [app-region:drag]">
      {/* Global agent (provider) filter — interactive, excluded from window drag */}
      <div className="[app-region:no-drag]">
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-44 rounded-lg border-border bg-card px-3 py-1.5 text-sm">
            <SelectValue placeholder={t.topbar.allAgents} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.topbar.allAgents}</SelectItem>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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

        <button
          type="button"
          onClick={() => onNavigate('settings')}
          aria-label={t.nav.settings}
          className={GHOST_BTN}
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}
