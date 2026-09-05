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
    windowMinimize: string
    windowMaximize: string
    windowClose: string
    closeDialog: {
      title: string
      detail: string
      toTray: string
      quit: string
      dontAsk: string
    }
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
    save: string
    saveContinue: string
    unsavedChanges: string
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
    opencode: { name: string; tagline: string; plan: string }
    zhipu: { name: string; tagline: string; plan: string }
    kimi: { name: string; tagline: string; plan: string }
    deepseek: { name: string; tagline: string; plan: string }
    siliconflow: { name: string; tagline: string; plan: string }
    openrouter: { name: string; tagline: string; plan: string }
    minimax: { name: string; tagline: string; plan: string }
    volcengine: { name: string; tagline: string; plan: string }
    stepfun: { name: string; tagline: string; plan: string }
    novita: { name: string; tagline: string; plan: string }
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
  nav: {
    overview: string
    agents: string
    providers: string
    accounts: string
    plans: string
    usageStats: string
    costAnalysis: string
    trends: string
    alerts: string
    integrations: string
    settings: string
    groupManage: string
    groupAnalytics: string
    groupSettings: string
  }
  topbar: {
    notifications: string
  }
  status: {
    allNormal: string
    updatedJustNow: string
    updatedAgo: (m: number) => string
    never: string
  }
  pages: {
    settingsTitle: string
    settingsHint: string
    quickPrefs: string
  }
  island: {
    dismiss: string
    more: (n: number) => string
    desktopToggle: string
    desktopHint: string
  }
  integrations: {
    pageDesc: string
    pushCardTitle: string
    pushCardDesc: string
    enablePush: string
    save: string
    testPush: string
    testing: string
    testOk: string
    testFailed: (detail: string) => string
    needCredential: string
    pushTitle: string
    testMessage: string
    desktopOnlyTitle: string
    desktopOnlyDesc: string
    chanWecom: string
    chanWecomHint: string
    chanFeishu: string
    chanFeishuHint: string
    chanTelegram: string
    chanTelegramHint: string
    chanWeixin: string
    chanWeixinHint: string
    wxLoginBtn: string
    wxLoginAgain: string
    wxLoginTitle: string
    wxLoginScan: string
    wxLoginScanned: string
    wxLoginExpired: string
    wxLoginFailed: (d: string) => string
    wxActivateTitle: string
    wxActivateWait: string
    wxActivateDone: string
    wxActivateError: string
    wxConnected: (t: string) => string
    wxDisconnect: string
    wxDisconnectConfirm: string
    fWebhookUrl: string
    fBotToken: string
    fChatId: string
    fSendKey: string
    phWecom: string
    phFeishu: string
    phBotToken: string
    phChatId: string
    phSendKey: string
  }
  overview: {
    kpiTotalQuota: string
    kpiBalance: string
    kpiOnline: string
    kpiToday: string
    vsYesterday: string
    onlineRate: string
    trendTitle: string
    trendRange: (n: number) => string
    trendGathering: string
    agentsTitle: string
    searchAgent: string
    allProviders: string
    allStatus: string
    colAgent: string
    colProvider: string
    colPlan: string
    colUsage: string
    colQuota: string
    colBalance: string
    colStatus: string
    colActions: string
    colModel: string
    colInput: string
    colOutput: string
    colCache: string
    statusOnline: string
    statusOffline: string
    shownAgents: (n: number) => string
    distTitle: string
    distTotal: string
    distMonthUsage: string
    distOther: string
    distUnavailable: string
    alertsTitle: string
    viewAll: string
    alertWindowReset: (name: string) => string
    alertHighUsage: (name: string, pct: number) => string
    alertLowBalance: (name: string) => string
    alertResetSoon: (m: number) => string
    alertUsedDetail: (used: string, total: string) => string
    alertBalanceDetail: (s: string) => string
    agoJust: string
    agoShort: (m: number) => string
    plansTitle: string
    searchPlan: string
    allPlans: string
    allAccounts: string
    addPlan: string
    planNormal: string
    weeklyUnlimited: string
    emptyTitle: string
    emptyDesc: string
    localUsageTitle: string
    localUsageEmpty: string
    localUsagePartial: (names: string) => string
    asOfPrefix: string
    todayCol: string
    monthCol: string
    allTimeCol: string
  }
  manage: {
    agentsTitle: string
    agentsDesc: string
    localAgents: string
    apiAccounts: string
    subscriptionTitle: string
    codexNoAuth: string
    claudeNoAuth: string
    claudeReauth: string
    claudeWindows: {
      fiveHour: string
      sevenDay: string
      sevenDayOpus: string
      sevenDaySonnet: string
    }
    geminiNoAuth: string
    geminiReauth: string
    geminiGroups: {
      pro: string
      flash: string
      flashLite: string
    }
    grokNoAuth: string
    grokReauth: string
    grokBilling: string
    addAgent: string
    showAll: string
    enabled: string
    disabled: string
    noAccounts: string
    deleteConfirm: string
    accountsTitle: string
    accountsDesc: string
    keySaved: string
    lastOk: string
    never: string
    providersTitle: string
    providersDesc: string
    accountsCount: (n: number) => string
    direct: string
    needsProxy: string
    openDocs: string
    openKey: string
    plansTitle: string
    plansDesc: string
    alertsCenterTitle: string
    alertsDesc: string
    markAllRead: string
    filterUnread: string
    filterAll: string
    noAlerts: string
    rulesTitle: string
    ruleReset: string
    ruleHigh: string
    ruleLow: string
    planFilterEmpty: string
    planFilterReset: string
  }
  common: {
    clearSearch: string
    cancel: string
  }
  prefs: {
    appearance: string
    theme: string
    language: string
    refresh: string
    refreshInterval: string
    data: string
    displayCurrency: string
    usageMode: string
    usageAll: string
    usageNoCache: string
    exportData: string
    importData: string
    clearSnapshots: string
    clearConfirm: string
    exportHint: string
    importHint: string
    importBad: string
    about: string
    version: string
    updates: {
      title: string
      hint: string
      check: string
      checking: string
      upToDate: string
      available: (version: string) => string
      downloading: (percent: number) => string
      downloaded: (version: string) => string
      installNow: string
      error: string
      devMode: string
      via: (mirror: string) => string
    }
  }
  providerErrors: {
    keyInvalid: string
    badResponse: string
    volcSignature: string
    volcCredFormat: string
    volcNoWindows: string
  }
  updater: {
    readyTitle: string
    readyBody: (version: string) => string
    installNow: string
    later: string
  }
}