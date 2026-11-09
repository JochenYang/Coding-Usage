import { net } from 'electron'
import {
  buildChannelRequest,
  channelErrorDetail,
  isChannelSuccess,
  type PushChannel,
} from './webhook-channels'
import { ensureIlinkSessionWarm, recoverIlinkSession } from './weixin-session'

/** Channel ids this app can send through */
const CHANNELS = ['wecom', 'feishu', 'telegram', 'weixin']

/**
 * Delivers one alert batch through one channel.
 *
 * The `webhook:send` channel and the background engine both call this: while no
 * window is open the engine pushes on its own, and it must send exactly what the
 * page's test button sends, iLink's session warm-up and recovery included —
 * otherwise a cold-start push fails with `{ret:-2, prepare failed}` and the user
 * sees a "sent" test that never arrives.
 *
 * Arguments arrive unknown because one caller is IPC and the other is internal:
 * both are validated here, once.
 */
export async function sendWebhook(
  channel: unknown,
  cred: unknown,
  title: unknown,
  text: unknown,
): Promise<WebhookSendResult> {
  if (
    !CHANNELS.includes(channel as string) ||
    !cred ||
    typeof cred !== 'object' ||
    typeof title !== 'string' ||
    !title ||
    typeof text !== 'string' ||
    !text
  ) {
    return { ok: false, status: 0, error: 'invalid-request' }
  }
  const c = cred as Record<string, unknown>
  const request = buildChannelRequest(
    channel as PushChannel,
    {
      url: typeof c.url === 'string' ? c.url : undefined,
      token: typeof c.token === 'string' ? c.token : undefined,
      chatId: typeof c.chatId === 'string' ? c.chatId : undefined,
      userId: typeof c.userId === 'string' ? c.userId : undefined,
    },
    title,
    text,
  )
  if (!request) return { ok: false, status: 0, error: 'invalid-credential' }
  // WeChat iLink: sendmessage only lands while the bot session is
  // "prepared" (ZCode keeps a getupdates long-poll alive for that).
  // This app is opened on demand, so warm the session after a cold
  // start and recover from {ret:-2,prepare failed} with one full
  // getupdates round before the single retry below.
  const weixinToken = channel === 'weixin' ? (c.token as string) : ''
  if (weixinToken) {
    // The return value matters: a bare send against an unprepared session
    // is the deterministic {ret:-2} this whole path exists to avoid. When
    // warming fails we still try — the platform occasionally accepts it —
    // but the log line is what makes a cold-start failure diagnosable.
    const warm = await ensureIlinkSessionWarm(weixinToken)
    if (!warm) {
      console.error('[webhook:send] channel=weixin warm=fail, sending anyway')
    }
  }
  const isWeixinPrepareFailed = (json: unknown): boolean => {
    if (channel !== 'weixin' || json == null || typeof json !== 'object') return false
    const obj = json as Record<string, unknown>
    const layers = [obj, obj.data, obj.result].filter(
      (l): l is Record<string, unknown> => l != null && typeof l === 'object' && !Array.isArray(l),
    )
    return layers.some((l) => {
      const ret = l.ret
      const msg = typeof l.errmsg === 'string' ? l.errmsg : typeof l.message === 'string' ? l.message : ''
      return ret === -2 || ret === '-2' || /prepare failed/i.test(msg)
    })
  }
  // One retry on transport-level failure: the iLink endpoint occasionally
  // black-holes a request past the 15s timeout while the next one answers
  // instantly. A hard-down network fails both attempts quickly anyway.
  // WeChat prepare-failed also uses the retry slot after a session recover.
  let lastError = ''
  let weixinRecovered = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await net.fetch(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(request.headers ?? {}) },
        body: request.body,
        signal: AbortSignal.timeout(15_000),
      })
      let json: unknown = null
      try {
        json = JSON.parse(await res.text())
      } catch {
        // Non-JSON error page (gateway etc.) — the HTTP status carries it
      }
      // Logical failures (HTTP 200 + platform errcode, e.g. weixin ret!=0)
      // must carry the platform detail too — otherwise the renderer can only
      // fall back to a bare "HTTP 200" and the real cause is invisible.
      const ok = isChannelSuccess(channel as PushChannel, res.ok, json)
      if (!ok) {
        // Cold-start / idle-session rejection: re-prepare via getupdates
        // and spend the retry slot on the same payload (not a duplicate
        // logical message — the first attempt never delivered).
        if (weixinToken && !weixinRecovered && isWeixinPrepareFailed(json)) {
          weixinRecovered = true
          const recovered = await recoverIlinkSession(weixinToken)
          console.error(`[webhook:send] channel=weixin prepare-failed, recover=${recovered ? 'ok' : 'fail'}`)
          if (recovered) continue
        }
        const detail = channelErrorDetail(channel as PushChannel, res.status, json)
        console.error(`[webhook:send] channel=${channel as string} status=${res.status} detail=${detail}`)
        // A platform rejection is deterministic — retrying would just
        // duplicate the failure, so return immediately
        return { ok: false, status: res.status, error: detail }
      }
      return { ok, status: res.status }
    } catch (e) {
      lastError = String(e instanceof Error ? e.message : e)
    }
  }
  return { ok: false, status: 0, error: lastError }
}
