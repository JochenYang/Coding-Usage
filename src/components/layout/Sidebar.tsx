import {
  BarChart3,
  Bell,
  DollarSign,
  Home,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings,
  Share2,
  TrendingUp,
  User,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { Tooltip } from '../common/Tooltip'
import type { View } from '@/lib/router'

interface NavItem {
  view: View
  icon: LucideIcon
  label: string
}

interface NavGroup {
  label: string | null
  items: NavItem[]
}

/** Re-render the "last updated" line on a cadence so relative time stays fresh */
function useTick(ms = 30_000) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

const SIDEBAR_COLLAPSED_KEY = 'coding-usage.sidebar-collapsed'

/** Persisted collapse choice; unreadable storage (private mode / quota) falls back to expanded */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * The rail's collapse state, owned by the shell: the shell offsets the page
 * and the top bar by the rail's width, so it has to know the state too.
 */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed)

  // Persist on toggle (same pattern as ThemeProvider): a failed write keeps the
  // in-memory state for this run instead of losing the toggle
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  return [collapsed, toggleCollapsed]
}

export function Sidebar({
  view,
  onNavigate,
  collapsed,
  onToggleCollapsed,
}: {
  view: View
  onNavigate: (v: View) => void
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const t = useT()
  const { lastUpdated, refreshAll, refreshingAll } = useData()
  useTick()

  const groups: NavGroup[] = [
    { label: null, items: [{ view: 'overview', icon: Home, label: t.nav.overview }] },
    {
      label: t.nav.groupManage,
      items: [
        { view: 'agents', icon: Users, label: t.nav.agents },
        { view: 'providers', icon: BarChart3, label: t.nav.providers },
        { view: 'accounts', icon: User, label: t.nav.accounts },
        { view: 'plans', icon: Package, label: t.nav.plans },
      ],
    },
    {
      label: t.nav.groupAnalytics,
      items: [
        { view: 'usage-stats', icon: BarChart3, label: t.nav.usageStats },
        { view: 'cost-analysis', icon: DollarSign, label: t.nav.costAnalysis },
        { view: 'trends', icon: TrendingUp, label: t.nav.trends },
        { view: 'alerts', icon: Bell, label: t.nav.alerts },
      ],
    },
    {
      label: t.nav.groupSettings,
      items: [
        { view: 'integrations', icon: Share2, label: t.nav.integrations },
        { view: 'settings', icon: Settings, label: t.nav.settings },
      ],
    },
  ]

  const updatedLabel = (() => {
    if (lastUpdated == null) return t.status.never
    const elapsed = Date.now() - lastUpdated
    if (elapsed < 60_000) return t.status.updatedJustNow
    const mins = Math.floor(elapsed / 60_000)
    if (mins < 60) return t.status.updatedAgo(mins)
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t.status.updatedHoursMinutes(hours, mins % 60)
    return t.status.updatedDaysHours(Math.floor(hours / 24), hours % 24)
  })()

  return (
    // No background and no dividing border of its own: the shell's background
    // shows through, so the footer wave runs under the rail on every page
    <aside
      className={cn(
        // md width comes from the shell's --rail-w: the page and the top bar
        // give way to the same value
        'flex h-full w-[64px] shrink-0 flex-col transition-[width] duration-200 md:w-(--rail-w)',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2.5 px-[14px] pb-4 pt-5',
          collapsed ? 'md:justify-center' : 'md:px-5',
        )}
      >
        {/* Narrow screens keep the plain logo; the md+ button holds both
            visuals (ZCode-style): the logo rests in place and fades out on
            hover while the toggle icon fades in, collapsed or not. */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft md:hidden">
          <BarChart3 className="h-5 w-5 text-accent" />
        </div>
        <Tooltip
          text={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
          side="right"
          floating
          className="hidden md:inline-flex"
        >
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
            className="group relative h-9 w-9 shrink-0 overflow-hidden rounded-lg transition-colors hover:bg-muted"
          >
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center rounded-lg bg-accent-soft transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
            >
              <BarChart3 className="h-5 w-5 text-accent" />
            </span>
            {collapsed ? (
              <PanelLeftOpen className="absolute inset-0 m-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
            ) : (
              <PanelLeftClose className="absolute inset-0 m-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </Tooltip>
        <div className={cn('hidden min-w-0 leading-tight md:block', collapsed && 'md:hidden')}>
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            Coding Usage
          </div>
          <div className="truncate text-xs text-muted-foreground">{t.app.tagline}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 pb-4 md:px-3">
        {groups.map((group, gi) => (
          <div key={gi}>
            {group.label && (
              <div
                className={cn(
                  'px-2.5 pb-1.5 text-[11px] font-medium text-subtle',
                  collapsed ? 'hidden' : 'hidden md:block',
                )}
              >
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = view === item.view
                const Icon = item.icon
                return (
                  // Collapsed: the label is hidden, so a floating right-side
                  // tooltip takes over — floating because the nav's
                  // overflow-y-auto would clip a CSS bubble (and the content
                  // column would bury it). The empty-text branch renders no
                  // wrapper when expanded — the label sits next to the icon.
                  <Tooltip
                    key={item.view}
                    text={collapsed ? item.label : ''}
                    side="right"
                    floating
                    className={collapsed ? 'w-full' : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate(item.view)}
                      aria-label={item.label}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex w-full items-center justify-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                        collapsed ? '' : 'md:justify-start',
                        active
                          ? 'bg-accent font-medium text-white'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span
                        className={cn('truncate text-sm', collapsed ? 'hidden' : 'hidden md:block')}
                      >
                        {item.label}
                      </span>
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className={cn(collapsed ? 'hidden' : 'hidden p-3 md:block')}>
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-online opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-online" />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-xs font-medium text-foreground">{t.status.allNormal}</div>
            <div className="truncate text-[11px] text-subtle tabular-nums">{updatedLabel}</div>
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={refreshingAll}
            aria-label={t.header.refreshAll}
            className="shrink-0 rounded-md p-1 text-subtle transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshingAll && 'animate-spin')} />
          </button>
        </div>
      </div>
    </aside>
  )
}
