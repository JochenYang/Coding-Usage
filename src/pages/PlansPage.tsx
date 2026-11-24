import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { CreditCard } from 'lucide-react'
import type { PlanCardVM, PlanWindowVM } from '@/lib/overview'
import { buildPlanCards } from '@/lib/overview'
import { PROVIDERS } from '@/providers/registry'
import { currencySymbol, formatAmount, formatCountdown, formatDaysFromNow } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useLocale } from '@/i18n/LocaleProvider'
import { useData } from '@/lib/data-context'
import { PageHeader } from '@/components/common/PageHeader'
import { SortableGrid } from '@/components/common/SortableGrid'
import { applyPlanOrder, mergeVisibleOrder } from '@/lib/plan-order'
import { EmptyState } from '@/components/common/EmptyState'
import { Badge } from '@/components/common/Badge'
import { ProgressBar } from '@/components/common/ProgressBar'
import { cn } from '@/lib/cn'
import { ProviderLogo, providerWatermarkIcon } from '@/components/ProviderLogo'
import { CardWatermark } from '@/components/common/CardWatermark'
import { AddAccountMenu } from '@/components/account/AddAccountMenu'
import { CodexQuotaCard } from '@/components/overview/CodexQuotaCard'
import { ClaudeQuotaCard } from '@/components/overview/ClaudeQuotaCard'
import { GeminiQuotaCard } from '@/components/overview/GeminiQuotaCard'
import { GrokQuotaCard } from '@/components/overview/GrokQuotaCard'
import { TraeQuotaCard } from '@/components/overview/TraeQuotaCard'
import { TraeIntlQuotaCard } from '@/components/overview/TraeIntlQuotaCard'
import { FactoryQuotaCard } from '@/components/overview/FactoryQuotaCard'
import { DevinQuotaCard } from '@/components/overview/DevinQuotaCard'
import { AmpQuotaCard } from '@/components/overview/AmpQuotaCard'
import { OpenDesignQuotaCard } from '@/components/overview/OpenDesignQuotaCard'
import { KimiQuotaCard } from '@/components/overview/KimiQuotaCard'
import { AntigravityQuotaCard } from '@/components/overview/AntigravityQuotaCard'
import { ANTIGRAVITY_FLAVOURS, antigravityCardSpan, type AntigravityFlavour } from '@/lib/antigravity-quota'
import { LocalQuotaCard } from '@/components/overview/LocalQuotaCard'
import { QoderQuotaCard } from '@/components/overview/QoderQuotaCard'
import { SUBSCRIPTION_CARDS, type SubscriptionCardGroup } from '@/lib/subscription-cards'
import { Drawer } from '@/components/beui/drawer'
import { Tooltip } from '@/components/beui/tooltip'
import { Switch } from '@/components/beui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/beui/select'
import { useT } from '@/i18n/useT'
import type { Dict } from '@/i18n/types'

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
 * Provider tagline, keyed the same way as `providerPlan`.
 *
 * Used as the filler in a balance-only card: a card with no usage windows is
 * two lines tall next to a four-window neighbour, and the tagline is the one
 * piece of real information it can still show in that space.
 */
function providerTagline(t: Dict, providerId: string): string {
  if (!(providerId in t.providers)) return '—'
  return t.providers[providerId as keyof Dict['providers']].tagline
}

/** Logo + account name column + status badge, mirroring the plan grid header */
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
function PlanBalanceBlock({ balance, className }: { balance: BalanceVM; className?: string }) {
  const t = useT()

  return (
    <div className={className}>
      <div className="text-xs text-muted-foreground">
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
    </div>
  )
}

/** Expiry line: absolute date plus the relative offset, toned by urgency */
function PlanExpiryRow({ expiresAt, now }: { expiresAt: number; now: number }) {
  const t = useT()
  const { locale } = useLocale()
  const { primary, tone } = formatDaysFromNow(expiresAt, now, t)

  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="min-w-0 truncate text-muted-foreground">{t.provider.planExpiry}</span>
      <span
        className={cn(
          'shrink-0 tabular-nums',
          tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-foreground',
        )}
      >
        {`${new Date(expiresAt).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })} · ${primary}`}
      </span>
    </div>
  )
}

