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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform, useVelocity } from 'motion/react'
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

/**
 * The glide of the nav highlight from one item to the next. Bouncy on purpose:
 * it overshoots the item it lands on by about a quarter of its height and
 * settles — with the stretch below, that is the jelly feel. More bounce than
 * this and the highlight runs into the next item.
 */
const NAV_GLIDE = { type: 'spring', stiffness: 360, damping: 27, mass: 0.9 } as const
/** Jelly: the highlight stretches with its speed, up to this much */
const STRETCH_PER_SPEED = 0.28 / 2000
const MAX_STRETCH = 0.4

/**
 * One highlight's motion values: where it is, whether it shows, and how far
 * it is stretched. All of it is driven off `y`'s velocity, so the glide and
 * the deformation are one movement, and nothing here goes through React
 * state — hovering never re-renders the rail.
 */
function useNavHighlight() {
  const y = useMotionValue(0)
  const height = useMotionValue(0)
  const opacity = useMotionValue(0)
  const speed = useVelocity(y)
  // Stretches along its travel and narrows across it, the way a blob keeps
  // its area; at rest the speed is zero and it is exactly the item's box
  const stretch = useTransform(speed, (v) => 1 + Math.min(Math.abs(v) * STRETCH_PER_SPEED, MAX_STRETCH))
  const squash = useTransform(stretch, (s) => 1 / Math.sqrt(s))
  // Grows from the trailing edge, so the leading edge runs ahead
  const originY = useTransform(speed, (v) => (v >= 0 ? 0 : 1))
  return { y, height, opacity, stretch, squash, originY }
}

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
  const reduced = useReducedMotion()

  // The two highlights behind the items (hover, active): one element each,
  // moved between the items' boxes. Nothing of this is React state, so a
  // pointer passing over the items costs no render.
  const navRef = useRef<HTMLElement>(null)
  const itemRefs = useRef(new Map<View, HTMLButtonElement>())
  const hoveredRef = useRef<View | null>(null)
  const hover = useNavHighlight()
  const active = useNavHighlight()
  /** An item's box in the nav's own coordinates, so it holds while the nav scrolls */
  const boxOf = (button: HTMLElement): { top: number; height: number } => {
    const nav = navRef.current
    if (!nav) return { top: 0, height: 0 }
    const navBox = nav.getBoundingClientRect()
    const box = button.getBoundingClientRect()
    return { top: box.top - navBox.top + nav.scrollTop, height: box.height }
  }
  const glideTo = (highlight: ReturnType<typeof useNavHighlight>, button: HTMLElement): void => {
    const { top, height } = boxOf(button)
    // Reduced motion: land in place, only the fade is kept
    if (reduced) {
      highlight.y.set(top)
      highlight.height.set(height)
      return
    }
    animate(highlight.y, top, NAV_GLIDE)
    animate(highlight.height, height, NAV_GLIDE)
  }
  const snapTo = (highlight: ReturnType<typeof useNavHighlight>, button: HTMLElement): void => {
    const { top, height } = boxOf(button)
    highlight.y.set(top)
    highlight.height.set(height)
  }

  // The active highlight: in place on the first paint and when the rail is
  // resized (collapsing hides the group labels, which moves the items), a
  // glide when the view changes
  const placedRef = useRef(false)
  const wasCollapsed = useRef(collapsed)
  useLayoutEffect(() => {
    const button = itemRefs.current.get(view)
    if (!button) return
    const resize = !placedRef.current || wasCollapsed.current !== collapsed
    placedRef.current = true
    wasCollapsed.current = collapsed
    if (resize) snapTo(active, button)
    else glideTo(active, button)
    // The click that changed the view left the pointer on this item: its
    // hover highlight has nothing left to show
    if (hoveredRef.current === view) animate(hover.opacity, 0, { duration: 0.12 })
    // `t` is not read here, but a locale switch relabels the items and moves them
  }, [view, collapsed, t])

  // Window height and font loading move the items too: follow without animating
  useEffect(() => {
    const nav = navRef.current
    if (!nav || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const current = itemRefs.current.get(view)
      if (current) snapTo(active, current)
      const hoveredButton = hoveredRef.current ? itemRefs.current.get(hoveredRef.current) : undefined
      if (hoveredButton && hover.opacity.get() > 0) snapTo(hover, hoveredButton)
    })
    observer.observe(nav)
    return () => observer.disconnect()
  }, [view, active, hover])

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

      <nav
        ref={navRef}
        // Leaving the rail as a whole fades the hover highlight out where it
        // stands; coming back elsewhere glides from there while fading in
        onPointerLeave={() => {
          hoveredRef.current = null
          animate(hover.opacity, 0, { duration: 0.18 })
        }}
        className="relative flex-1 space-y-4 overflow-y-auto px-2 pb-4 md:px-3"
      >
        {/* The two highlights, behind the items (-z-10 in the rail's stacking
            context). inset mirrors the nav's own padding, so each one is
            exactly as wide as the items */}
        <motion.span
          aria-hidden
          style={{
            y: hover.y,
            height: hover.height,
            opacity: hover.opacity,
            scaleY: hover.stretch,
            scaleX: hover.squash,
            originY: hover.originY,
          }}
          className="pointer-events-none absolute inset-x-2 -z-10 rounded-lg bg-muted md:inset-x-3"
        />
        <motion.span
          aria-hidden
          style={{ y: active.y, height: active.height, scaleY: active.stretch, scaleX: active.squash, originY: active.originY }}
          className="pointer-events-none absolute inset-x-2 -z-10 rounded-lg bg-accent md:inset-x-3"
        />
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
                const activeItem = view === item.view
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
                      ref={(el) => {
                        if (el) itemRefs.current.set(item.view, el)
                        else itemRefs.current.delete(item.view)
                      }}
                      onClick={() => onNavigate(item.view)}
                      onPointerEnter={(event) => {
                        hoveredRef.current = item.view
                        // Hovering the active item shows its own highlight only
                        animate(hover.opacity, activeItem ? 0 : 1, { duration: 0.12 })
                        if (!activeItem) glideTo(hover, event.currentTarget)
                      }}
                      aria-label={item.label}
                      aria-current={activeItem ? 'page' : undefined}
                      className={cn(
                        // The backgrounds live in the two highlight layers at
                        // the top of the nav, not on the button itself
                        'flex w-full items-center justify-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                        collapsed ? '' : 'md:justify-start',
                        activeItem ? 'font-medium text-white' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className={cn('truncate text-sm', collapsed ? 'hidden' : 'hidden md:block')}>
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
