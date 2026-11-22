import type { CSSProperties, ReactNode } from 'react'
import { Sidebar, useSidebarCollapsed } from './Sidebar'
import { TopBar } from './TopBar'
import { UpdateToast } from './UpdateToast'
import { AlertIsland } from './AlertIsland'
import type { View } from '@/lib/router'
import bottomWave from '@/assets/dashboard/bottom-wave.svg'
// The overview's mascot, cut from the design sheet (assets/images/dashborad.png):
// transparent background, shown at half its pixel size (2x for sharpness)
import panda from '@/assets/dashboard/panda.png'

/**
 * Desktop shell: a sidebar rail and a top bar laid over the scroll area, and
 * a footer wave at the end of the page.
 *
 * The scroll area starts under the top bar (so the scrollbar keeps its place)
 * and spans the window's width, the rail included: the rail and the top bar
 * sit on top of it and stay put while the page scrolls, the page gives way to
 * the rail's width, and the wave — the last thing on every page, in flow, so
 * it shows only once the page is scrolled to its end — runs the full width
 * underneath the transparent rail.
 *
 * Stacking, on purpose:
 * - The shell root is the one stacking context; the page wrapper is not one,
 *   so overlays opened from a page (drawers, confirm dialogs) join the shell's
 *   order instead of being trapped under the rail and the top bar. For the
 *   same reason a page must not render them inside a card that is a stacking
 *   context of its own (`relative z-0`, `isolate`).
 * - The top bar is a positioned layer without a z-index: the confirm dialog
 *   it renders keeps its own order. It never overlaps the scroll area.
 * - The rail needs a z-index to stay clickable over the scroll area that
 *   spans its width; nothing that opens overlays is rendered inside it.
 */
export function AppShell({
  view,
  navigate,
  children,
}: {
  view: View
  navigate: (v: View) => void
  children: ReactNode
}) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed()
  return (
    <div
      className="relative isolate h-screen overflow-hidden bg-background text-foreground"
      // Shared measures, each defined once. --rail-w is what the rail is wide
      // on md+ (64 collapsed, 232 expanded) and what the page's left edge and
      // the top bar's left edge give way to; --topbar-h is the top bar's height
      // and where the scroll area starts. --footer-wave-h tracks the viewport
      // rather than the spacing scale: it is the one element sized against the
      // window edge, not against the content, and also sets the room the page
      // keeps above it.
      style={
        {
          '--rail-w': collapsed ? '64px' : '232px',
          '--topbar-h': '3.5rem',
          '--footer-wave-h': 'clamp(6rem, 12vw, 12rem)',
        } as CSSProperties
      }
    >
      {/* Rail and top bar first in the document: keyboard focus reaches them
          before the page's content, as it did before the shell was reworked */}
      <div className="absolute inset-y-0 left-0 z-10">
        <Sidebar
          view={view}
          onNavigate={navigate}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      </div>
      <div className="absolute top-0 right-0 left-[64px] transition-[left] duration-200 md:left-(--rail-w)">
        <TopBar onNavigate={navigate} />
      </div>

      <main className="absolute inset-x-0 bottom-0 top-(--topbar-h) overflow-y-auto">
        <div className="relative flex min-h-full flex-col">
          <div className="flex flex-1 flex-col pl-[64px] transition-[padding-left] duration-200 md:pl-(--rail-w)">
            {/* relative: form sr-only labels are position:absolute without
                offsets — without a positioned ancestor here their containing
                block is the root element, so a long page's labels escape main's
                overflow clipping and stretch the document (double scrollbar on
                the integrations page).
                md:pl-0: from md on, the rail's own 12px inner padding is the
                whole gap between the rail's content and the page — the same
                as the margin between the window edge and the rail's content,
                collapsed or not */}
            <div className="relative mx-auto w-full max-w-[1280px] px-4 pt-6 sm:px-6 md:pl-0">{children}</div>
            {/* Room above the wave: the page's last rows stop just inside the
                top of it (which is ~24px of pale band), not under it */}
            <div aria-hidden className="shrink-0 grow basis-[calc(var(--footer-wave-h)-1.5rem)]" />
          </div>
          {/* Footer wave on every page. A child of the page wrapper, so it sits
              at the end of the PAGE (it scrolls in with the content and is off
              screen until the page is scrolled to its end), not at the bottom
              of the window; -z-10 keeps it behind the page's cards */}
          <div
            aria-hidden
            data-decor="wave"
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[var(--footer-wave-h)]"
          >
            <img src={bottomWave} alt="" className="h-full w-full select-none object-fill dark:opacity-30" />
          </div>
          {/* The overview's mascot, flush in the page's bottom-right corner on
              the wave. Placed here, not by the page: the content column is
              padded and centred, and the corner belongs to the window */}
          {view === 'overview' && (
            <img
              src={panda}
              alt=""
              aria-hidden
              data-decor="panda"
              className="pointer-events-none absolute right-0 bottom-0 z-10 w-[184px] select-none"
            />
          )}
        </div>
      </main>
      {/* Fixed-position alert surface: dynamic island for newly raised alerts */}
      <AlertIsland />
      {/* Fixed-position overlay; self-hides in browser dev (no desktop bridge) */}
      <UpdateToast />
    </div>
  )
}
