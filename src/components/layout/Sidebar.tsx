import {
  BarChart3,
  Bell,
  DollarSign,
  Home,
  Package,
  RefreshCw,
  Settings,
  Share2,
  TrendingUp,
  User,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
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

export function Sidebar({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
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
    const mins = Math.floor((Date.now() - lastUpdated) / 60_000)
    return mins < 1 ? t.status.updatedJustNow : t.status.updatedAgo(mins)
  })()

  return (
    <aside className="flex h-full w-[64px] shrink-0 flex-col border-r border-border bg-background md:w-[232px]">
      <div className="flex items-center gap-2.5 px-[14px] pb-4 pt-5 md:px-5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
          <BarChart3 className="h-5 w-5 text-accent" />
        </div>
        <div className="hidden min-w-0 leading-tight md:block">
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
              <div className="hidden px-2.5 pb-1.5 text-[11px] font-medium text-subtle md:block">
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = view === item.view
                const Icon = item.icon
                return (
                  <button
                    key={item.view}
                    type="button"
                    onClick={() => onNavigate(item.view)}
                    aria-current={active ? 'page' : undefined}
                    title={item.label}
                    className={cn(
                      'flex w-full items-center justify-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors md:justify-start',
                      active
                        ? 'bg-accent font-medium text-white'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="hidden truncate md:block">{item.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="hidden p-3 md:block">
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
