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
    zai: { name: string; tagline: string; plan: string }
    kimi: { name: string; tagline: string; plan: string }
    'kimi-intl': { name: string; tagline: string; plan: string }
    deepseek: { name: string; tagline: string; plan: string }
    siliconflow: { name: string; tagline: string; plan: string }
    'siliconflow-intl': { name: string; tagline: string; plan: string }
    openrouter: { name: string; tagline: string; plan: string }
    minimax: { name: string; tagline: string; plan: string }
    'minimax-intl': { name: string; tagline: string; plan: string }
    volcengine: { name: string; tagline: string; plan: string }
    stepfun: { name: string; tagline: string; plan: string }
    novita: { name: string; tagline: string; plan: string }
    commandcode: { name: string; tagline: string; plan: string }
    ollamaCloud: { name: string; tagline: string; plan: string }
    cursor: { name: string; tagline: string; plan: string }
    copilot: { name: string; tagline: string; plan: string }
    /** Tagline doubles as the dedicated-short-lived-key warning (key can bill) */
    warp: { name: string; tagline: string; plan: string }
  }
  provider: {
    balanceLabel: (currency: string) => string
    balanceLabelFallback: string
    availableBalance: string
    cashBalance: string
    voucherBalance: string
    totalBalanceLabel: (currency: string) => string
    topUpBalance: string
    grantBalance: string
    recentSpend: string
    lifetimeCost: string
    lifetimeCalls: string
    planExpiry: string
    usageSpent: string
    totalToppedUp: string
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
    agoHoursMinutes: (h: number, m: number) => string
    agoDaysHours: (d: number, h: number) => string
    expiresToday: string
    expiresInDays: (n: number) => string
    expiresOverdueDays: (n: number) => string
  }
  windows: {
    rolling: string
    weekly: string
    monthly: string
    /** Codex fallback: a window the endpoint did not give a length for */
    generic: string
    /** Codex fallback for an unusual window length: hours / days */
    hoursLabel: (n: number) => string
    daysLabel: (n: number) => string
    rateLimited: string
    fiveHour: string
    weeklyPlan: string
    videoWeekly: string
    planQuota: string
    mcpMonthly: string
    cursorTotal: string
    cursorAuto: string
    cursorApi: string
    copilotPremium: string
    copilotChat: string
    clineFiveHour: string
    clineWeekly: string
    clineMonthly: string
    jetbrainsMonthly: string
    windsurfDaily: string
    windsurfWeekly: string
    windsurfMessages: string
    windsurfFlow: string
    kiroMonthly: string
    kiloCredits: string
    kiloPass: string
    ali5h: string
    aliWeekly: string
    aliMonthly: string
    /** Warp: the monthly request allowance (request-named fields for credits) */
    warpMonthlyRequests: string
    /** Warp: the combined user+workspace add-on credit pool */
    warpBonusCredits: string
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
    collapseSidebar: string
    expandSidebar: string
  }
  topbar: {
    notifications: string
  }
  status: {
    allNormal: string
    updatedJustNow: string
    updatedAgo: (m: number) => string
    updatedHoursMinutes: (h: number, m: number) => string
    updatedDaysHours: (d: number, h: number) => string
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
    chanDingtalk: string
    chanDingtalkHint: string
    chanDiscord: string
    chanDiscordHint: string
    chanSlack: string
    chanSlackHint: string
    chanBark: string
    chanBarkHint: string
    chanNtfy: string
    chanNtfyHint: string
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
    wxReloginHint: string
    wxStaleHint: string
    copyError: string
    copied: string
    pushHistoryTitle: string
    pushHistoryOk: string
    pushHistoryFail: string
    pushHistoryClear: string
    pushStatusDirty: string
    pushStatusOff: string
    pushStatusNoChannel: string
    pushStatusReady: (n: number) => string
    pushStatusUnread: (n: number) => string
    pushStatusLastOk: (t: string) => string
    pushStatusLastFail: (detail: string) => string
    pushStatusNever: string
    fWebhookUrl: string
    fBotToken: string
    fChatId: string
    fSendKey: string
    fSecret: string
    fKey: string
    fServer: string
    fTopic: string
    phWecom: string
    phFeishu: string
    phFeishuSecret: string
    phDingtalk: string
    phDingtalkSecret: string
    phDiscord: string
    phSlack: string
    phBarkServer: string
    phBarkKey: string
    phNtfyServer: string
    phNtfyTopic: string
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
    unpriced: string
    pricingSourceModelsDev: string
    pricingSourceOpenRouter: string
    pricingSourceBuiltin: string
    pricingUpdatedAt: (value: string) => string
    pricingGeneratedAt: (value: string) => string
    pricingModelCount: (n: number) => string
    costKnownFloor: (tokens: string) => string
    costFallbackPricing: string
    heatmapTitle: string
    heatmapDaily: string
    heatmapWeekly: string
    heatmapCumulative: string
    heatmapLess: string
    heatmapMore: string
    heatmapActiveDays: string
    heatmapDays: (n: number) => string
    heatmapBest: string
    colInput: string
    colOutput: string
    colCache: string
    colCacheWrite: string
    /** Billing unit of an agent that reports no tokens (Qoder global) */
    colCredits: string
    statusOnline: string
    statusOffline: string
    shownAgents: (n: number) => string
    distTitle: string
    distTotal: string
    distMonthUsage: string
    distOther: string
    distUnavailable: string
    attentionTitle: string
    attentionEmpty: string
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
    agoHoursMinutes: (h: number, m: number) => string
    agoDaysHours: (d: number, h: number) => string
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
    /** Expanded agent row: how many models that agent called */
    agentModelsLabel: (n: number) => string
    agentModelsEmpty: string
  }
  trends: {
    pageDesc: string
    /** Range selector */
    rangeLabel: string
    rangeAll: string
    rangeDays: (n: number) => string
    /** View mode */
    viewAggregate: string
    viewByModel: string
    /** KPI row */
    kpiTokens: string
    kpiCalls: string
    kpiHitRate: string
    /** Cache split is only reported per day, never per model */
    hitRateUnavailable: string
    hitRateUnavailableShort: string
    kpiSpeed: string
    /** Speed is apportioned from session-active time, not measured */
    speedHint: string
    estimated: string
    /** Credits-billed gateway unit (Qoder global), shown as its own series */
    kpiCredits: string
    seriesCredits: string
    /** Unit note: a separate unit, never converted to USD or folded into tokens */
    creditsFooter: string
    /** Credits are day-level, so a model filter cannot split them */
    creditsUnavailableShort: string
    /** Independent credits series section */
    chartCredits: string
    creditsChartNote: string
    /** Chart titles */
    chartTrend: string
    chartSplit: string
    chartSplitHint: string
    chartCompare: string
    chartCompareHint: string
    /** Series / axis labels */
    seriesCacheRead: string
    seriesInput: string
    seriesOutput: string
    seriesCalls: string
    seriesSpeed: string
    /** Model filter */
    filterTitle: string
    /** The single reset button: clearing the pick list IS "show all models" */
    filterAll: string
    filterSelected: (n: number) => string
    /** States */
    emptyTitle: string
    emptyDesc: string
    gathering: string
    /** Bucketing note for long ranges */
    weeklyNote: string
    /** Filtered view cannot split input from cache */
    filteredSplitNote: string
    /** All-time block, independent of the range selector */
    cumulativeTitle: string
    cumulativeDesc: string
    cumulativeTotalLabel: string
    cumulativeActiveDays: string
    cumulativeDays: (n: number) => string
    cumulativeSpan: string
    cumulativeModels: string
    cumulativeColTokens: string
    cumulativeColShare: string
    cumulativeSum: string
    /** Row label that folds the table's tail */
    cumulativeMoreModels: (n: number) => string
    /** Per-model totals cover only records that carry a model id */
    cumulativeModelNote: string
    /** The split chart plots output only, while the KPI row stays aggregate */
    splitKpiNote: string
    /** Marker appended to a bucket that covers less than a full period */
    partialBucketShort: string
    /** Note under the chart explaining the short trailing column */
    partialBucketNote: string
  }
  manage: {
    agentsTitle: string
    agentsDesc: string
    localAgents: string
    apiAccounts: string
    subscriptionTitle: string
    codexNoAuth: string
    codexCreditsUnlimited: string
    codexBalance: (amount: string) => string
    codexResetCredits: (n: number) => string
    /** Expiry of the earliest banked reset credit; `date` is a locale date */
    codexResetCreditsExpires: (date: string) => string
    codexSpendLimit: (pct: number) => string
    codexSpendLimitReached: string
    claudeNoAuth: string
    claudeReauth: string
    claudeWindows: {
      fiveHour: string
      sevenDay: string
      sevenDayOpus: string
      sevenDaySonnet: string
    }
    cursorNoAuth: string
    cursorSealed: string
    /** Cursor's visible credit grant balance; `amount` arrives pre-formatted with $ */
    cursorCreditsLeft: (amount: string) => string
    /** Grant expiry; `date` is a locale date */
    cursorCreditsExpire: (date: string) => string
    copilotNoAuth: string
    clineNoAuth: string
    clineReauth: string
    jetbrainsNoAuth: string
    jetbrainsTopUp: (credits: string) => string
    windsurfNoAuth: string
    windsurfStale: string
    kiroNoAuth: string
    kiroReauth: string
    kiloNoAuth: string
    kiloReauth: string
    aliNoAuth: string
    qwenNoAuth: string
    alitokenNoAuth: string
    aliReauth: string
    aliCookieAppBound: string
    quotaUnsupportedPlatform: string
    alibabaConnect: string
    alibabaConnecting: string
    alibabaConnectHint: string
    alibabaConnectFailed: string
    alibabaNoPlan: string
    /** OpenDesign quota card: device-code login + manual cookie fallback */
    opendesignLogin: string
    opendesignLoggingIn: string
    opendesignLoginCode: (code: string) => string
    opendesignLoginExpired: string
    opendesignLoginDenied: string
    opendesignLoginRetry: string
    opendesignCancel: string
    opendesignManual: string
    opendesignPasteHint: string
    opendesignPasteInvalid: string
    opendesignSaveFailed: string
    opendesignNoAuth: string
    opendesignReauth: string
    opendesignNoPlan: string
    opendesignUnavailable: string
    opendesignClear: string
    opendesignSignOut: string
    detailToggle: string
    subscriptionsManage: string
    subscriptionsEmpty: string
    groupPlan: string
    groupConsole: string
    groupLocal: string
    filterPlaceholder: string
    filterEmpty: string
    enabledCount: (enabled: number, total: number) => string
    experimental: string
    closeDrawer: string
    pasteCurl: string
    pasteCurlHint: string
    pasteSave: string
    pasteSaving: string
    pasteSaved: string
    pasteClear: string
    pasteErrParse: string
    pasteErrNoCookie: string
    pasteErrHost: string
    pasteErrConsole: string
    pasteErrWrongConsole: string
    pasteErrNoKeystore: string
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
    /** Grok probe failed for a non-login reason (network/timeout/server) */
    grokUnavailable: string
    /** Banked reset tokens left (gRPC-Web enhancement) */
    grokResetsLeft: (n: number) => string
    /** Expiry of the earliest banked token; `date` is a locale date */
    grokResetsExpire: (date: string) => string
    qoderNoAuth: string
    qoderReauth: string
    qoderUnavailable: string
    qoderCredits: string
    qoderRemaining: (value: string) => string
    traeCreditsPlan: string
    traeNoAuth: string
    traeReauth: string
    traeBilling: string
    /** Trae international (SG/US deployment) card */
    traeIntlCreditsPlan: string
    traeIntlNoAuth: string
    traeIntlReauth: string
    traeIntlBilling: string
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
    alertResolved: string
    filterUnread: string
    filterAll: string
    noAlerts: string
    rulesTitle: string
    thresholdResetLabel: string
    thresholdResetUnit: string
    thresholdHighLabel: string
    thresholdLowLabel: string
    planFilterEmpty: string
    planFilterReset: string
    reorderHint: string
    reorderPosition: (position: number, total: number) => string
  }
  common: {
    clearSearch: string
    cancel: string
    confirm: string
    confirmTitle: string
    chartKeyboardHint: string
    /** Unit suffix for token counts ("123 token" zh / "123 tokens" en) */
    unitTokens: string
    /** Unit suffix for message counts ("12 条" zh / "12 msgs" en) */
    unitMsgs: string
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
    usageHistory: string
    usageHistoryHint: string
    usageHistoryRange: string
    usageHistoryEmpty: string
    usageHistorySpan: (days: number, oldest: string, newest: string) => string
    purgeScope: string
    purgeDays: (days: number) => string
    purgeAll: string
    purgeAction: string
    purgeHint: string
    purgeConfirm: (days: number) => string
    purgeConfirmAll: string
    purgeDone: (removed: number) => string
    purgeFailed: string
    repoLink: string
    exportHint: string
    /** Export copy stating the backup carries no credentials */
    exportNoKeys: string
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
  /** Kimi Code subscription quota card (local loopback server / remote usages endpoint) */
  kimiQuota: {
    subtitle: string
    windowWeekly: string
    windowFiveHour: string
    windowMonthTotal: string
    windowMonthCode: string
    windowOther: string
    staleLogin: string
    percentNote: string
    walletTitle: string
    walletRemaining: string
    walletUsed: string
  }
  antigravityQuota: {
    subtitle: string
    groupGemini: string
    groupThirdParty: string
    groupOther: string
    windowWeekly: string
    windowFiveHour: string
    windowOther: string
    remainingNote: string
    needsIde: string
    staleHandshake: string
    refreshUnavailable: string
    unavailable: string
  }
  factoryQuota: {
    windowFiveHour: string
    windowWeekly: string
    windowMonthly: string
    windowCoreFiveHour: string
    windowCoreWeekly: string
    windowCoreMonthly: string
    windowStandard: string
    windowPremium: string
    windowOther: string
    noAuth: string
    staleLogin: string
    unavailable: string
    /** Extra-usage balance; the value is pre-formatted with the $ prefix */
    topUpCredits: (value: string) => string
  }
  devinQuota: {
    windowDaily: string
    windowWeekly: string
    windowOther: string
    noAuth: string
    staleLogin: string
    unavailable: string
    percentNote: string
  }
  ampQuota: {
    subtitle: string
    individualCredits: string
    workspaceCredits: string
    meterFree: string
    meterSubscriptionOther: string
    meterSubscriptionOrb: string
    meterOther: string
    noAuth: string
    unavailable: string
    note: string
  }
  providerErrors: {
    keyInvalid: string
    cursorTokenShape: string
    badResponse: string
    volcSignature: string
    volcCredFormat: string
    volcNoWindows: string
    networkFailed: string
    noWindows: string
    kimiWrongSurface: string
    kimiQuotaUnavailable: string
    kimiQuotaNoServer: string
    /** query.ts 401/403 for opencode */
    keyNoGoSubscription: string
    /** query.ts 401/403 for every other adapter */
    keyInvalidNoPermission: string
    /** query.ts: preflight body is not a JSON object */
    badJson: string
    /** query.ts: thrown transport error caught in fetchUsage */
    networkBlocked: string
    /** balance adapters (deepseek/novita/stepfun/openrouter): unusable key or drifted shape */
    keyOrShapeChanged: string
    /** siliconflow 20012 / zhipu 401 */
    keyExpiredOrInvalid: string
    /** siliconflow / zhipu: request rejected without a specific reason */
    queryFailed: string
    /** siliconflow/minimax: a required response field is absent */
    missingField: (field: string) => string
    /** minimax: server gave no status_msg, surface its numeric status */
    errorCode: (code: number) => string
    /** minimax 1004/2049: key rejected, server message appended */
    keyInvalidWithReason: (msg: string) => string
    /** minimax: model_remains missing or empty */
    noModelRemains: string
    /** minimax: subscription active but no parseable quota fields */
    subscriptionUnparsed: string
    /** zhipu: 200 OK but no quota rows */
    noQuotaData: string
  }
  updater: {
    readyTitle: string
    readyBody: (version: string) => string
    installNow: string
    later: string
  }
  agentConfig: {
    title: string
    desc: string
    desktopOnlyTitle: string
    desktopOnlyDesc: string
    loading: string
    notInstalled: (agent: string) => string
    notInstalledHint: string
    parseError: string
    reload: string
    searchPlaceholder: string
    noMatch: string
    providersSummary: (providers: number, models: number) => string
    addProvider: string
    edit: string
    delete: string
    deleteHint: string
    builtinBadge: string
    builtinHint: string
    migratedBadge: string
    migratedHint: string
    protocol: string
    baseUrl: string
    baseUrlUnset: string
    apiKey: string
    keyUnset: string
    keyFromEnv: (name: string) => string
    show: string
    hide: string
    revealFailed: string
    models: string
    noModels: string
    modelId: string
    modelName: string
    contextLimit: string
    outputLimit: string
    capabilities: string
    efforts: string
    defaultEffort: string
    readOnly: string
    cliMissing: string
    globalsTitle: string
    defaultModel: string
    defaultProvider: string
    permissionMode: string
    defaultVariant: string
    newProviderTitle: string
    editProviderTitle: string
    providerName: string
    providerNamePlaceholder: string
    providerNameHint: string
    protocolHint: string
    baseUrlPlaceholder: string
    apiKeyPlaceholder: string
    apiKeyKeepHint: string
    modelsLabel: string
    modelIdPlaceholder: string
    modelNamePlaceholder: string
    addModel: string
    removeModel: string
    save: string
    cancel: string
    saving: string
    savedWithBackup: (path: string) => string
    saveFailed: (message: string) => string
    fetchModels: string
    fetching: string
    fetchOk: (count: number) => string
    fetchFailed: (message: string) => string
    fetchNone: string
    addSelected: string
    selectAll: string
    deselectAll: string
    modelParams: string
    inputModalities: string
    modalityText: string
    modalityImage: string
    modalityVideo: string
    modalityAudio: string
    modalityPdf: string
    behaviour: string
    behaviourToolUse: string
    behaviourThinking: string
    behaviourAlwaysThinking: string
    effortLevels: string
    effortDefault: string
    effortUnset: string
    limitHint: string
    expandModel: string
    collapseModel: string
    testModel: string
    testing: string
    testOk: (ms: number) => string
    testFailed: string
    testHint: string
    testTimeout: string
    testSuccess: string
    modelRenamed: string
  }
}