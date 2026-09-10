import type { AlertItem } from './alerts'
import type { Dict } from '../i18n/types'
import type { IntegrationsSettings } from '../types'
import { alertDetail, alertTitle } from './alert-text'
import { ENC_PREFIX } from './storage'

/**
 * Multi-channel webhook alert push (WeCom / WeChat iLink / Feishu-Lark /
 * Telegram). The alert engine re-derives the full unread set on every refresh;
 * this module offers every alert the caller passes and dedups per channel via
 * a cooldown persisted across restarts — one alert id re-pushes at most once
 * per cooldown window per channel, so a flapping metric cannot spam a group.
 * Everything runs through the desktop bridge — the browser path has no webhook
 * capability.
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

/** Per-channel failure backoff: after a failed auto-push the channel rests
 *  instead of hammering every refresh. Retrying into a platform throttle
 *  (iLink answers ret=-2 while throttled) EXTENDS the penalty window, so
 *  backing off is what actually recovers delivery. Manual tests bypass this.
 */
const FAIL_BACKOFF_KEY = 'coding-usage.alertPush.failback.v1'
const FAIL_BACKOFF_MS = 30 * 60_000
const MAX_BACKOFF_ENTRIES = 20

function loadBackoff(): Record<string, number> {
  try {
    const raw = localStorage.getItem(FAIL_BACKOFF_KEY)
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

function saveBackoff(map: Record<string, number>): void {
  const entries = Object.entries(map)
  const trimmed = entries.length > MAX_BACKOFF_ENTRIES ? entries.slice(-MAX_BACKOFF_ENTRIES) : entries
  try {
    localStorage.setItem(FAIL_BACKOFF_KEY, JSON.stringify(Object.fromEntries(trimmed)))
  } catch {
    // best-effort
  }
}

/** Channels usable right now (credential present and not still ciphertext) */export interface UsableChannel {
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

/** Per-channel outcome of one push batch (error present exactly when ok is false) */
export interface PushOutcome {
  ok: boolean
  error?: string
}

/**
 * Push a batch of alerts through every configured channel. Callers pass the
 * full unread set — not just brand-new ids: each channel applies its own
 * cooldown, so a still-unread, still-active alert re-pushes once the window
 * lapses (this is what "at most once per 4 hours per channel" promises).
 * Filtering upstream on "new since last render" would starve exactly the
 * persistent conditions (low balance, long high usage) while transient ones
 * (window resets, whose ids lapse and reappear) kept flowing.
 *
 * Each channel fails independently (one broken webhook must not block the
 * others); its pushed ids are recorded only on success, so a failed send is
 * retried on the next refresh cycle (subject to the cooldown once it lands).
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
  const pushed = loadPushed()
  const backoff = loadBackoff()
  const now = Date.now()
  const results: Record<string, PushOutcome> = {}
  let attempted = false
  let backoffDirty = false

  await Promise.all(
    channels.map(async ({ channel, cred }) => {
      // Failure backoff first: hammering a throttled platform only extends
      // its penalty window, so a recently-failed channel rests quietly
      if ((backoff[channel] ?? 0) > now) return
      // Per-channel cooldown: an id pushed recently through this channel waits
      const fresh = items.filter((a) => now - (pushed[`${channel}:${a.id}`] ?? 0) > PUSH_COOLDOWN_MS)
      if (fresh.length === 0) return
      attempted = true
      // Body covers exactly what this channel is about to send — other
      // channels may be on a different cooldown phase for the same batch
      const body = fresh.map((a) => {
        const detail = alertDetail(a, t)
        return `${alertTitle(a, t)}${detail ? ` · ${detail}` : ''}`
      }).join('\n')
      const res = await bridge.webhookSend(channel, cred, title, body)
      results[channel] = res.ok ? { ok: true } : { ok: false, error: res.error ?? `HTTP ${res.status}` }
      logPushAttempt(channel, res.ok, res.ok ? undefined : (res.error ?? `HTTP ${res.status}`))
      if (res.ok) {
        for (const a of fresh) pushed[`${channel}:${a.id}`] = now
        if (backoff[channel] != null) {
          delete backoff[channel]
          backoffDirty = true
        }
      } else {
        backoff[channel] = now + FAIL_BACKOFF_MS
        backoffDirty = true
      }
    }),
  )
  if (attempted) savePushed(pushed)
  if (backoffDirty) saveBackoff(backoff)
  return results
}
