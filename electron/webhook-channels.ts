import { randomUUID } from 'node:crypto'

/**
 * Alert-push channel adapters (pure, testable without Electron).
 *
 * The renderer supplies only a channel id, its credential pieces and the
 * title/body text; this module owns every platform-specific payload shape so
 * the IPC surface stays a narrow "send through channel X" instead of an open
 * POST proxy. Response semantics differ per platform too — the success check
 * lives here for the same reason.
 *
 * Platform notes (verified 2026-09):
 * - wecom:     POST <webhook> {msgtype:"markdown", markdown:{content}}.
 *              Answers HTTP 200 with {"errcode":0} on success.
 * - feishu:    POST <webhook> {msg_type:"text", content:{text}}. The webhook
 *              host distinguishes the China site (open.feishu.cn) from Lark
 *              (open.larksuite.com); the format is identical. Newer bots
 *              answer {"code":0}, legacy ones {"StatusCode":0}.
 * - telegram:  POST https://api.telegram.org/bot<token>/sendMessage
 *              {chat_id, text}. Plain text (no parse_mode): alert copy may
 *              contain characters that Telegram's markdown parser rejects.
 *              Answers {"ok":true}.
 * - weixin:    POST https://ilinkai.weixin.qq.com/ilink/bot/sendmessage with
 *              a Bearer ilink bot token (login/activation flow lives in
 *              weixin-ilink.ts). Text item_list payload, CRLF line breaks.
 *              Fail-closed ack: success needs an explicit zero ret/errcode
 *              or a message_id — HTTP 200 with neither is the platform's
 *              silent-drop shape ({ret:-2,errmsg:"prepare failed"} = stale
 *              session or burst throttle; {ret:0} without message_id =
 *              accepted but never rendered).
 */

export type PushChannel = 'wecom' | 'feishu' | 'telegram' | 'weixin'

/** Credential pieces for any channel; only the relevant fields are used */
export interface PushCredential {
  /** wecom / feishu full webhook URL */
  url?: string
  /** telegram bot token / weixin iLink bot token */
  token?: string
  /** telegram chat id */
  chatId?: string
  /** weixin: ilink_user_id push target */
  userId?: string
}

export interface ChannelRequest {
  url: string
  /** Serialized JSON body for the POST */
  body: string
  /** Extra headers beyond content-type (e.g. the weixin Bearer token) */
  headers?: Record<string, string>
}

/** message_type/message_state constants from ZCode's weixin send payload */
const WEIXIN_MESSAGE_TYPE = 2
const WEIXIN_MESSAGE_STATE = 2
/** Weixin item_list text type */
const WEIXIN_TEXT_ITEM = 1

const WECOM_CONTENT_LIMIT = 3800
const TELEGRAM_TEXT_LIMIT = 4000

