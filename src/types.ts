import type { ReactNode } from 'react'
import type { Dict } from './i18n/types'

/** Unified usage metric: `percent` type (plan windows) or `balance` type (account balance) */
export interface UsageMetric {
  id: string
  label: string
  kind: 'percent' | 'balance' | 'expiry'
  /** kind=percent: used percentage, 0-100 */
  percent?: number
  /** kind=balance: remaining quota */
  remaining?: number
  used?: number
  total?: number
  /** Secondary detail rows, e.g. voucher/cash, grant/top-up */
  detail?: { label: string; value: number }[]
  unit?: string
  /** epoch ms */
  resetsAt?: number
  /** kind=expiry: expiration time (epoch ms) */
  expiresAt?: number
}

/** Either a static region (label baked in) or a locale-driven factory so region labels can be translated. */
export interface ProviderRegion {
  id: string
  label: string
  baseUrl: string
}

/** Region descriptor as a function of the active locale dict — lets `regions.label` be translated. */
export type ProviderRegionFactory = (t: Dict) => ProviderRegion[]

export type ProviderStatus =
  | 'idle'
  | 'loading'
  | 'ok'
  | 'error'
  | 'unconfigured'

/** Fetch helper injected by the dispatcher when a provider adapter issues extra requests (CORS/proxy already handled) */
export interface ParseContext {
  regionId?: string
  /** Current entry's API key, reused for Authorization on adapter-issued requests */
  key?: string
  fetch?: (url: string, headers: Record<string, string>) => Promise<Response>
  /** Active UI locale; adapters use it to pick the right dict when rendering metric labels. */
  locale?: string
}

/** Capability descriptor for each provider, consumed by both UI and dispatcher */
export interface ProviderDef {
  id: string
  name: string
  /** Provider brand mark: lobehub CDN SVG slug (e.g. 'deepseek-color'), or an inline ReactNode */
  logo?: string | ReactNode
  /** When `logo` is a lobehub CDN slug and renders white-on-white, set to true: in light mode the CSS `filter:invert(1)` flips it to black; in dark mode it stays as is */
  logoDarkInvert?: boolean
  /** Fallback letter when the logo fails to load; defaults to name[0] */
  logoLetter?: string
  /** Card brand-color gradient (Tailwind class fragment; kept for accent residue) */
  accent: string
  /**
   * Short subtitle shown under the card title. Receives the locale dictionary so
   * the tagline can be translated per-locale without coupling adapters to React.
   */
  tagline: (t: Dict) => string
  /** Region options (label translated per locale). */
  regions?: ProviderRegion[] | ProviderRegionFactory
  docsUrl: string
  keyUrl: string
  /** True when buildRequest's fetch is only a placeholder and the real
   *  (signed) request is issued inside parseResponse — skip the transport
   *  preflight so the adapter's own request can run. */
  skipPreflight?: boolean
  buildRequest(key: string, regionId?: string): { url: string; headers: Record<string, string> }
  /** Parse response into a metric list. Async signature lets adapters issue extra API calls (e.g. subscription details). */
  parseResponse(json: unknown, ctx?: ParseContext): Promise<UsageMetric[]>
}

/** Per-account configuration under a single provider */
export interface ProviderConfig {
  enabled: boolean
  apiKey: string
  regionId?: string
  /** Optional alias (e.g. "primary", "work"); falls back to "Account N" when empty */
  label?: string
  /** Multi-currency providers (DeepSeek): restrict which currencies to display.
   *  Undefined or empty array means "show every currency the adapter returns". */
  displayCurrencies?: string[]
}

/** Outbound alert-push channels. Every channel's credential (URL / token /
 *  key) is safeStorage-encrypted into v3 exactly like provider API keys. */
export type PushChannelId = 'wecom' | 'feishu' | 'telegram' | 'weixin'

export interface IntegrationsSettings {
  /** Master switch for pushing newly-raised alerts to every configured channel */
  alertPush: boolean
  /** WeCom group-robot webhook URL; empty = not configured */
  wecomWebhook: string
  /** Feishu / Lark group-robot webhook URL (open.feishu.cn or open.larksuite.com) */
  feishuWebhook: string
  /** Telegram bot token from @BotFather */
  telegramBotToken: string
  /** Telegram chat id the bot is allowed to post to (not a secret — no encryption) */
  telegramChatId: string
  /** WeChat iLink bot token (from the in-app QR login flow) */
  weixinBotToken: string
  /** WeChat iLink user id to push to (not a secret — no encryption) */
  weixinBotUserId: string
}

/** Settings: each provider supports multiple accounts (array) */
export interface Settings {
  providers: Record<string, ProviderConfig[]>
  autoRefreshMin: number
  /** Currency used for cross-account balance totals (uppercase code) */
  displayCurrency: string
  /** Token accounting口径: 'all' counts cache reads, 'no-cache' only input+output */
  usageDisplayMode: 'all' | 'no-cache'
  /** Pop alert islands as a system-level overlay above every app (desktop only) */
  desktopIsland: boolean
  integrations: IntegrationsSettings
}

export interface ProviderResult {
  status: ProviderStatus
  metrics?: UsageMetric[]
  error?: string
  fetchedAt?: number
}

// ===== i18n re-exports (Wave 1) =====
import type { Locale } from './i18n/types'
export type { Locale }
