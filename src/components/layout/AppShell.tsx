import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
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
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  )
}