/** Grid variant of the plan card (w-full instead of the row's fixed width) */
function PlanGridCard({ card, now }: { card: PlanCardVM; now: number }) {
  const t = useT()
  // A card with only a balance (DeepSeek, say) is a third the height of a card
  // with three usage windows. Left as-is it shrinks inside its grid cell while
  // its neighbours stretch, so the row reads as misaligned; filling the cell
  // keeps both edges on the row's lines, and the leftover height is filled with
  // the provider's tagline plus a centred balance block rather than one hole.
  const balanceOnly = card.windows.length === 0 && card.balance != null
  return (
    <article className="relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5">
      <CardWatermark icon={providerWatermarkIcon(card.logoDef)} />
      <PlanGridCardHead card={card} />
      {balanceOnly && (
        <p className="mt-3 text-[11px] leading-relaxed text-subtle">
          {providerTagline(t, card.providerId)}
        </p>
      )}
      {card.windows.length > 0 ? (
        <div className="mt-4 space-y-3">
          {card.windows.map((win) => (
            <PlanWindowRow key={win.id} win={win} now={now} />
          ))}
        </div>
      ) : null}
      {/* Expiry sits between the windows and the balance: it belongs to the
          subscription cycle, not to either usage figure */}
      {card.expiresAt != null && (
        <div className={card.windows.length > 0 ? 'mt-3' : 'mt-4'}>
          <PlanExpiryRow expiresAt={card.expiresAt} now={now} />
        </div>
      )}
      {/* Balance renders alongside windows when a plan reports both (e.g.
          Command Code's credit balance next to its quota windows); plans with
          only one of the two look exactly as before. */}
      {card.balance ? (
        balanceOnly ? (
          // Centred in the leftover height: the void is split above and below the
          // figures instead of sitting between the header and the label.
          <div className="flex flex-1 flex-col justify-center">
            <PlanBalanceBlock balance={card.balance} />
          </div>
        ) : (
          <PlanBalanceBlock balance={card.balance} className="mt-4 border-t border-border/60 pt-4" />
        )
      ) : card.windows.length === 0 ? (
        <p className="mt-auto text-xs text-subtle">{t.card.unconfigured}</p>
      ) : null}
    </article>
  )
}

/**
 * Plans page: all accounts' plan windows and balances in one grid. Filters and
 * the add action live in the page header; cards render here directly because
 * the cards render directly here, so this page owns the header row and the
 * filterable actions that sit in it.
 */
