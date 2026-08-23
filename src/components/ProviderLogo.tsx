import { useState } from 'react'
import type { ProviderDef } from '../types'
import { cn } from '@/lib/cn'

const CDN = 'https://unpkg.com/@lobehub/icons-static-svg@latest/icons'

/**
 * Provider brand mark for the top-left of a card. Priority:
 * 1. logo is a ReactNode (inline SVG / component) → render directly
 * 2. logo is a string (lobehub slug) → load via CDN <img>, fall back to a letter on error
 * 3. neither → letter block
 */
export function ProviderLogo({
  def,
  className = 'h-9 w-9',
  imgClassName = 'h-5 w-5',
}: {
  def: ProviderDef
  className?: string
  imgClassName?: string
}) {
  const [errored, setErrored] = useState(false)
  const letter = def.logoLetter ?? def.name[0] ?? '?'
  const letterBox = (
    <div
      className={`flex shrink-0 items-center justify-center rounded-md bg-stone-900 text-sm font-semibold text-stone-50 ${className}`}
      aria-label={def.name}
    >
      {letter}
    </div>
  )

  // 1. Inline ReactNode (self-filled)
  if (def.logo && typeof def.logo !== 'string') {
    return (
      <div
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md ${className}`}
        aria-label={def.name}
      >
        {def.logo}
      </div>
    )
  }

  // 2. lobehub CDN
  if (typeof def.logo === 'string') {
    if (errored) return letterBox
    const url = `${CDN}/${def.logo}.svg`
    return (
      <div
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-card ${className}`}
      >
        <img
          src={url}
          alt={def.name}
          loading="lazy"
          onError={() => setErrored(true)}
          className={cn(imgClassName, def.logoDarkInvert && 'invert dark:invert-0')}
        />
      </div>
    )
  }

  // 3. No logo
  return letterBox
}