function str(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Assemble the request for one channel; null when the credential is unusable */
export function buildChannelRequest(
  channel: PushChannel,
  cred: PushCredential,
  title: string,
  body: string,
): ChannelRequest | null {
  switch (channel) {
    case 'wecom': {
      const url = str(cred.url)
      if (!url.startsWith('https://')) return null
      const content = `**${title}**\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`
      return {
        url,
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: content.slice(0, WECOM_CONTENT_LIMIT) } }),
      }
    }
    case 'feishu': {
      const url = str(cred.url)
      if (!url.startsWith('https://')) return null
      return {
        url,
        body: JSON.stringify({ msg_type: 'text', content: { text: `${title}\n${body}` } }),
      }
    }
    case 'telegram': {
      const token = str(cred.token)
      const chatId = str(cred.chatId)
      // Bot tokens look like "123456:ABC-DEF…"; reject obvious garbage early
      if (!/^[\w-]+:[\w-]+$/.test(token) || !chatId) return null
      return {
        url: `https://api.telegram.org/bot${token}/sendMessage`,
        body: JSON.stringify({ chat_id: chatId, text: `${title}\n${body}`.slice(0, TELEGRAM_TEXT_LIMIT) }),
      }
    }
    case 'weixin': {
      const token = str(cred.token)
      const userId = str(cred.userId)
      // Token shape is not publicly documented (issued by the QR login flow);
      // only reject obviously empty credentials
      if (!token || !userId) return null
      const text = `${title}\n${body}`.replace(/\r\n|\r|\n/g, '\r\n')
      return {
        url: 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage',
        headers: {
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${token}`,
          'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 4294967296)), 'utf8').toString('base64'),
        },
        body: JSON.stringify({
          base_info: { channel_version: '2.0.0' },
          msg: {
            from_user_id: userId,
            to_user_id: userId,
            client_id: randomUUID(),
            message_type: WEIXIN_MESSAGE_TYPE,
            message_state: WEIXIN_MESSAGE_STATE,
            item_list: [{ type: WEIXIN_TEXT_ITEM, text_item: { text: text.slice(0, 3500) } }],
          },
        }),
      }
    }
  }
}

/**
 * Whether a channel's HTTP response signals success. `json` is the parsed
 * body when it was valid JSON, null otherwise (an HTML error page still
 * carries its meaning through the HTTP status).
 */
export function isChannelSuccess(channel: PushChannel, httpOk: boolean, json: unknown): boolean {
  if (!httpOk) return false
  if (json == null || typeof json !== 'object') {
    // An unparseable 200 body (gateway HTML page etc.) proves nothing arrived:
    // every channel, weixin included, needs a parseable ack to count success
    return false
  }
  const obj = json as Record<string, unknown>
  switch (channel) {
    case 'wecom':
      return obj.errcode === 0
    case 'feishu':
      return obj.code === 0 || obj.StatusCode === 0
    case 'telegram':
      return obj.ok === true
    case 'weixin': {
      // Fail-closed delivery ack: a real delivery carries either an explicit
      // zero code or a message_id. HTTP 200 with NEITHER is the platform's
      // silent-drop shape (field-verified by third parties: ret=0 without
      // message_id never renders, while ret=0 with message_id delivers) —
      // treating it as success is exactly how "test says ok but nothing
      // arrives" happens. Codes may be numbers or numeric strings.
      // Layers checked: root plus the known data/result envelopes.
      const layers = [obj, envelope(obj.data), envelope(obj.result)].filter(
        (l): l is Record<string, unknown> => l !== null,
      )
      if (layers.some(nonzeroCode)) return false
      // Explicit zero code without an ack id is still a failure (the detail
      // builder reports it as weixin-noack, never as a bare HTTP status)
      return layers.some(hasMessageId)
    }
  }
}

/** Short stable error detail for a failed channel response */
export function channelErrorDetail(channel: PushChannel, status: number, json: unknown): string {
  if (json != null && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    const layers = [obj, envelope(obj.data), envelope(obj.result)].filter(
      (l): l is Record<string, unknown> => l !== null,
    )
    // No delivery ack anywhere: report what the platform actually said
    // (usually a bare {} or {ret:0}) instead of a misleading bare status
    if (!layers.some(hasMessageId) && !layers.some(nonzeroCode)) return `${channel}-noack`
    // Scan the root plus the known envelope layers so a platform message
    // nested under data/result is still surfaced instead of a bare status.
    for (const layer of layers) {
      const text = messageText(layer)
      if (text) {
        const code = layer.errcode ?? layer.errCode ?? layer.code ?? layer.ret ?? status
        return `${channel}-${code}: ${text}`
      }
    }
    for (const layer of layers) {
      if (layer.errcode != null) return `${channel}-${layer.errcode}`
      if (layer.errCode != null) return `${channel}-${layer.errCode}`
      if (layer.code != null) return `${channel}-${layer.code}`
      if (layer.ret != null) return `${channel}-${retLabel(layer.ret)}`
    }
  }
  return `HTTP ${status}`
}

/** weixin ret codes carry no message; make the detail less cryptic than a bare number */
function retLabel(ret: unknown): string {
  return typeof ret === 'number' ? `ret${ret}` : String(ret)
}

/** Plain-object view of a possible response envelope layer (data / result) */
function envelope(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** True when the layer carries a delivery ack id (message_id spellings) */
function hasMessageId(o: Record<string, unknown>): boolean {
  for (const k of ['message_id', 'messageId', 'msg_id', 'msgid']) {
    const v = o[k]
    if (typeof v === 'string' ? v !== '' : typeof v === 'number' && Number.isFinite(v)) return true
  }
  return false
}
/** True when the layer carries an explicit nonzero platform code (number or numeric string) */
function nonzeroCode(o: Record<string, unknown>): boolean {
  for (const k of ['ret', 'errcode', 'errCode', 'code']) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return true
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) !== 0) return true
  }
  return false
}

/** First human-readable message under any common key spelling (case-insensitive) */
function messageText(o: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v && /^(err_?msg|msg|message|description|desc|detail|reason|error)$/i.test(k)) {
      return v
    }
  }
  return null
}
