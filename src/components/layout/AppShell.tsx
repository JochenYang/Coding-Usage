import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { UpdateToast } from './UpdateToast'
import { AlertIsland } from './AlertIsland'
import type { View } from '@/lib/router'

/** Desktop shell: fixed sidebar + top bar + scrollable content column */
export function AppShell({
  view,
  navigate,
  children,
}: {
  view: View
  navigate: (v: View) => void
  children: ReactNode
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar view={view} onNavigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onNavigate={navigate} />
        {/* relative: form sr-only labels are position:absolute without offsets —
            without a positioned ancestor here their containing block is the root
            element, so a long page's labels escape main's overflow clipping and
            stretch the document (double scrollbar on the integrations page) */}
        <main className="relative flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">{children}</div>
        </main>
      </div>
      {/* Fixed-position alert surface: dynamic island for newly raised alerts */}
      <AlertIsland />
      {/* Fixed-position overlay; self-hides in browser dev (no desktop bridge) */}
      <UpdateToast />
    </div>
  )
}
