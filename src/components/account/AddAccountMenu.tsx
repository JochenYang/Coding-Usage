import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { ProviderLogo } from '@/components/ProviderLogo'
import { PROVIDERS } from '@/providers/registry'
import { useData } from '@/lib/data-context'
import { getProviderEntries } from '@/lib/storage'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/cn'

/**
 * Shared "Add account" trigger: accent button + plain dropdown provider picker.
 *
 * Deliberately does NOT use the beui Popover: its goo/animation layer left a
 * visible halo around the trigger (reported repeatedly as a "ring border").
 * This is a bare controlled dropdown — same UX, zero ghost paint, and it
 * behaves identically on all three pages that host it.
 */
export function AddAccountMenu({
  onAdd,
  className,
  label,
}: {
  onAdd: (providerId: string, newIndex: number) => void
  className?: string
  /** Override the default "Add account" copy (e.g. "添加套餐计划" on the plans page) */
  label?: string
}) {
  const t = useT()
  const { settings } = useData()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside pointer / Escape, same semantics as the beui popover
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white outline-none transition-colors hover:bg-accent-strong',
          className,
        )}
      >
        <Plus className="h-4 w-4" />
        {label ?? t.settings.addAccount}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-xl border border-border bg-popover p-1 shadow-lg">
          {PROVIDERS.map((def) => (
            <button
              key={def.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onAdd(def.id, getProviderEntries(settings, def.id).length)
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-popover-foreground transition-colors hover:bg-muted"
            >
              <ProviderLogo def={def} className="h-6 w-6" imgClassName="h-4 w-4" />
              {def.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