export function PlansPage({ onAddAccount }: PlansPageProps) {
  const t = useT()
  const { sections, results, settings, updateSettings } = useData()
  const [planFilter, setPlanFilter] = useState(ALL_PLANS)
  const [accountFilter, setAccountFilter] = useState(ALL_ACCOUNTS)
  const [manageOpen, setManageOpen] = useState(false)
  const [cardFilter, setCardFilter] = useState('')
  const now = useNowTick()

  const cards = useMemo(
    () => buildPlanCards(sections, results, settings.alertThresholds.highUsagePct),
    [sections, results, settings.alertThresholds],
  )

  // Saved drag order first; cards the order has never seen keep their natural
  // place at the end (accounts are added and removed all the time)
  const ordered = useMemo(() => applyPlanOrder(cards, settings.planOrder), [cards, settings.planOrder])

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
      ordered.filter((card) => {
        if (planFilter !== ALL_PLANS && providerPlan(t, card.providerId) !== planFilter) return false
        if (accountFilter !== ALL_ACCOUNTS && card.accountName !== accountFilter) return false
        return true
      }),
    [ordered, planFilter, accountFilter, t],
  )

  // A drop reorders only what the filters show; the hidden cards keep the slots
  // they already occupied, so clearing a filter does not reshuffle the grid.
  const onOrderChange = useCallback(
    (visibleKeys: string[]) => {
      const full = ordered.map((card) => card.key)
      updateSettings({ ...settings, planOrder: mergeVisibleOrder(full, visibleKeys) })
    },
    [ordered, settings, updateSettings],
  )

  // Which subscription cards need two grid tracks right now. Each Antigravity
  // card reports its own need once its quota data arrives, keyed by card, so
  // the three of them never share one flag.
  const [wideCards, setWideCards] = useState<Record<string, boolean>>({})
  const setCardWide = useCallback((key: string, wide: boolean) => {
    setWideCards((current) => (current[key] === wide ? current : { ...current, [key]: wide }))
  }, [])

  // The official subscription cards have no accounts, so their order is simply
  // the saved key list with unknown keys appended.
  const subscriptionCards = useMemo(() => {
    // Only the cards the user added. An experimental card starts out absent,
    // so the page is not a wall of "not connected".
    const enabled = new Set(settings.enabledSubscriptions)
    // How wide an Antigravity card is allowed to be is decided by
    // antigravityCardSpan; the card itself reports whether it has two model
    // groups to lay out side by side.
    const antigravityShown = Object.values(ANTIGRAVITY_FLAVOURS).filter((flavour) =>
      enabled.has(flavour.key),
    ).length
    const span = (key: string): 1 | 2 => antigravityCardSpan(antigravityShown, wideCards[key] === true)
    const antigravityCard = (flavour: AntigravityFlavour) => {
      const key = ANTIGRAVITY_FLAVOURS[flavour].key
      return {
        key,
        node: (
          <AntigravityQuotaCard
            flavour={flavour}
            expanded={span(key) === 2}
            onWideChange={(wide) => setCardWide(key, wide)}
          />
        ),
        span: span(key),
      }
    }
    const all: Array<{ key: string; node: ReactNode; span?: 1 | 2 }> = [
      { key: 'codex', node: <CodexQuotaCard /> },
      { key: 'claude', node: <ClaudeQuotaCard /> },
      { key: 'gemini', node: <GeminiQuotaCard /> },
      { key: 'grok', node: <GrokQuotaCard /> },
      { key: 'trae', node: <TraeQuotaCard /> },
      { key: 'trae-intl', node: <TraeIntlQuotaCard /> },
      { key: 'kimi', node: <KimiQuotaCard /> },
      antigravityCard('ide'),
      antigravityCard('app'),
      antigravityCard('cli'),
      { key: 'cursor', node: <LocalQuotaCard kind="cursor" /> },
      { key: 'copilot', node: <LocalQuotaCard kind="copilot" /> },
      { key: 'cline', node: <LocalQuotaCard kind="cline" /> },
      { key: 'jetbrains', node: <LocalQuotaCard kind="jetbrains" /> },
      { key: 'windsurf', node: <LocalQuotaCard kind="windsurf" /> },
      { key: 'kiro', node: <LocalQuotaCard kind="kiro" /> },
      { key: 'kilo', node: <LocalQuotaCard kind="kilo" /> },
      { key: 'factory', node: <FactoryQuotaCard /> },
      { key: 'devin', node: <DevinQuotaCard /> },
      { key: 'amp', node: <AmpQuotaCard /> },
      { key: 'opendesign', node: <OpenDesignQuotaCard /> },
      { key: 'alibaba', node: <LocalQuotaCard kind="alibaba" /> },
      { key: 'qwen', node: <LocalQuotaCard kind="qwen" /> },
      { key: 'alitoken', node: <LocalQuotaCard kind="alitoken" /> },
      { key: 'qoder', node: <QoderQuotaCard /> },
    ]
    return applyPlanOrder(
      all.filter((card) => enabled.has(card.key)),
      settings.subscriptionOrder,
    )
  }, [settings.subscriptionOrder, settings.enabledSubscriptions, wideCards, setCardWide])

  // Manage-drawer state: enabled counter, name/key filter (dims non-matching
  // rows instead of unmounting them — see the drawer note) and the fixed group
  // order the drawer lists the cards under.
  const enabledCardCount = SUBSCRIPTION_CARDS.filter((card) =>
    settings.enabledSubscriptions.includes(card.key),
  ).length
  const filterQuery = cardFilter.trim().toLowerCase()
  const matchesCardFilter = (card: { name: string; key: string }): boolean =>
    filterQuery === '' || card.name.toLowerCase().includes(filterQuery) || card.key.toLowerCase().includes(filterQuery)
  const matchCount = SUBSCRIPTION_CARDS.filter((card) => matchesCardFilter(card)).length
  const groupTitles: Record<SubscriptionCardGroup, string> = {
    plan: t.manage.groupPlan,
    console: t.manage.groupConsole,
    local: t.manage.groupLocal,
  }
  const manageGroups: SubscriptionCardGroup[] = ['plan', 'console', 'local']

  const onSubscriptionOrderChange = useCallback(
    (keys: string[]) => updateSettings({ ...settings, subscriptionOrder: keys }),
    [settings, updateSettings],
  )

  // No early return: a fresh install has no plan cards yet still needs the
  // subscription section, otherwise there is no way to add a quota card.
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

      {cards.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="h-6 w-6" />}
          title={t.overview.emptyTitle}
          description={t.overview.emptyDesc}
          action={<AddAccountMenu onAdd={onAddAccount} label={t.overview.addPlan} />}
        />
      ) : filtered.length === 0 ? (
        // The selected account was deleted (or the two filters combined to
        // nothing): offer a one-click reset instead of a silent empty grid
        <EmptyState
          title={t.manage.planFilterEmpty}
          action={
            <button
              type="button"
              onClick={() => {
                setPlanFilter(ALL_PLANS)
                setAccountFilter(ALL_ACCOUNTS)
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              {t.manage.planFilterReset}
            </button>
          }
        />
      ) : (
        <>
          {filtered.length > 1 && (
            <p className="mb-2 text-[11px] text-subtle">{t.manage.reorderHint}</p>
          )}
          <SortableGrid
            items={filtered}
            ariaLabel={t.manage.reorderHint}
            announce={(position, total) => t.manage.reorderPosition(position, total)}
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
            renderItem={(card) => <PlanGridCard card={card} now={now} />}
            onOrderChange={onOrderChange}
          />
        </>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">{t.manage.subscriptionTitle}</h2>
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted"
          >
            {t.manage.subscriptionsManage}
          </button>
        </div>
        {subscriptionCards.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-subtle">
            {t.manage.subscriptionsEmpty}
          </p>
        ) : (
          <>
            <p className="text-[11px] text-subtle">{t.manage.reorderHint}</p>
            <SortableGrid
              items={subscriptionCards}
              ariaLabel={t.manage.reorderHint}
              announce={(position, total) => t.manage.reorderPosition(position, total)}
              className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
              renderItem={(item) => item.node}
              onOrderChange={onSubscriptionOrderChange}
            />
          </>
        )}
      </section>

      {/* A drawer, not a popover: the list is longer than a viewport-safe
          panel, and this one scrolls on its own instead of running off screen. */}
      <Drawer
        open={manageOpen}
        onOpenChange={setManageOpen}
        ariaLabel={t.manage.subscriptionsManage}
        className="max-w-[min(340px,92vw)] sm:min-w-[300px]"
      >
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 pb-2.5 pt-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">{t.manage.subscriptionsManage}</h2>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-subtle">
                {t.manage.enabledCount(enabledCardCount, SUBSCRIPTION_CARDS.length)}
              </span>
              <button
                type="button"
                onClick={() => setManageOpen(false)}
                className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted"
              >
                {t.manage.closeDrawer}
              </button>
            </div>
          </div>
          <input
            type="text"
            value={cardFilter}
            onChange={(event) => setCardFilter(event.target.value)}
            placeholder={t.manage.filterPlaceholder}
            className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-subtle focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          {manageGroups.map((group) => {
            const cards = SUBSCRIPTION_CARDS.filter((card) => card.group === group && matchesCardFilter(card))
            if (cards.length === 0) return null
            return (
              <div key={group} className="pb-2">
                <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide text-subtle">
                  {groupTitles[group]}
                </p>
                {cards.map((card) => {
                  const checked = settings.enabledSubscriptions.includes(card.key)
                  return (
                    <div
                      key={card.key}
                      className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-foreground">
                        <Tooltip content={card.name} side="left" wrapperClassName="min-w-0 flex-1">
                          <span className="block truncate">{card.name}</span>
                        </Tooltip>
                        {card.experimental && (
                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-subtle">
                            {t.manage.experimental}
                          </span>
                        )}
                      </span>
                      <Switch
                        checked={checked}
                        ariaLabel={card.name}
                        onCheckedChange={(on) => {
                          const next = new Set(settings.enabledSubscriptions)
                          if (on) next.add(card.key)
                          else next.delete(card.key)
                          updateSettings({ ...settings, enabledSubscriptions: [...next] })
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            )
          })}
          {matchCount === 0 && (
            <p className="px-2 py-6 text-center text-xs text-subtle">{t.manage.filterEmpty}</p>
          )}
        </div>
      </Drawer>
    </div>
  )
}
