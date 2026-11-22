import type { ReactNode } from 'react'
import {
  Amp,
  Antigravity,
  Claude,
  CodeBuddy,
  Codex,
  Copilot,
  DeepSeek,
  Gemini,
  Kiro,
  Kimi,
  Minimax,
  OpenCode,
  Pi,
  Qoder,
  Qwen,
  Trae,
  XiaomiMiMo,
} from '@lobehub/icons'
import type { AgentClientId } from '@/lib/agent-usage'
import { AGENT_LABELS } from '@/lib/agent-labels'
import { cn } from '@/lib/cn'
import workbuddyLogo from '@/components/logos/workbuddy.png'
import zcodeLogo from '@/components/logos/zcode.png'
import cindyLogo from '@/components/logos/cindy.png'

/**
 * Brand marks of the local agents (tokscale clients), shared by every overview
 * surface that lists agents — the usage table, the account usage card — so an
 * agent looks the same wherever it appears. Their names live in
 * lib/agent-labels, next to the scan summary that also labels slices with them.
 */

/**
 * Bundled brand marks from @lobehub/icons (same icon set as the provider
 * logos). Partial on purpose: brands without a recognizable mark (Cline,
 * RooCode, Zed, …) degrade to the letter tile at render time. OpenCode ships
 * no .Color variant — its .Avatar tile fills the slot.
 */
export const AGENT_ICONS: Partial<Record<AgentClientId, ReactNode>> = {
  codex: <Codex.Color />,
  claude: <Claude.Color />,
  kimi: <Kimi.Color />,
  opencode: <OpenCode.Avatar size={16} />,
  gemini: <Gemini.Color />,
  qwen: <Qwen.Color />,
  copilot: <Copilot.Color />,
  trae: <Trae.Color />,
  codebuddy: <CodeBuddy.Color />,
  qoder: <Qoder.Color />,
  // Both Qoder builds share the brand mark; the row label tells them apart
  'qoder-global': <Qoder.Color />,
  kiro: <Kiro.Color />,
  amp: <Amp.Color />,
  dsh: <DeepSeek.Color />,
  // WorkBuddy has no bundled brand mark; use the app's own icon (from its
  // install dir, committed at 1024px)
  workbuddy: <img src={workbuddyLogo} className="h-5 w-5 rounded" alt="" />,
  // Same story for ZCode: lobehub carries no mark, bundle the install-dir icon
  zcode: <img src={zcodeLogo} className="h-5 w-5 rounded" alt="" />,
  // Cindy's app icon (from its install dir, committed at 512px): lobehub has
  // no mark for it either. Both builds share the product mark — they are one
  // application, told apart by the row label.
  cindy: <img src={cindyLogo} className="h-5 w-5 rounded" alt="" />,
  'cindy-global': <img src={cindyLogo} className="h-5 w-5 rounded" alt="" />,
  // XiaomiMiMo ships no Color variant — its Avatar tile fills the slot
  micode: <XiaomiMiMo.Avatar size={16} />,
  // Pi Agent's mark is a black glyph with no Color variant either
  pi: <Pi.Avatar size={16} />,
  mcode: <Minimax.Color />,
  antigravity: <Antigravity.Color />,
}

/**
 * An agent's mark, or the first letter of its name when the brand has none.
 * `kimi` is passed `invert` because its mark is a white K on a dark tile,
 * which has to flip on the light theme the way `logoDarkInvert` marks do.
 */
export function agentMark(client: AgentClientId, invertKimi: boolean, className: string): ReactNode {
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-[11px] font-semibold text-muted-foreground [&>svg]:h-5 [&>svg]:w-5',
        client === 'kimi' && invertKimi && '[&>svg]:invert',
        className,
      )}
      aria-hidden
    >
      {AGENT_ICONS[client] ?? AGENT_LABELS[client][0]}
    </span>
  )
}
