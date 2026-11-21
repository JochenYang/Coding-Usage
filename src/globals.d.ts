/**
 * Global type declarations for the optional Electron desktop bridge.
 * The bridge is injected by the preload script only when running inside
 * Electron; the plain browser dev path must work without it (hence optional).
 */
import type { AlertItem } from './lib/alerts'
import type {
  AgentConfigPayload,
  AgentId,
  AgentKeyReveal,
  AgentModelListResult,
  AgentModelTestResult,
  AgentProviderInput,
  AgentWriteResult,
} from './lib/agent-config'

export {}

declare global {
  /** Build-time constant injected by electron-vite from package.json#version */
  const __APP_VERSION__: string
  /** Snapshot of the auto-update state machine (desktop:update-status) */
  interface DesktopUpdateState {
    status: 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error'
    version?: string
    percent?: number
    /** Active mirror, e.g. "gh-proxy.com" when GitHub direct failed */
    mirror?: string
    message?: string
  }

  /** Result of a main-process `net.fetch` round-trip (`net:fetch` IPC) */
  interface DesktopFetchResult {
    status: number
    body: string
  }

  /** Result of one webhook push attempt (`webhook:send` IPC) */
  interface WebhookSendResult {
    ok: boolean
    /** HTTP status; 0 means the request never completed */
    status: number
    /** Logical failure detail (e.g. a platform errcode) */
    error?: string
  }

  /** Alert-push channel ids accepted by `webhook:send` */
  type WebhookChannel = 'wecom' | 'feishu' | 'telegram' | 'weixin'

  /** Credential pieces for a webhook send; only the channel-relevant fields are used */
  interface WebhookCredential {
    /** wecom / feishu full webhook URL */
    url?: string
    /** telegram bot token / weixin iLink bot token */
    token?: string
    /** telegram chat id */
    chatId?: string
    /** weixin ilink_user_id push target */
    userId?: string
  }

  /** `ilink:begin` — fresh WeChat login QR (data: URL image) */
  interface IlinkBeginResult {
    dataUrl?: string
    qrCode?: string
    expiresAt?: number
    error?: string
  }

  /** `ilink:poll` — WeChat login QR scan status */
  interface IlinkPollResult {
    status: 'pending' | 'scanned' | 'success' | 'expired' | 'error'
    botToken?: string
    botId?: string
    message?: string
  }

  /** `ilink:activate` — one WeChat bot activation check */
  interface IlinkActivateResult {
    userId?: string
    error?: string
  }

  /** Shape exposed as `window.desktopBridge` by `electron/preload.ts` */
  interface DesktopBridge {
    /**
     * Main-process fetch (not subject to CORS); status 0 means the request
     * failed entirely. `init` is an opt-in POST override for GraphQL-style
     * endpoints whose query travels in a JSON body; omitted means GET, so
     * every existing caller is unchanged.
     */
    fetch(
      url: string,
      headers: Record<string, string>,
      init?: { method?: 'POST'; body?: string },
    ): Promise<DesktopFetchResult>
    /** POST a markdown message to a WeCom group-robot webhook; the payload shape is owned by main */
    webhookSend(channel: WebhookChannel, cred: WebhookCredential, title: string, text: string): Promise<WebhookSendResult>
    /**
     * The background window finished its refresh cycle: the shell closes it. A
     * hidden window runs the renderer's own refresh, alerts, pushes and
     * snapshots once, so nothing is duplicated in the main process.
     */
    backgroundDone(): Promise<void>
    /** WeChat iLink bot: fetch a fresh login QR (image as data: URL) */
    ilinkBegin(): Promise<IlinkBeginResult>
    /** WeChat iLink bot: poll the login QR status; success returns the bot token */
    ilinkPoll(qrCode: string): Promise<IlinkPollResult>
    /** WeChat iLink bot: one activation check; userId appears after the user messages the bot */
    ilinkActivate(token: string): Promise<IlinkActivateResult>
    /** WeChat iLink bot: start the main-process getupdates keep-alive for this token */
    ilinkSessionStart(token: string): Promise<void>
    /** WeChat iLink bot: stop the keep-alive loop (disconnect / quit) */
    ilinkSessionStop(): Promise<void>
    /** Relay a fresh alert batch to the system-level island overlay (desktop only) */
    islandShow(alerts: unknown[]): Promise<void>
    /** Hide the system-level island overlay */
    islandHide(): Promise<void>
    /** Toggle click-through on the overlay (off while the pointer hovers it) */
    islandClickThrough(clickThrough: boolean): Promise<void>
    /** Focus the main window and open the alerts page (overlay body click) */
    islandOpenMain(): Promise<void>
    /** Overlay surface: subscribe to relayed alert batches */
    onIslandAlert(callback: (alerts: AlertItem[]) => void): () => void
    /** Overlay surface: its listener is live, so a batch held back can be delivered */
    islandReady(): Promise<void>
    /** Main window: fired when the overlay body is clicked */
    onOpenAlerts(callback: () => void): () => void
    /** Encrypt via safeStorage; returns an `enc:v3:<base64>` blob, or null when encryption is unavailable */
    encrypt(plain: string): Promise<string | null>
    /** Decrypt an `enc:v3:` blob produced by {@link DesktopBridge.encrypt}; null on failure */
    decrypt(blob: string): Promise<string | null>
    /** Scan local AI coding-agent usage via tokscale (main process). Absent in browser dev */
    tokscaleScan(): Promise<TokScaleRaw>
    /** Range covered by the persisted local-agent usage history */
    usageStats(): Promise<UsageHistoryStats>
    /**
     * Trim the stored usage history: `null` wipes it, a positive number keeps
     * the last N days. Only days already saved can go — a session file that
     * still exists is re-scanned into the store on the next refresh.
     */
    usagePurge(beforeDays: number | null): Promise<UsageHistoryPurgeResult>
    /** Codex subscription quota from the local ChatGPT login (official wham endpoint) */
    codexQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Claude subscription quota from the local Claude Code OAuth login (official usage endpoint) */
    claudeUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Gemini Code Assist quota via the local Gemini CLI OAuth login (refresh happens in main) */
    geminiUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Grok Build (SuperGrok) quota via the local `grok login` state; body is a normalized {percent,resetsAt,plan,remainingResets?,resetsExpireAt?} */
    grokUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /**
     * OpenDesign Go subscription quota via the Cloud account API. Primary
     * credential: the device-code control key from the device-code login
     * (started and polled through the three `opendesign:login-*` calls below;
     * the key is stored encrypted in the main process and never crosses IPC).
     * Manual fallback: a Cloud console Cookie pasted on the card. The body is
     * a normalized {plan, windows:[{id,percent,resetsAt}], walletUsd?} JSON
     * string. The inference API key cannot read quota.
     */
    opendesignQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /**
     * Start the official device-code login: the main process opens the
     * approval page in the browser and returns the 6-character approval code
     * plus the polling cadence. The device secret stays in the main process.
     */
    opendesignLoginStart(): Promise<
      | { ok: true; loginId: number; userCode: string; intervalMs: number; expiresAtMs: number }
      | { ok: false; reason: 'start-failed' | 'invalid' | 'network' }
    >
    /** One poll round: approved stores the control key in the main process. */
    opendesignLoginPoll(
      loginId: number,
    ): Promise<
      | { status: 'approved' }
      | { status: 'pending' }
      | { status: 'failed'; reason: 'expired' | 'denied' | 'cancelled' | 'invalid' }
    >
    /** Drop a pending device-code session (user cancelled or the card unmounted). */
    opendesignLoginCancel(loginId: number): Promise<void>
    /** Validate and store the pasted Cloud Cookie (encrypted at rest, main process only). */
    opendesignSetCookie(cookie: string): Promise<{ ok: boolean; reason?: string }>
    /** Drop the stored credential; the card returns to its no-login state. */
    opendesignClearCredential(): Promise<void>
    /** Qoder global build: credits pool from the IDE's own usage endpoint */
    qoderQuota(): Promise<{
      available: boolean
      reason?: string
      used?: number
      total?: number
      remaining?: number
      percent?: number
      isQuotaExceeded?: boolean
      userType?: string
      unit?: string
      fetchedAt?: number
    }>
    /** Trae CN credits usage via the IDE's encrypted local login; body is a normalized {percent,consumed,total,resetsAt,plan,packs} */
    traeUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /**
     * Trae international (SG/US deployment) entitlement usage via the
     * international IDE's local login (plaintext JSON or the same "tc" blob in
     * the international app-data dirs). Body is a normalized
     * {percent,consumed,total,resetsAt,plan,packs} with USD-denominated
     * numbers; the token never crosses this boundary.
     */
    traeIntlUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Cursor plan quota from the editor/CLI login (current-period body, or the legacy summary as fallback) */
    cursorUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** GitHub Copilot plan quota from the extension's hosts.json login */
    copilotUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Cline Pass windows from the local `cline auth` session. The token stays in the main process. */
    clineQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** JetBrains AI monthly credits from the IDE config. Local files only. */
    jetbrainsQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Windsurf plan cache from state.vscdb. Stale until the IDE is opened again. */
    windsurfQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Kiro credits from the CLI state database. The token stays in the main process. */
    kiroQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Kilo Pass from the CLI auth file or KILO_API_KEY. The token stays in the main process. */
    kiloQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /**
     * Factory (Droid) plan windows from the user's own Factory API key
     * (FACTORY_API_KEY or ~/.factory/.env). Body is a normalized
     * {plan, windows:[{id:'factoryFiveHour'|'factoryWeekly'|'factoryMonthly'|
     * 'factoryCore*'|'factoryStandard'|'factoryPremium', percent, resetsAt}],
     * topUpCredits (extra-usage balance in USD)}; the credential stays in the
     * main process.
     */
    factoryQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /**
     * Devin daily/weekly quota via the Devin CLI's own credentials.toml,
     * posted as the Connect-RPC metadata apiKey. Body is a normalized
     * {plan, windows:[{id:'devinDaily'|'devinWeekly', percent, resetsAt}]};
     * the key never crosses this boundary.
     */
    devinQuota(): Promise<{ available: boolean; body?: string; reason?: string }>
    /**
     * Amp balance via the official `amp usage` CLI sheet (the CLI resolves its
     * own login; nothing is sent anywhere). Body is a normalized
     * {plan, windows:[{id:'ampFree'|'ampSubscriptionOther'|'ampSubscriptionOrb',
     * percent, resetsAt}], topUpCredits (individual credits balance, USD),
     * workspaceCredits (USD), stale} — balance-type semantics: `percent` is
     * consumed, `topUpCredits`/`workspaceCredits` are plain USD figures and a
     * meter the CLI did not print stays absent rather than zeroed.
     */
    ampUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Alibaba Cloud Coding Plan windows from the browser console session. */
    alibabaCodingPlanQuota(): Promise<{ available: boolean; body?: string; reason?: string; detail?: string }>
    /** Qwen Cloud individual Token Plan windows from the browser session. */
    qwenCloudQuota(): Promise<{ available: boolean; body?: string; reason?: string; detail?: string }>
    /** Alibaba Token Plan personal windows from the browser session. */
    alibabaTokenPlanQuota(): Promise<{ available: boolean; body?: string; reason?: string; detail?: string }>
    /**
     * Last known-good quota per provider key, with the fetch time. Shown while
     * the fresh probe runs; never contains a credential.
     */
    quotaSnapshot(): Promise<
      Record<string, { at: number; result: { available: boolean; body?: string; reason?: string } }>
    >
    /**
     * Open the Alibaba Cloud console in an in-app window so its session lands
     * in the app's own cookie jar. Resolves when signed in, cancelled, or timed
     * out. No credential crosses this boundary.
     */
    alibabaConnect(target: 'coding' | 'qwen' | 'token'): Promise<{ ok: boolean; reason?: string; detail?: string }>
    /** Forget the in-app console session. */
    alibabaDisconnect(): Promise<void>
    /** Whether an in-app console session already exists. */
    alibabaSession(): Promise<boolean>
    /**
     * Store a "copy as cURL" request for one console. It is encrypted with the
     * OS keystore before it reaches disk; see pasted-requests.ts.
     */
    pastedRequestSet(
      target: 'alibaba' | 'alitoken' | 'qwen',
      text: string,
    ): Promise<{ ok: boolean; reason?: string }>
    /** Forget the pasted request for one console. */
    pastedRequestClear(target: 'alibaba' | 'alitoken' | 'qwen'): Promise<void>
    /** Read one coding agent's provider configuration; credentials arrive masked */
    agentConfigRead(agent: AgentId): Promise<AgentConfigPayload>
    /** Reveal one provider's plaintext credential — only on an explicit user request */
    agentConfigReveal(agent: AgentId, providerId: string): Promise<AgentKeyReveal>
    /** Create or update one provider; `revision` is the compare-and-swap token from the read */
    agentConfigSave(
      agent: AgentId,
      revision: string,
      input: AgentProviderInput,
    ): Promise<AgentWriteResult>
    /** Delete one provider and clear every pointer into it */
    agentConfigRemove(agent: AgentId, revision: string, providerId: string): Promise<AgentWriteResult>
    /**
     * Ask a provider which models it serves (main-process request).
     * `override` supplies values not saved yet, so a provider being created can
     * be queried too; anything omitted is read from the config file.
     */
    agentConfigListModels(
      agent: AgentId,
      providerId: string,
      override?: { baseUrl?: string; apiKey?: string; protocol?: string },
    ): Promise<AgentModelListResult>
    /**
     * Send one minimal live request through a configured model. `modelId` is the
     * wire name; this costs tokens, so it only runs on an explicit user action.
     */
    agentConfigTestModel(
      agent: AgentId,
      providerId: string,
      modelId: string,
    ): Promise<AgentModelTestResult>
    /**
     * Kimi Code subscription quota (5-hour / weekly / month windows, as
     * percentages of the plan allowance), read from the local CLI login; no
     * credential crosses this boundary. The body is a normalized
     * `{source, windows:[{id,percent,resetsAt}], wallet}` JSON string where
     * `id` is the canonical window identity.
     */
    kimiUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /**
     * Antigravity subscription quota, read from the Cloud Code API with the
     * credentials Antigravity stores (the IDE can stay closed; older builds fall
     * back to their loopback language server). The body is the service's JSON
     * (`{response:{groups:[…]}}`); no credential crosses this boundary.
     */
    antigravityUsage(): Promise<{ available: boolean; body?: string; reason?: string }>
    /** Mirror the encrypted v3 settings document to a userData file */
    settingsBackupWrite(payload: string): Promise<void>
    /** Read the mirrored settings document, or null when none exists */
    settingsBackupRead(): Promise<string | null>
    /** Minimize the window (custom caption button) */
    minimizeWindow(): Promise<void>
    /** Toggle maximize/restore (custom caption button + title-bar double click) */
    toggleMaximizeWindow(): Promise<void>
    /** Hide the window to the tray ("minimize to tray" choice) */
    hideWindow(): Promise<void>
    /** Real quit through the tray/confirm flow (sets the pass-through gate first) */
    quitApp(): Promise<void>
    /** Open an https URL in the system browser (main process validates the scheme) */
    openExternal(url: string): Promise<boolean>
    /** Current maximize state for the caption-button glyph */
    getWindowMaximized(): Promise<boolean>
    /** Subscribe to maximize/unmaximize transitions; returns an unsubscribe function */
    onWindowMaximized(callback: (maximized: boolean) => void): () => void
    /** Fired when a close is intercepted (caption X / Alt+F4) so the app can confirm */
    onCloseRequested(callback: () => void): () => void
    /** Quit and install the downloaded auto-update (no-op when nothing is staged) */
    installUpdate(): Promise<void>
    /** Kick a manual update check; resolves with the current state snapshot */
    checkForUpdates(): Promise<DesktopUpdateState>
    /** Read-only update snapshot (no check triggered) for late subscribers */
    updateState(): Promise<DesktopUpdateState>
    /** Subscribe to update-state transitions; returns an unsubscribe function */
    onUpdateStatus(callback: (status: DesktopUpdateState) => void): () => void
    /** Subscribe to autoUpdater's update-downloaded event; returns an unsubscribe function */
    onUpdateDownloaded(callback: (version: string) => void): () => void
  }

  /** Raw result of one tokscale scan round-trip (`tokscale:scan` IPC) */
  interface TokScaleRaw {
    /** Per-day contributions from `tokscale graph` (aggregated renderer-side) */
    daily?: unknown
    /** Set when the scan failed (binary missing, exit code, timeout, ...) */
    error?: string
    /** Epoch ms when the scan finished; stable across main-process cache hits */
    scannedAt?: number
  }

  /** Range covered by the persisted local-agent usage history (`usage:stats` IPC) */
  interface UsageHistoryStats {
    /** Number of days stored */
    days: number
    /** Oldest stored day (YYYY-MM-DD), null when the store is empty */
    oldest: string | null
    /** Newest stored day (YYYY-MM-DD), null when the store is empty */
    newest: string | null
  }

  /** Result of one history purge (`usage:purge` IPC) */
  interface UsageHistoryPurgeResult {
    /** Number of stored days deleted */
    removed: number
    /** Range remaining after the purge */
    stats: UsageHistoryStats
  }

  interface Window {
    desktopBridge?: DesktopBridge
  }
}
