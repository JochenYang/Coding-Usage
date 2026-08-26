import type { ReactNode } from 'react'
import { DeepSeek, Kimi, Minimax, OpenCode, OpenRouter, SiliconCloud, Volcengine, Zhipu } from '@lobehub/icons'
import { cn } from '@/lib/cn'
import { useTheme } from '@/components/ThemeProvider'

/**
 * Brand icon registry: maps a ProviderDef.logo slug to a bundled
 * @lobehub/icons component. Icons ship inside the app bundle, so brand marks
 * render offline with zero network dependency (this replaces the old
 * unpkg CDN <img> path). Unknown slugs fall back to the letter block below.
 */
const ICON_MAP: Record<string, ReactNode> = {
  'zhipu-color': <Zhipu.Color />,
  'MiniMax-color': <Minimax.Color />,
  'openrouter-color': <OpenRouter.Color />,
  'kimi-color': <Kimi.Color />,
  // OpenCode ships no .Color variant; .Avatar is its colored brand tile
  // (size is required by AvatarProps; the wrapper CSS forces the svg to fill)
  opencode: <OpenCode.Avatar size={16} />,
  'deepseek-color': <DeepSeek.Color />,
  'siliconcloud-color': <SiliconCloud.Color />,
  'volcengine-ark': <Volcengine.Color />,
}

/**
 * Provider brand mark. Priority:
 * 1. `logo` is a ReactNode (inline SVG) → render directly
 * 2. `logo` is a registry slug → render the bundled brand component
 * 3. neither / unknown slug → letter block
 */
export function ProviderLogo({
  def,
  className = 'h-9 w-9',
  imgClassName = 'h-5 w-5',
}: {
  def: { name: string; logo?: string | ReactNode; logoDarkInvert?: boolean }
  className?: string
  imgClassName?: string
}) {
  const { resolved } = useTheme()
  const letter = def.name[0] ?? '?'
  // Some brand marks are drawn in white (dark-background art, e.g. Kimi's K):
  // flip them on the light theme so they stay visible on the white cards.
  const invertOnLight = def.logoDarkInvert && resolved === 'light'

  // 1. Inline ReactNode (self-filled)
  if (def.logo && typeof def.logo !== 'string') {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-md',
          className,
        )}
        aria-label={def.name}
      >
        {def.logo}
      </div>
    )
  }

  // 2. Bundled brand icon (offline-safe)
  if (typeof def.logo === 'string' && ICON_MAP[def.logo]) {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-md',
          className,
        )}
        aria-label={def.name}
      >
        <span
          className={cn(
            '[&>svg]:h-full [&>svg]:w-full',
            imgClassName,
            invertOnLight && '[&>svg]:invert',
          )}
        >
          {ICON_MAP[def.logo]}
        </span>
      </div>
    )
  }

  // 3. Letter fallback
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-muted-foreground',
        className,
      )}
      aria-label={def.name}
    >
      {letter}
    </div>
  )
}
