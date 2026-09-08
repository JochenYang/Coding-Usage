import type { AlertItem } from './alerts'
import type { Dict } from '../i18n/types'
import type { IntegrationsSettings } from '../types'
import { alertDetail, alertTitle } from './alert-text'
import { ENC_PREFIX } from './storage'

/**
 * Multi-channel webhook alert push (WeCom / WeChat iLink / Feishu-Lark /
 * Telegram). The alert engine derives the live set on every refresh; this
 * module pushes only the genuinely NEW ids (not in the previous render's
 * set), with a per-channel cooldown persisted across restarts so a flapping
 * metric cannot spam a group. Everything runs through the desktop bridge —
 * the browser path has no webhook capability.
 */

const PUSHED_KEY = 'coding-usage.alertPush.v1'
/** Same alert id re-pushes at most once per channel per cooldown window */
const PUSH_COOLDOWN_MS = 4 * 60 * 60_000
/** Bound the persisted map: channels × alert ids resolve out constantly */
const MAX_PUSHED_ENTRIES = 500

/** Ring buffer of recent push attempts so silent auto-push failures stay inspectable */
const PUSH_LOG_KEY = 'coding-usage.alertPush.log.v1'
const MAX_PUSH_LOG_ENTRIES = 30

export interface PushLogEntry {
  at: number
  channel: WebhookChannel
  ok: boolean
  error?: string
}

/** Newest-first push attempt history (empty when nothing was ever attempted) */
export function loadPushLog(): PushLogEntry[] {
  try {
    const raw = localStorage.getItem(PUSH_LOG_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is PushLogEntry =>
        e != null &&
        typeof e === 'object' &&
        typeof (e as PushLogEntry).at === 'number' &&
        typeof (e as PushLogEntry).channel === 'string' &&
        typeof (e as PushLogEntry).ok === 'boolean',
    )
  } catch {
    return []
  }
}

/** Drop the whole push-attempt history (diagnostics only — new attempts reappear) */
export function clearPushLog(): void {
  try {
    localStorage.removeItem(PUSH_LOG_KEY)
  } catch {
    // ignore
  }
}
/** Record one push attempt (manual test or auto push); failures stay visible on the integrations page */
export function logPushAttempt(channel: WebhookChannel, ok: boolean, error?: string): void {
  try {
    const log = loadPushLog()
    log.push({ at: Date.now(), channel, ok, ...(ok ? {} : { error: error ?? '' }) })
    localStorage.setItem(PUSH_LOG_KEY, JSON.stringify(log.slice(-MAX_PUSH_LOG_ENTRIES)))
  } catch {
    // best-effort
  }
}

/** Channels usable right now (credential present and not still ciphertext) */
export interface UsableChannel {
  channel: WebhookChannel
  cred: WebhookCredential
}

export function configuredChannels(intg: IntegrationsSettings): UsableChannel[] {
  const out: UsableChannel[] = []
  if (intg.wecomWebhook && !intg.wecomWebhook.startsWith(ENC_PREFIX)) {
    out.push({ channel: 'wecom', cred: { url: intg.wecomWebhook } })
  }
  if (intg.feishuWebhook && !intg.feishuWebhook.startsWith(ENC_PREFIX)) {
    out.push({ channel: 'feishu', cred: { url: intg.feishuWebhook } })
  }
  if (
    intg.telegramBotToken &&
    !intg.telegramBotToken.startsWith(ENC_PREFIX) &&
    intg.telegramChatId
  ) {
    out.push({ channel: 'telegram', cred: { token: intg.telegramBotToken, chatId: intg.telegramChatId } })
  }
  if (intg.weixinBotToken && !intg.weixinBotToken.startsWith(ENC_PREFIX) && intg.weixinBotUserId) {
    out.push({ channel: 'weixin', cred: { token: intg.weixinBotToken, userId: intg.weixinBotUserId } })
  }
  return out
}

function loadPushed(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PUSHED_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function savePushed(map: Record<string, number>): void {
  const entries = Object.entries(map)
  // Keep the newest when pruning
  const trimmed = entries.length > MAX_PUSHED_ENTRIES ? entries.slice(-MAX_PUSHED_ENTRIES) : entries
  try {
    localStorage.setItem(PUSHED_KEY, JSON.stringify(Object.fromEntries(trimmed)))
  } catch {
    // best-effort
  }
}

/**
 * Alerts that appeared since the previous render's id set. (The cooldown is
 * applied per channel at push time, not here.)
 */
export function filterNewAlerts(alerts: AlertItem[], prevIds: ReadonlySet<string>): AlertItem[] {
  if (alerts.length === 0) return []
  return alerts.filter((a) => !prevIds.has(a.id))
}

/** Plain-text body lines for a batch of new alerts (platform formatting happens in main) */
function buildBodyLines(items: AlertItem[], t: Dict): string[] {
  return items.map((a) => {
    const detail = alertDetail(a, t)
    return `${alertTitle(a, t)}${detail ? ` · ${detail}` : ''}`
  })
}

/** Per-channel outcome of one push batch (error present exactly when ok is false) */
export interface PushOutcome {
  ok: boolean
  error?: string
}

/**
 * Push a batch of new alerts through every configured channel. Each channel
 * fails independently (one broken webhook must not block the others); its
 * pushed ids are recorded only on success, so a failed send is retried on
 * the next refresh cycle (subject to the cooldown once it eventually lands).
 * Every attempt is appended to the push log so background failures are
 * inspectable on the integrations page instead of silent.
 */
export async function pushAlerts(
  intg: IntegrationsSettings,
  items: AlertItem[],
  t: Dict,
): Promise<Record<string, PushOutcome>> {
  const bridge = window.desktopBridge
  const channels = configuredChannels(intg)
  if (!bridge || items.length === 0 || channels.length === 0) return {}

  const title = t.integrations.pushTitle
  const body = buildBodyLines(items, t).join('\n')
  const pushed = loadPushed()
  const now = Date.now()
  const results: Record<string, PushOutcome> = {}

  await Promise.all(
    channels.map(async ({ channel, cred }) => {
      // Per-channel cooldown: an id pushed recently through this channel waits
      const fresh = items.filter((a) => now - (pushed[`${channel}:${a.id}`] ?? 0) > PUSH_COOLDOWN_MS)
      if (fresh.length === 0) return
      const res = await bridge.webhookSend(channel, cred, title, body)
      results[channel] = res.ok ? { ok: true } : { ok: false, error: res.error ?? `HTTP ${res.status}` }
      logPushAttempt(channel, res.ok, res.ok ? undefined : (res.error ?? `HTTP ${res.status}`))
      if (res.ok) {
        for (const a of fresh) pushed[`${channel}:${a.id}`] = now
      }
    }),
  )
  savePushed(pushed)
  return results
}
