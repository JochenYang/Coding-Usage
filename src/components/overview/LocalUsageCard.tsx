import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Amp,
  Claude,
  Codex,
  Copilot,
  DeepSeek,
  Gemini,
  Kiro,
  Kimi,
  OpenCode,
  Qwen,
  Trae,
} from '@lobehub/icons'
import type { AgentClientId, AgentPeriodVM, AgentUsageVM } from '@/lib/agent-usage'
import { formatCompactValue } from '@/lib/format'
import workbuddyLogo from '@/components/logos/workbuddy.png'
import zcodeLogo from '@/components/logos/zcode.png'
import { useT } from '@/i18n/useT'
import { useTheme } from '@/components/ThemeProvider'
import { useData } from '@/lib/data-context'
import { displayTokens } from '@/lib/agent-usage'
import { cn } from '@/lib/cn'

export interface LocalUsageCardProps {
  usage: AgentUsageVM
  loading: boolean
  onRefresh: () => void
  className?: string
}

/**
 * Bundled brand marks from @lobehub/icons (same icon set as the provider
 * logos). Partial on purpose: brands without a recognizable mark (Cline,
 * RooCode, Zed, …) degrade to the letter tile at render time. OpenCode ships
 * no .Color variant — its .Avatar tile fills the slot.
 */
const AGENT_ICONS: Partial<Record<AgentClientId, ReactNode>> = {
  codex: <Codex.Color />,
  claude: <Claude.Color />,
  kimi: <Kimi.Color />,
  opencode: <OpenCode.Avatar size={16} />,
  gemini: <Gemini.Color />,
  qwen: <Qwen.Color />,
  copilot: <Copilot.Color />,
  trae: <Trae.Color />,
  kiro: <Kiro.Color />,
  amp: <Amp.Color />,
  dsh: <DeepSeek.Color />,
  // WorkBuddy has no bundled brand mark; use the app's own icon (from its
  // install dir, committed at 1024px)
  workbuddy: <img src={workbuddyLogo} className="h-5 w-5 rounded" alt="" />,
  // Same story for ZCode: lobehub carries no mark, bundle the install-dir icon
  zcode: <img src={zcodeLogo} className="h-5 w-5 rounded" alt="" />,
}

/** Proper nouns — brand names, not translated. Ids = tokscale client ids. */
const AGENT_LABELS: Record<AgentClientId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  kimi: 'Kimi Code',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  qwen: 'Qwen Code',
  trae: 'Trae',
  workbuddy: 'WorkBuddy',
  cline: 'Cline',
  roocode: 'Roo Code',
  kilocode: 'Kilo Code',
  goose: 'Goose',
  zed: 'Zed',
  kiro: 'Kiro',
  augment: 'Augment',
  droid: 'Droid',
  amp: 'Amp',
  grok: 'Grok Build',
  dsh: 'DSH',
  zcode: 'ZCode',
}

interface PeriodColumnProps {
  label: string
  period: AgentPeriodVM
  exists: boolean
  /** Accounting mode: 'all' counts cache reads, 'no-cache' input+output only */
  mode: 'all' | 'no-cache'
}

/** One right-aligned stat column: label + token count */
function PeriodColumn({ label, period, exists, mode }: PeriodColumnProps) {
  return (
    <div className="text-right">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="text-sm font-medium tabular-nums text-foreground">
        {exists ? formatCompactValue(displayTokens(period, mode)) : '—'}
      </div>
    </div>
  )
}

/**
 * Local agent usage (tokscale) card: per-client today / month / all-time token
 * and cost columns plus a manual refresh. Desktop mode only — without the
 * Electron bridge every client degrades to the empty hint.
 */
