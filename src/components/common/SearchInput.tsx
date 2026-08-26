import { useRef } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SearchInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}

/** Controlled text input with a leading search icon and a clear button when non-empty */
export function SearchInput({ value, onChange, placeholder, className }: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-8 text-sm text-foreground outline-none placeholder:text-subtle focus:ring-2 focus:ring-ring/40"
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-0.5 transition-colors hover:bg-muted"
        >
          <X className="h-3.5 w-3.5 text-subtle hover:text-foreground" />
        </button>
      )}
    </div>
  )
}
