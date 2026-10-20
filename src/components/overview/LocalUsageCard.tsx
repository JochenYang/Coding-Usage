import { ChevronRight, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
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
import type { AgentClientId, AgentPeriodVM, AgentUsageVM } from '@/lib/agent-usage'
import { formatCompactValue } from '@/lib/format'
import workbuddyLogo from '@/components/logos/workbuddy.png'
import zcodeLogo from '@/components/logos/zcode.png'
import { useT } from '@/i18n/useT'
import { useTheme } from '@/components/ThemeProvider'
import { useData } from '@/lib/data-context'
import { displayTokens } from '@/lib/agent-usage'
import { Tooltip } from '@/components/common/Tooltip'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
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
  codebuddy: <CodeBuddy.Color />,
  qoder: <Qoder.Color />,
  kiro: <Kiro.Color />,
  amp: <Amp.Color />,
  dsh: <DeepSeek.Color />,
  // WorkBuddy has no bundled brand mark; use the app's own icon (from its
  // install dir, committed at 1024px)
  workbuddy: <img src={workbuddyLogo} className="h-5 w-5 rounded" alt="" />,
  // Same story for ZCode: lobehub carries no mark, bundle the install-dir icon
  zcode: <img src={zcodeLogo} className="h-5 w-5 rounded" alt="" />,
  // XiaomiMiMo ships no Color variant — its Avatar tile fills the slot
  micode: <XiaomiMiMo.Avatar size={16} />,
  // Pi Agent's mark is a black glyph with no Color variant either
  pi: <Pi.Avatar size={16} />,
  mcode: <Minimax.Color />,
  antigravity: <Antigravity.Color />,
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
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
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
  micode: 'MiMo',
  pi: 'Pi',
  mcode: 'MiniMax Code',
  antigravity: 'Antigravity',
}

interface PeriodColumnProps {
  period: AgentPeriodVM
  exists: boolean
  /** Accounting mode: 'all' counts cache reads, 'no-cache' input+output only */
  mode: 'all' | 'no-cache'
}

/** One right-aligned stat value; the column headers live on the list header row */
function PeriodColumn({ period, exists, mode }: PeriodColumnProps) {
  return (
    <div className="text-right text-xs font-medium tabular-nums text-foreground sm:text-sm">
      {exists ? formatCompactValue(displayTokens(period, mode)) : '—'}
    </div>
  )
}

/**
 * Fixed period-column widths keep the header row aligned with every data row.
 *
 * Narrow viewports get a slimmer, smaller-text grid: the card can be ~280px
 * wide there (375px viewport minus the sidebar), and a hard 220px three-column
 * block left the agent label with no width at all, so names and figures drew on
 * top of each other. Model rows reuse the same grid so their figures stay in
 * the same columns as the parent row's.
 */
const PERIOD_GRID = 'grid w-[150px] shrink-0 grid-cols-3 gap-1 sm:w-[220px] sm:gap-2'