export function LocalUsageCard({ usage, loading, onRefresh, className }: LocalUsageCardProps) {
  const t = useT()
  const { resolved } = useTheme()
  const { settings } = useData()
  const mode = settings.usageDisplayMode
  const hasAnyData = usage.clients.some((c) => c.exists)
  // Kimi's brand mark is a white K on a dark tile: flip it on the light theme
  // the same way ProviderLogo handles logoDarkInvert marks.
  const invertOnLight = resolved === 'light'

  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-foreground">{t.overview.localUsageTitle}</h2>
        <div className="flex items-center gap-2">
          {/* Snapshot age: the startup cache replays last launch's numbers, so
              say explicitly how fresh the figures are */}
          {!loading && usage.scannedAt != null && (
            <span className="text-[11px] text-subtle tabular-nums">
              {`${t.overview.asOfPrefix} ${new Date(usage.scannedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}`}
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t.card.refresh}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {usage.error ? (
        <div className="mt-3 truncate text-xs text-danger" title={usage.error}>
          {usage.error}
        </div>
      ) : !hasAnyData ? (
        <div className="py-4 text-center text-xs text-subtle">{t.overview.localUsageEmpty}</div>
      ) : (
        <div>
          {/* Degraded fallback: the per-client retry skipped some clients; say
              so instead of silently showing a partial picture */}
          {usage.skippedClients != null && usage.skippedClients.length > 0 && (
            <div
              className="mt-1 truncate text-[11px] text-warning"
              title={usage.skippedClients.join(', ')}
            >
              {t.overview.localUsagePartial(usage.skippedClients.join(', '))}
            </div>
          )}
          {usage.clients
            .filter((client) => client.exists)
            .map((client) => (
            <div
              key={client.client}
              className="flex items-center gap-3 border-t border-border/60 py-2.5 first:border-t-0"
            >
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-[11px] font-semibold text-muted-foreground [&>svg]:h-5 [&>svg]:w-5',
                  client.client === 'kimi' && invertOnLight && '[&>svg]:invert',
                )}
                aria-hidden
              >
                {AGENT_ICONS[client.client] ?? AGENT_LABELS[client.client][0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {AGENT_LABELS[client.client]}
                </span>
                {/* Consumption breakdown makes the counting口径 visible */}
                <span className="block truncate text-[10px] text-subtle">
                  {client.exists
                    ? `${t.overview.colInput} ${formatCompactValue(client.today.input)} · ${t.overview.colOutput} ${formatCompactValue(client.today.output)} · ${t.overview.colCache} ${formatCompactValue(client.today.cacheRead)}`
                    : ''}
                </span>
              </span>
              <div className="grid min-w-[220px] grid-cols-3 gap-2">
                {[
                  { label: t.overview.todayCol, period: client.today },
                  { label: t.overview.monthCol, period: client.month },
                  { label: t.overview.allTimeCol, period: client.allTime },
                ].map((col) => (
                  <PeriodColumn
                    key={col.label}
                    label={col.label}
                    period={col.period}
                    exists={client.exists}
                    mode={mode}
                  />
                ))}
              </div>
            </div>
          ))}
          {/* Unclassified (synthetic) entries keep the four rows summing to totals */}
          {usage.other && usage.other.all.tokens > 0 && (
            <div className="flex items-center gap-3 border-t border-border/60 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-[10px] font-semibold text-muted-foreground" aria-hidden>
                …
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {t.overview.distOther}
                </span>
                <span className="block truncate text-[10px] text-subtle">
                  {t.overview.colInput} {formatCompactValue(usage.other.all.input)} · {t.overview.colOutput} {formatCompactValue(usage.other.all.output)} · {t.overview.colCache} {formatCompactValue(usage.other.all.cacheRead)}
                </span>
              </span>
              <div className="grid min-w-[220px] grid-cols-3 gap-2">
                <PeriodColumn label={t.overview.todayCol} period={usage.other.today} exists mode={mode} />
                <PeriodColumn label={t.overview.monthCol} period={usage.other.month} exists mode={mode} />
                <PeriodColumn label={t.overview.allTimeCol} period={usage.other.all} exists mode={mode} />
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
