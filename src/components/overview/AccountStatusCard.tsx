import { ShieldCheck, Sparkles } from 'lucide-react'
import type { AgentClientId } from '@/lib/agent-usage'
import { formatCompactValue } from '@/lib/format'
import { useTheme } from '@/components/ThemeProvider'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/cn'
import { agentMark } from './agent-brand'
import { AGENT_LABELS } from '@/lib/agent-labels'

export interface AccountStatusItem {
  client: AgentClientId
  /** All-time tokens this agent consumed — the figure the card ranks by */
  allTimeTokens: number
  /** True when the agent recorded usage today (tokens, credits or calls) */
  usedToday: boolean
}

export interface AccountStatusCardProps {
  items: AccountStatusItem[]
  className?: string
}

/**
 * "Account usage" card: the three heaviest local agents, each with its
 * all-time figure and whether it ran today. Deliberately plain about what it
 * knows — the overview holds no subscription-quota state (those live inside
 * the plan cards on the plans page), so the status says "in use today" or
 * "not used today" and nothing it would have to guess at.
 */
export function AccountStatusCard({ items, className }: AccountStatusCardProps) {
  const t = useT()
  const { resolved } = useTheme()
  // Kimi's brand mark is a white K on a dark tile: flip it on the light theme
  const invertOnLight = resolved === 'light'

  return (
    <section className={cn('flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-foreground">
          <ShieldCheck className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="truncate">{t.overview.accountStatusTitle}</span>
        </h2>
        {/* The figures are all-time totals: said once for the row of three
            instead of being repeated in every tile */}
        {items.length > 0 && (
          <span className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
            {t.overview.allTimeCol}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{t.overview.localUsageEmpty}</p>
      ) : (
        <div className="mt-4 grid flex-1 grid-cols-3 content-start gap-2">
          {items.map((item) => (
            <div key={item.client} className="min-w-0 rounded-xl border border-border p-3">
              {agentMark(item.client, invertOnLight, 'h-7 w-7 rounded-md [&>svg]:h-4 [&>svg]:w-4')}
              <div className="mt-2 truncate text-xs font-medium text-foreground" title={AGENT_LABELS[item.client]}>
                {AGENT_LABELS[item.client]}
              </div>
              <div className="mt-0.5 text-lg font-semibold leading-tight tabular-nums text-foreground">
                {formatCompactValue(item.allTimeTokens)}
              </div>
              <div
                className={cn(
                  'mt-1.5 flex items-center gap-1 text-[11px]',
                  item.usedToday ? 'text-online-text' : 'text-muted-foreground',
                )}
              >
                {item.usedToday && <Sparkles className="h-3 w-3 shrink-0" aria-hidden />}
                <span className="truncate">
                  {item.usedToday ? t.overview.agentInUse : t.overview.agentIdleToday}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
