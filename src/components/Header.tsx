import { BarChart3, Moon, Monitor, RefreshCw, Settings, Sun } from 'lucide-react'
import { useTheme, type ThemeMode } from './ThemeProvider'
import { useT } from '../i18n/useT'
import { LocaleSwitcher } from './LocaleSwitcher'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './beui/select'
import { Popover, PopoverContent, PopoverTrigger } from './beui/popover'

interface HeaderProps {
  okCount: number
  totalConfigured: number
  refreshing: boolean
  autoRefreshMin: number
  onAutoRefreshChange: (min: number) => void
  onRefreshAll: () => void
  onOpenSettings: () => void
}

/** system → light → dark → system */
function nextTheme(t: ThemeMode): ThemeMode {
  if (t === 'system') return 'light'
  if (t === 'light') return 'dark'
  return 'system'
}

export function Header({
  okCount,
  totalConfigured,
  refreshing,
  autoRefreshMin,
  onAutoRefreshChange,
  onRefreshAll,
  onOpenSettings,
}: HeaderProps) {
  const t = useT()
  const { theme, setTheme, resolved } = useTheme()
  // Auto-refresh options: numeric `value` stays stable across locales so settings.autoRefreshMin
  // migration is unaffected; only the human-readable label is locale-driven.
  const AUTO_OPTIONS: { value: number; label: string }[] = [
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
  // Theme button title: keep English frame regardless of locale; in system mode we
  // also surface the OS-level resolved theme so users can immediately tell whether
  // their Chrome / OS is reporting dark or light.
  const resolvedLabel = resolved === 'dark' ? t.header.theme.dark : t.header.theme.light
  const themeTitle =
    theme === 'system'
      ? `Theme: ${t.header.theme.system} (OS: ${resolvedLabel})`
      : `Theme: ${t.header.theme[theme]}`
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-stone-900" />
          <h1 className="text-lg font-bold tracking-tight text-foreground">
            Coding&nbsp;Usage
            <span className="ml-2 text-xs font-normal text-muted-foreground">{t.app.tagline}</span>
          </h1>
        </div>
        {totalConfigured > 0 && (
          <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground tabular-nums">
            {t.card.okRatio(okCount, totalConfigured)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <LocaleSwitcher />
          <Popover trigger="hover" side="bottom" align="center" sideOffset={4}>
            <PopoverTrigger>
              <a
                href="https://github.com/JochenYang/Coding-Usage"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
              </a>
            </PopoverTrigger>
            <PopoverContent>
              <div className="text-xs text-popover-foreground">GitHub</div>
            </PopoverContent>
          </Popover>
          <Popover trigger="hover" side="bottom" align="center" sideOffset={4}>
            <PopoverTrigger>
              <button
                type="button"
                onClick={() => setTheme(nextTheme(theme))}
                aria-label={t.header.theme[theme]}
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <ThemeIcon className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="text-xs text-popover-foreground">{themeTitle}</div>
            </PopoverContent>
          </Popover>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t.header.autoRefresh}
            <Select
              value={String(autoRefreshMin)}
              onValueChange={(v) => onAutoRefreshChange(Number(v))}
            >
              <SelectTrigger
                aria-label={t.header.autoRefresh}
                className="min-w-[96px] w-auto rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <button
            onClick={onRefreshAll}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t.header.refreshAll}
          </button>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Settings className="h-3.5 w-3.5" />
            {t.header.settings}
          </button>
        </div>
      </div>
    </header>
  )
}
