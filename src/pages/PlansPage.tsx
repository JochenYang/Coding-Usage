import { useEffect, useMemo, useState } from 'react'
import { CreditCard } from 'lucide-react'
import type { PlanCardVM, PlanWindowVM } from '@/lib/overview'
import { buildPlanCards } from '@/lib/overview'
import { PROVIDERS } from '@/providers/registry'
import { currencySymbol, formatAmount, formatCountdown } from '@/lib/format'
import { useData } from '@/lib/data-context'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { Badge } from '@/components/common/Badge'
import { ProgressBar } from '@/components/common/ProgressBar'
import { ProviderLogo } from '@/components/ProviderLogo'
import { AddAccountMenu } from '@/components/account/AddAccountMenu'
import { CodexQuotaCard } from '@/components/overview/CodexQuotaCard'
import { ClaudeQuotaCard } from '@/components/overview/ClaudeQuotaCard'
import { GeminiQuotaCard } from '@/components/overview/GeminiQuotaCard'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/beui/select'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'
import { cn } from '@/lib/cn'

export interface PlansPageProps {
  /** Adds a new (disabled) entry under the picked provider at the given index */
  onAddAccount: (providerId: string, newIndex: number) => void
}

/** Sentinel select values meaning "no filter" (locale-independent) */
const ALL_PLANS = 'all'
const ALL_ACCOUNTS = 'all'

/** Balance payload of a plan card (NonNullable keeps it in sync with the VM) */
type BalanceVM = NonNullable<PlanCardVM['balance']>

/**
 * Plan label keyed by provider id — Dict.providers keys mirror the registry
 * ids one-to-one; an unknown id degrades to an em dash instead of throwing.
 * Same tolerant lookup as AgentsTable.
 */
function providerPlan(t: Dict, providerId: string): string {
  if (!(providerId in t.providers)) return '—'
  return t.providers[providerId as keyof Dict['providers']].plan
}

/**
 * Minute-resolution clock so window countdowns stay live without any external
 * timer wiring. Local copy of PlanCardsRow's hook (not exported there).
 */
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Logo + account name column + status badge, mirroring PlanCardsRow's header */
function PlanGridCardHead({ card }: { card: PlanCardVM }) {
  const t = useT()

  return (
    <div className="flex items-center gap-3">
      <ProviderLogo def={card.logoDef} className="h-8 w-8" imgClassName="h-4.5 w-4.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-foreground">{card.accountName}</div>
        <div className="truncate text-[11px] text-muted-foreground">{card.providerName}</div>
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

/** One usage window: label/pct line, fill bar (flat green when unlimited), countdown */
function PlanWindowRow({ win, now }: { win: PlanWindowVM; now: number }) {
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
function PlanBalanceBlock({ balance }: { balance: BalanceVM }) {
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
            <div key={`${d.label}-${i}`} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">{d.label}</span>
              <span className="shrink-0 tabular-nums text-foreground">{formatAmount(d.value)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** Grid variant of the plan card (w-full instead of the row's fixed width) */
function PlanGridCard({ card, now }: { card: PlanCardVM; now: number }) {
  const t = useT()
  return (
    <article className="rounded-2xl border border-border bg-card p-5">
      <PlanGridCardHead card={card} />
      {card.windows.length > 0 ? (
        <div className="mt-4 space-y-3">
          {card.windows.map((win) => (
            <PlanWindowRow key={win.id} win={win} now={now} />
          ))}
        </div>
      ) : card.balance ? (
        <PlanBalanceBlock balance={card.balance} />
      ) : (
        <p className="mt-4 text-xs text-subtle">{t.card.unconfigured}</p>
      )}
    </article>
  )
}

/**
 * Plans page: all accounts' plan windows and balances in one grid. Filters and
 * the add action live in the page header; cards render here directly because
 * PlanCardsRow owns its own header row (fixed title + add button), which this
 * page replaces with filterable actions.
 */
export function PlansPage({ onAddAccount }: PlansPageProps) {
  const t = useT()
  const { sections, results } = useData()
  const [planFilter, setPlanFilter] = useState(ALL_PLANS)
  const [accountFilter, setAccountFilter] = useState(ALL_ACCOUNTS)
  const now = useNowTick()

  const cards = useMemo(() => buildPlanCards(sections, results), [sections, results])

  // Distinct plan labels across the whole registry (not only fetched accounts),
  // so the plan select lists everything a user could add, first-seen order.
  const planOptions = useMemo(
    () => [...new Set(PROVIDERS.map((def) => providerPlan(t, def.id)))],
    [t],
  )

  // Distinct account names among existing cards, first-seen order
  const accountOptions = useMemo(() => [...new Set(cards.map((c) => c.accountName))], [cards])

  const filtered = useMemo(
    () =>
      cards.filter((card) => {
        if (planFilter !== ALL_PLANS && providerPlan(t, card.providerId) !== planFilter) return false
        if (accountFilter !== ALL_ACCOUNTS && card.accountName !== accountFilter) return false
        return true
      }),
    [cards, planFilter, accountFilter, t],
  )

  // No fetched cards at all: plain empty state with the same picker in the slot
  if (cards.length === 0) {
    return (
      <EmptyState
        icon={<CreditCard className="h-6 w-6" />}
        title={t.overview.emptyTitle}
        description={t.overview.emptyDesc}
        action={<AddAccountMenu onAdd={onAddAccount} label={t.overview.addPlan} />}
      />
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t.manage.plansTitle}
        description={t.manage.plansDesc}
        actions={
          <>
            <Select value={planFilter} onValueChange={setPlanFilter}>
              <SelectTrigger className="w-32 rounded-lg border-border bg-card px-3 py-1.5 text-xs">
                <SelectValue placeholder={t.overview.allPlans} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PLANS}>{t.overview.allPlans}</SelectItem>
                {planOptions.map((plan) => (
                  <SelectItem key={plan} value={plan}>
                    {plan}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={accountFilter} onValueChange={setAccountFilter}>
              <SelectTrigger className="w-36 rounded-lg border-border bg-card px-3 py-1.5 text-xs">
                <SelectValue placeholder={t.overview.allAccounts} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ACCOUNTS}>{t.overview.allAccounts}</SelectItem>
                {accountOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <AddAccountMenu onAdd={onAddAccount} label={t.overview.addPlan} />
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((card) => (
          <PlanGridCard key={card.key} card={card} now={now} />
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">{t.manage.subscriptionTitle}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <CodexQuotaCard />
          <ClaudeQuotaCard />
          <GeminiQuotaCard />
        </div>
      </section>
    </div>
  )
}
