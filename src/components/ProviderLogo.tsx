import type { ReactNode } from 'react'
import {
  Cursor,
  DeepSeek,
  GithubCopilot,
  Kimi,
  Minimax,
  Novita,
  Ollama,
  OpenCode,
  OpenRouter,
  SiliconCloud,
  Stepfun,
  Volcengine,
  Zhipu,
} from '@lobehub/icons'
import { cn } from '@/lib/cn'
import { useTheme } from '@/components/ThemeProvider'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import commandcodeLogo from '@/components/logos/commandcode.png'

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
  // StepFun ships no .Color variant; .Avatar is its colored brand tile
  'stepfun-avatar': <Stepfun.Avatar size={16} />,
  'novita-color': <Novita.Color />,
  // Ollama ships no .Color variant; .Avatar is its colored brand tile
  'ollama-avatar': <Ollama.Avatar size={16} />,
  // Neither brand ships a .Color variant; .Avatar is the colored tile
  'cursor-color': <Cursor.Avatar size={16} />,
  'copilot-color': <GithubCopilot.Avatar size={16} />,
  // Command Code's official app icon (from commandcode.ai), bundled locally
  'commandcode-avatar': <img src={commandcodeLogo} className="h-full w-full rounded" alt="" />,
}

/**
 * Monochrome brand glyphs for decorative use (the card watermark).
 *
 * In this icon set the **default export is the mono glyph** (`var Icons = Mono`),
 * so a bare `<Zhipu />` draws with `currentColor` and carries no inline size —
 * unlike the `.Color` art and the `.Avatar` tiles, which need per-brand sizing
 * and tinting. Kept keyed like `ICON_MAP` so a new provider registers both in
 * one place.
 */
const WATERMARK_MAP: Record<string, ReactNode> = {
  'zhipu-color': <Zhipu />,
  'MiniMax-color': <Minimax />,
  'openrouter-color': <OpenRouter />,
  'kimi-color': <Kimi />,
  opencode: <OpenCode />,
  'deepseek-color': <DeepSeek />,
  'siliconcloud-color': <SiliconCloud />,
  'volcengine-ark': <Volcengine />,
  'stepfun-avatar': <Stepfun />,
  'novita-color': <Novita />,
  'ollama-avatar': <Ollama />,
  'cursor-color': <Cursor />,
  'copilot-color': <GithubCopilot />,
}

/**
 * Decorative glyph for a provider, or null when the definition has none
 * (a locally bundled PNG has no monochrome counterpart).
 */
export function providerWatermarkIcon(def: { logo?: string | ReactNode }): ReactNode {
  // Inline ReactNode logos are already vector art drawn by the definition itself
  if (def.logo && typeof def.logo !== 'string') return def.logo
  if (typeof def.logo === 'string' && WATERMARK_MAP[def.logo]) return WATERMARK_MAP[def.logo]
  return null
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
  // The bundled mark's own <title> would pop a native tooltip on hover (see
  // useStripSvgTitle); the wrapper's aria-label carries the name instead.
  const brandRef = useStripSvgTitle<HTMLDivElement>()

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
        ref={brandRef}
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
