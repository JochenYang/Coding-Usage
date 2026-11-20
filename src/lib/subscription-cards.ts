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

export interface SubscriptionCardDef {
  /** Stable key used by settings, drag order and the page's card list */
  key: string
  /** Brand name, not translated */
  name: string
  /**
   * Not enabled by default. These need a manual sign-in or are still being
   * validated, so presenting them first would look like a defect.
   */
  experimental?: boolean
}

export const SUBSCRIPTION_CARDS: SubscriptionCardDef[] = [
  { key: 'codex', name: 'Codex' },
  { key: 'claude', name: 'Claude Code' },
  { key: 'gemini', name: 'Gemini CLI' },
  { key: 'grok', name: 'Grok' },
  { key: 'trae', name: 'Trae CN' },
  { key: 'kimi', name: 'Kimi Code' },
  { key: 'antigravity', name: 'Antigravity' },
  { key: 'cursor', name: 'Cursor' },
  { key: 'copilot', name: 'GitHub Copilot' },
  { key: 'qoder', name: 'Qoder' },
  { key: 'cline', name: 'Cline Pass' },
  { key: 'jetbrains', name: 'JetBrains AI' },
  { key: 'windsurf', name: 'Windsurf' },
  { key: 'kiro', name: 'Kiro' },
  { key: 'kilo', name: 'Kilo' },
  { key: 'alibaba', name: 'Alibaba Cloud Coding Plan', experimental: true },
  { key: 'qwen', name: 'Qwen Cloud', experimental: true },
  { key: 'alitoken', name: 'Alibaba Token Plan', experimental: true },
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
