export type Locale = 'zh-CN' | 'en-US'
export const LOCALES: Locale[] = ['zh-CN', 'en-US']
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/**
 * Dictionary contract — handwritten so both locales must satisfy the same shape.
 * zh-CN and en-US are typed as Dict, so missing/extra keys are caught at compile time.
 * String fields are `string` (not literal) so each locale's wording is assignable;
 * function fields keep their signatures so call sites are type-checked.
 */
export interface Dict {
  app: {
    title: string
    tagline: string
  }
  header: {
    autoRefresh: string
    refreshAll: string
    settings: string
    theme: {
      system: string
      light: string
      dark: string
    }
  }
  empty: {
    title: string
    description: string
    openSettings: string
  }
  card: {
    refresh: string
    delete: string
    accountsCount: (n: number) => string
    accountIndex: (n: number) => string
    okRatio: (ok: number, total: number) => string
    normal: string
    error: string
    needsProxy: string
    unconfigured: string
    loading: string
    refreshing: string
    deleteHint: string
    needsProxyDetail: string
    needsProxyAfter: string
    goSettings: string
    displayCurrencies: string
    displayCurrenciesHint: string
  }
  settings: {
    title: string
    close: string
    getKey: string
    addAccount: string
    noAccount: string
    aliasLabel: string
    aliasPlaceholder: (n: number) => string
    apiKeyLabel: string
    apiKeyPlaceholder: string
    enabled: string
    test: string
    testing: string
    show: string
    hide: string
    deleteTooltip: string
    footer: string
    needsProxyError: string
  }
  providers: {
    opencode: { name: string; tagline: string }
    zhipu: { name: string; tagline: string }
    kimi: { name: string; tagline: string }
    deepseek: { name: string; tagline: string }
    siliconflow: { name: string; tagline: string }
    openrouter: { name: string; tagline: string }
    minimax: { name: string; tagline: string }
  }
  provider: {
    balanceLabel: (currency: string) => string
    balanceLabelFallback: string
    totalBalanceLabel: (currency: string) => string
    topUpBalance: string
    grantBalance: string
  }
  metric: {
    unlimited: string
    remaining: (cur: number, total: number) => string
  }
  time: {
    countdownResetting: string
    countdownWithin1Min: string
    countdownMinutes: (n: number) => string
    countdownHoursMinutes: (h: number, m: number) => string
    countdownDaysHours: (d: number, h: number) => string
    agoSeconds: (s: number) => string
    agoMinutes: (m: number) => string
    expiresToday: string
    expiresInDays: (n: number) => string
    expiresOverdueDays: (n: number) => string
  }
  windows: {
    rolling: string
    weekly: string
    monthly: string
    rateLimited: string
    fiveHour: string
    weeklyPlan: string
    videoWeekly: string
    planQuota: string
    mcpMonthly: string
  }
  regions: {
    zhipuCN: string
    zhipuIntl: string
    kimiCN: string
    kimiIntl: string
    minimaxCN: string
    minimaxIntl: string
    siliconflowCN: string
    siliconflowIntl: string
  }
  autoRefresh: {
    manual: string
    sec15: string
    sec30: string
    min1: string
    min3: string
    min5: string
    min15: string
    min30: string
  }
}