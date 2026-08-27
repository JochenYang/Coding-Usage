import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { PlanCardVM, PlanWindowVM } from '@/lib/overview'
import { currencySymbol, formatAmount, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { Badge } from '@/components/common/Badge'
import { ProgressBar } from '@/components/common/ProgressBar'
import { ProviderLogo } from '@/components/ProviderLogo'
import { useT } from '@/i18n/useT'

export interface PlanCardsRowProps {
  cards: PlanCardVM[]
  onAdd: () => void
  className?: string
}

/** Balance payload of a plan card (NonNullable keeps it in sync with the VM) */
type BalanceVM = NonNullable<PlanCardVM['balance']>

/** Logo + name column + status badge shared by every card variant */
function CardHeader({ card }: { card: PlanCardVM }) {
  const t = useT()

  return (
    <div className="flex items-center gap-3">
      <ProviderLogo def={card.logoDef} className="h-8 w-8" imgClassName="h-4.5 w-4.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-foreground">{card.accountName}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {`${card.providerName} · ${card.accountName}`}
        </div>
      </div>
      <Badge
        tone={
          card.status === 'error'
            ? 'danger'
            : card.status === 'ok'
              ? card.attention
                ? 'warning'
                : 'success'
              : 'neutral'
        }
      >
        {card.status === 'error'
          ? t.card.error
          : card.status === 'ok'
            ? card.attention
              ? t.card.error
              : t.overview.planNormal
            : t.card.unconfigured}
      </Badge>
    </div>
  )
}

/** One usage window: label/pct line, fill bar, optional countdown */
function WindowRow({ win, now }: { win: PlanWindowVM; now: number }) {
  const t = useT()

  // Usage tone escalates as the window fills up
  const pctTone =
    win.pct >= 100 ? 'text-danger' : win.pct >= 70 ? 'text-warning' : 'text-foreground'

  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{win.label}</span>
        {win.unlimited ? (
          <span className="shrink-0 font-medium text-online">{t.overview.weeklyUnlimited}</span>
        ) : (
          <span className={cn('shrink-0 tabular-nums', pctTone)}>{`${Math.round(win.pct)}%`}</span>
        )}
      </div>

      {/* Unlimited windows have no meaningful fill ladder, so paint a flat green bar */}
      {win.unlimited ? (
        <div className="mt-2 h-1.5 w-full rounded-full bg-online" />
      ) : (
        <ProgressBar percent={win.pct} size="sm" className="mt-2" />
      )}

      {win.resetsAt != null && (
        <div className="mt-1.5 text-[11px] text-subtle">{formatCountdown(win.resetsAt, now, t)}</div>
      )}
    </div>
  )
}

/** Balance figure plus its detail rows (top-up / grant breakdown) */
function BalanceBlock({ balance }: { balance: BalanceVM }) {
  const t = useT()

  return (
    <>
      <div className="mt-4 text-xs text-muted-foreground">
        {t.provider.balanceLabel(balance.currency)}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        {`${currencySymbol(balance.currency)}${formatAmount(balance.amount)}`}
      </div>
      {balance.details.length > 0 && (
        <div className="mt-4 space-y-2">
          {/* Label is provider-supplied and may repeat, hence the index in the key */}
          {balance.details.map((d, i) => (
            <div
              key={`${d.label}-${i}`}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className="min-w-0 truncate text-muted-foreground">{d.label}</span>
              <span className="shrink-0 tabular-nums text-foreground">{formatAmount(d.value)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** Default card: window list first, balance section appended when present */
function PlanCard({ card, now }: { card: PlanCardVM; now: number }) {
  const t = useT()
  return (
    <article className="w-full rounded-2xl border border-border bg-card p-5">
      <CardHeader card={card} />
      {card.windows.length > 0 ? (
        <div className="mt-4 space-y-3">
          {card.windows.map((win) => (
            <WindowRow key={win.id} win={win} now={now} />
          ))}
        </div>
      ) : card.balance ? (
        <BalanceBlock balance={card.balance} />
      ) : (
        <p className="mt-4 text-xs text-subtle">{t.card.unconfigured}</p>
      )}
    </article>
  )
}

/** Balance-only variant (DeepSeek-style accounts expose no percent windows) */
function BalanceCard({ card }: { card: PlanCardVM }) {
  const t = useT()
  return (
    <article className="w-full rounded-2xl border border-border bg-card p-5">
      <CardHeader card={card} />
      {card.balance ? (
        <BalanceBlock balance={card.balance} />
      ) : (
        <p className="mt-4 text-xs text-subtle">{t.card.unconfigured}</p>
      )}
    </article>
  )
}

/** "Plan overview" block: header row plus a horizontally scrollable card row */
export function PlanCardsRow({ cards, onAdd, className }: PlanCardsRowProps) {
  const t = useT()
  const now = useNowTick()

  return (
    <section className={className}>
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-foreground">{t.overview.plansTitle}</h2>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong"
        >
          <Plus className="h-3.5 w-3.5" />
          {t.overview.addPlan}
        </button>
      </div>

      {/* No trailing "add" ghost tile: the header button is the single add entry */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) =>
          card.windows.length === 0 && card.balance ? (
            <BalanceCard key={card.key} card={card} />
          ) : (
            <PlanCard key={card.key} card={card} now={now} />
          ),
        )}
      </div>
    </section>
  )
}