/**
 * Local agent usage (tokscale) card: per-client today / month / all-time token
 * and cost columns plus a manual refresh. Each agent expands to the models it
 * actually called, which is the only place the agent → model attribution is
 * visible: the flat per-model views merge entries from every agent, so the same
 * model id arriving from OpenCode and from Kimi Code is indistinguishable
 * there. Desktop mode only — without the Electron bridge every client degrades
 * to the empty hint.
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
  // Every row's brand mark carries its own <title>, which Chromium would show
  // as a native hover tooltip (see useStripSvgTitle)
  const brandRef = useStripSvgTitle<HTMLElement>()
  // Expanded agents, keyed by client id. Deliberately not persisted: this is a
  // reading aid for the current visit, and a scan refresh must not collapse a
  // panel the user just opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (client: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(client)) next.delete(client)
      else next.add(client)
      return next
    })
  }

  return (
    <section ref={brandRef} className={cn('rounded-2xl border border-border bg-card p-5', className)}>
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
          <Tooltip text={t.card.refresh}>
            <button
              type="button"
              onClick={() => onRefresh()}
              aria-label={t.card.refresh}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </Tooltip>
        </div>
      </div>

      {usage.error ? (
        <Tooltip text={usage.error} className="mt-3 min-w-0" bubbleClassName="max-w-80 whitespace-normal">
          <div className="truncate text-xs text-danger">{usage.error}</div>
        </Tooltip>
      ) : !hasAnyData ? (
        <div className="py-4 text-center text-xs text-subtle">{t.overview.localUsageEmpty}</div>
      ) : (
        <div>
          {/* Degraded fallback: the per-client retry skipped some clients; say
              so instead of silently showing a partial picture. The bubble
              carries the real per-client reason (the main process keeps it);
              most transient skips heal on the next refresh. */}
          {usage.skippedClients != null && usage.skippedClients.length > 0 && (
            <Tooltip
              text={usage.skippedClients
                .map((c) => (usage.skippedDetails?.[c] ? `${c}: ${usage.skippedDetails[c]}` : c))
                .join(' · ')}
              className="mt-1 min-w-0"
              bubbleClassName="max-w-80 whitespace-normal"
            >
              <div className="truncate text-[11px] text-warning">
                {t.overview.localUsagePartial(usage.skippedClients.join(', '))}
              </div>
            </Tooltip>
          )}
          {/* Single column header: replaces the per-row label repetition and
              keeps the three period columns readable as a table. The first
              data row's border-t separates it from the header. */}
          <div className="flex items-center gap-3 pb-1">
            <span className="w-8 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1" aria-hidden />
            <div className={PERIOD_GRID}>
              <span className="text-right text-[11px] text-subtle">{t.overview.todayCol}</span>
              <span className="text-right text-[11px] text-subtle">{t.overview.monthCol}</span>
              <span className="text-right text-[11px] text-subtle">{t.overview.allTimeCol}</span>
            </div>
          </div>
          {usage.clients
            .filter((client) => client.exists)
            .map((client) => {
              const isOpen = expanded.has(client.client)
              const models = client.models
              return (
                <div key={client.client} className="border-t border-border/60">
                  <div className="flex flex-wrap items-center gap-2 py-2.5 sm:flex-nowrap">
                    {/* Chevron sits left of the brand tile so every agent row's
                        logo keeps the same x-offset whether or not the row can
                        expand; the whole label is the hit target. */}
                    <button
                      type="button"
                      onClick={() => toggle(client.client)}
                      aria-expanded={isOpen}
                      aria-label={`${AGENT_LABELS[client.client]} — ${t.overview.agentModelsLabel(models.length)}`}
                      className="flex min-w-0 grow shrink basis-full items-center gap-2 rounded-lg text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:basis-auto"
                    >
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-subtle transition-transform',
                          isOpen && 'rotate-90',
                        )}
                        aria-hidden
                      />
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
                          {`${t.overview.colInput} ${formatCompactValue(client.today.input)} · ${t.overview.colOutput} ${formatCompactValue(client.today.output)} · ${t.overview.colCache} ${formatCompactValue(client.today.cacheRead)}`}
                        </span>
                      </span>
                    </button>
                    <div className={cn(PERIOD_GRID, 'ml-auto')}>
                      {[
                        { period: client.today },
                        { period: client.month },
                        { period: client.allTime },
                      ].map((col, ci) => (
                        <PeriodColumn
                          key={ci}
                          period={col.period}
                          exists={client.exists}
                          mode={mode}
                        />
                      ))}
                    </div>
                  </div>
                  {isOpen && (
                    <div className="pb-2 pl-7 sm:pl-[52px]">
                      {models.length === 0 ? (
                        <p className="py-1 text-[11px] text-subtle">{t.overview.agentModelsEmpty}</p>
                      ) : (
                        <>
                          {/* Visual grouping label only: the button's aria-label
                              already announces the count, so read it once. */}
                          <p className="pb-1 text-[10px] text-subtle" aria-hidden>
                            {t.overview.agentModelsLabel(models.length)}
                          </p>
                          {models.map((row) => (
                            <div
                              key={row.model}
                              className="flex items-center gap-2 py-1.5 [&+&]:border-t [&+&]:border-border/40"
                            >
                              <span
                                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                                title={row.model}
                              >
                                {row.model}
                              </span>
                              <div className={PERIOD_GRID}>
                                {[row.today, row.month, row.allTime].map((period, ci) => {
                                  const value = displayTokens(period, mode)
                                  // A credits-billed or aborted turn records calls
                                  // but no tokens (opencode reports 0/0 for some
                                  // models). Showing "0" reads like a measurement;
                                  // a dash says "no tokens recorded", which is true.
                                  return (
                                    <div
                                      key={ci}
                                      className="text-right text-xs tabular-nums text-muted-foreground"
                                    >
                                      {value > 0 ? formatCompactValue(value) : '—'}
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
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
              <div className={PERIOD_GRID}>
                <PeriodColumn period={usage.other.today} exists mode={mode} />
                <PeriodColumn period={usage.other.month} exists mode={mode} />
                <PeriodColumn period={usage.other.all} exists mode={mode} />
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
