/**
 * Registry of the official subscription cards shown on the plans page.
 *
 * The page used to render every card unconditionally. Most people only have a
 * few of them, so the rest sat there reporting "not installed" or "not
 * connected" and the page looked broken. A card now appears only when it has
 * been enabled, and `experimental` cards are off by default: they depend on a
 * console session we cannot read reliably yet.
 *
 * Order here is the natural order for the management list; the user's own drag
 * order still comes from `settings.subscriptionOrder`.
 */

import { ANTIGRAVITY_FLAVOURS } from './antigravity-quota'

/** How a card gets its data — drives the manage-drawer grouping. */
export type SubscriptionCardGroup = 'plan' | 'console' | 'local'

export interface SubscriptionCardDef {
  /** Stable key used by settings, drag order and the page's card list */
  key: string
  /** Brand name, not translated */
  name: string
  /** Which drawer section the card lists under */
  group: SubscriptionCardGroup
  /**
   * Not enabled by default. These need a manual sign-in or are still being
   * validated, so presenting them first would look like a defect.
   */
  experimental?: boolean
}

export const SUBSCRIPTION_CARDS: SubscriptionCardDef[] = [
  { key: 'codex', name: 'Codex', group: 'plan' },
  { key: 'claude', name: 'Claude Code', group: 'plan' },
  { key: 'gemini', name: 'Gemini CLI', group: 'plan' },
  { key: 'grok', name: 'Grok', group: 'plan' },
  { key: 'trae', name: 'Trae CN', group: 'plan' },
  { key: 'trae-intl', name: 'Trae Intl', group: 'plan' },
  { key: 'kimi', name: 'Kimi Code', group: 'plan' },
  // Three clients, one allowance: the keys and names come from the one table
  // the card and the main-process probe read, so they cannot drift apart.
  { key: ANTIGRAVITY_FLAVOURS.ide.key, name: ANTIGRAVITY_FLAVOURS.ide.name, group: 'plan' },
  { key: ANTIGRAVITY_FLAVOURS.app.key, name: ANTIGRAVITY_FLAVOURS.app.name, group: 'plan' },
  { key: ANTIGRAVITY_FLAVOURS.cli.key, name: ANTIGRAVITY_FLAVOURS.cli.name, group: 'plan' },
  { key: 'cursor', name: 'Cursor', group: 'plan' },
  { key: 'copilot', name: 'GitHub Copilot', group: 'plan' },
  { key: 'qoder', name: 'Qoder', group: 'plan' },
  { key: 'cline', name: 'Cline Pass', group: 'plan' },
  { key: 'jetbrains', name: 'JetBrains AI', group: 'local' },
  { key: 'windsurf', name: 'Windsurf', group: 'local' },
  { key: 'kiro', name: 'Kiro', group: 'plan' },
  { key: 'kilo', name: 'Kilo', group: 'plan' },
  { key: 'factory', name: 'Factory Droid', group: 'plan' },
  { key: 'devin', name: 'Devin', group: 'plan' },
  { key: 'amp', name: 'Amp', group: 'plan' },
  // The OpenDesign credential needs a manual device-code approval or a pasted
  // cookie, and the endpoint is undocumented — stay opt-in like the console
  // cards until it has been verified against a live account.
  { key: 'opendesign', name: 'OpenDesign', group: 'plan', experimental: true },
  { key: 'alibaba', name: 'Alibaba Cloud Coding Plan', group: 'console', experimental: true },
  { key: 'qwen', name: 'Qwen Cloud', group: 'console', experimental: true },
  { key: 'alitoken', name: 'Alibaba Token Plan', group: 'console', experimental: true },
]

/**
 * What an existing install gets when it upgrades into this feature: every card
 * that was already being shown, which is exactly the non-experimental set.
 * A fresh install starts with none, because "add a card" is the point.
 */
export const DEFAULT_ENABLED_SUBSCRIPTIONS: string[] = SUBSCRIPTION_CARDS.filter(
  (card) => !card.experimental,
).map((card) => card.key)

export function isKnownSubscriptionKey(key: string): boolean {
  return SUBSCRIPTION_CARDS.some((card) => card.key === key)
}
