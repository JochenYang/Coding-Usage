import QRCode from 'qrcode'

/**
 * WeChat iLink bot platform client (login + activation only).
 *
 * ZCode's WeChat bot channel runs on WeChat's official iLink AI-bot platform
 * (ilinkai.weixin.qq.com). Protocol reversed from ZCode's bundled renderer
 * (2026-09, no public docs — treat shape changes as a real risk):
 *
 * 1. Login:    GET /ilink/bot/get_bot_qrcode?bot_type=3 (no auth, header
 *              `iLink-App-ClientVersion: 1`) → {qrcode, qrcode_img_content,
 *              ret}. NOTE: qrcode_img_content is the PAYLOAD STRING to encode
 *              into a QR (a liteapp.weixin.qq.com short link), NOT an image
 *              URL — the caller must render the QR itself (QRCode.toDataURL).
 * 2. Poll:     GET /ilink/bot/get_qrcode_status?qrcode=<code> → status
 *              0/1/2/3/4 (pending/scanned/success/expired); success returns
 *              {bot_token, ilink_bot_id}.
 * 3. Activate: the bot stays silent until the user sends it one message.
 *              POST /ilink/bot/getupdates {base_info, get_updates_buf:""}
 *              (Bearer bot_token) surfaces messages; the message list hides
 *              under msgs/messages/updates/items/list and from_user_id is
 *              the push target.
 * 4. Push:     see webhook-channels.ts 'weixin' — POST /ilink/bot/sendmessage
 *              with a msg.item_list text body; ret/errcode 0 = success.
 *
 * All requests run in the Electron main process (net.fetch, no CORS). Only
 * the token and the user id ever cross the IPC boundary.
 */

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const ILINK_PREFIX = '/ilink/bot'
/** Fresh QR fetch — a plain request, short timeout */
const QR_TIMEOUT_MS = 15_000
/**
 * get_qrcode_status / getupdates are SERVER-SIDE LONG POLLS: unscanned, the
 * status endpoint holds ~30s before answering {ret:0,status:"wait"} (verified
 * live 2026-09). The timeout must exceed that hold window or every poll
 * aborts client-side.
 */
const POLL_TIMEOUT_MS = 45_000

export interface IlinkQrSession {
  /** Opaque code used for get_qrcode_status polling */
  qrCode: string
  /** QR image as a data: URL (fetched + re-encoded here so the renderer's
   *  CSP img-src never needs a third-party origin) */
  dataUrl: string
  expiresAt: number
}

export type IlinkLoginStatus = 'pending' | 'scanned' | 'success' | 'expired' | 'error'

export interface IlinkLoginPoll {
  status: IlinkLoginStatus
  botToken?: string
  botId?: string
  message?: string
}

export interface IlinkActivatePoll {
  /** The from_user_id of the first message the user sent to the bot */
  userId?: string
}

type NetFetch = typeof import('electron').net.fetch

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function readString(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function readNumber(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

/** Unwrap {data: {...}} envelopes and fail on nonzero ret/errcode */
function unwrap(payload: unknown, what: string): Record<string, unknown> {
  const root = isRecord(payload) ? payload : {}
  const data = isRecord(root.data) ? { ...root, ...root.data } : root
  const ret = readNumber(data, 'ret')
  const errcode = readNumber(data, 'errcode')
  if ((ret != null && ret !== 0) || (errcode != null && errcode !== 0)) {
    throw new Error(`${what} failed: ${readString(data, 'errmsg', 'message') || `ret=${ret ?? ''} errcode=${errcode ?? ''}`}`)
  }
  return data
}

async function getJson(
  fetcher: NetFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = QR_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const res = await fetcher(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return unwrap(await res.json(), url.slice(url.lastIndexOf('/') + 1))
}

async function postJson(
  fetcher: NetFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number = QR_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return unwrap(await res.json(), url.slice(url.lastIndexOf('/') + 1))
}

/** Auth headers every authenticated /ilink/bot call needs (mirrors ZCode) */
export function ilinkAuthHeaders(botToken: string): Record<string, string> {
  return {
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 4294967296)), 'utf8').toString('base64'),
  }
}

/** Normalize the platform's mixed numeric/string QR status values */
function normalizeQrStatus(v: unknown): IlinkLoginStatus {
  if (typeof v === 'number') {
    if (v === 0) return 'pending'
    if (v === 1) return 'scanned'
    if (v === 2) return 'success'
    return 'expired'
  }
  const s = typeof v === 'string' ? v.toLowerCase() : ''
  if (['confirmed', 'confirm', 'authorized', 'success', 'ok'].includes(s)) return 'success'
  if (['scaned', 'scanned', 'scan', 'confirmed_wait'].includes(s)) return 'scanned'
  if (['expired', 'timeout', 'cancel', 'cancelled', 'canceled'].includes(s)) return 'expired'
  if (['error', 'failed', 'fail'].includes(s)) return 'error'
  return 'pending'
}

/** Fetch a fresh login QR and encode its content string into a PNG data URL */
export async function ilinkBeginLogin(fetcher: NetFetch): Promise<IlinkQrSession> {
  const data = await getJson(fetcher, `${ILINK_BASE}${ILINK_PREFIX}/get_bot_qrcode?bot_type=3`, {
    'iLink-App-ClientVersion': '1',
  })
  const qrCode = readString(data, 'qrcode', 'qr_code')
  // The platform returns the string the QR must carry (a liteapp.weixin.qq.com
  // short link), never an image — render it ourselves
  const content = readString(data, 'qrcode_img_content', 'qrcode_url') || qrCode
  if (!qrCode || !content) throw new Error('WeChat login did not return a QR code')
  const expiresIn = readNumber(data, 'expires_in') ?? 300
  const dataUrl = await QRCode.toDataURL(content, { margin: 1, width: 320 })
  return { qrCode, dataUrl, expiresAt: Date.now() + expiresIn * 1000 }
}

/** Poll the login status of one QR code (server long-poll: holds ~30s when unscanned) */
export async function ilinkPollLogin(fetcher: NetFetch, qrCode: string): Promise<IlinkLoginPoll> {
  const data = await getJson(
    fetcher,
    `${ILINK_BASE}${ILINK_PREFIX}/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`,
    { 'iLink-App-ClientVersion': '1' },
    POLL_TIMEOUT_MS,
  )
  const status = normalizeQrStatus(data.status ?? data.qrcode_status ?? data.qr_status)
  if (status === 'success') {
    const botToken = readString(data, 'bot_token', 'token')
    if (!botToken) return { status: 'error', message: 'WeChat login succeeded but returned no bot_token' }
    return { status, botToken, botId: readString(data, 'ilink_bot_id', 'bot_id') || undefined }
  }
  if (status === 'error') return { status, message: readString(data, 'errmsg') || 'WeChat login failed' }
  return { status }
}

/**
 * One activation attempt: check for a first message from the user. The
 * renderer drives the polling loop; each call is a single getupdates round
 * with a fresh cursor (activation runs before any cursor exists).
 *
 * Response shape mirrors ZCode's parser: after unwrapping `data`, the
 * message list hides under one of msgs/messages/updates/items/list, each
 * item carrying the sender in from_user_id/from/from_user/fromUser/user/
 * user_id/userId (or nested from/sender objects with id/wxid). Items with
 * message_type 2 are the bot's OWN sends — never the activation message.
 */
export async function ilinkPollActivation(fetcher: NetFetch, botToken: string): Promise<IlinkActivatePoll> {
  const data = await postJson(
    fetcher,
    `${ILINK_BASE}${ILINK_PREFIX}/getupdates`,
    ilinkAuthHeaders(botToken),
    // base_info rides on EVERY /ilink/bot request in ZCode's client — omitting
    // it made getupdates come back with an empty message list
    { base_info: { channel_version: '2.0.0' }, get_updates_buf: '' },
    POLL_TIMEOUT_MS,
  )
  const containers: unknown[] = [
    data.msgs,
    data.messages,
    data.updates,
    data.items,
    data.list,
    data.item_list,
    data.msg_list,
    isRecord(data.msg) ? data.msg.item_list : undefined,
    isRecord(data.message) ? data.message.item_list : undefined,
  ]
  for (const list of containers) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (!isRecord(raw)) continue
      // The record may nest the payload under msg/message
      const inner = isRecord(raw.msg) ? raw.msg : isRecord(raw.message) ? raw.message : undefined
      const candidates = [raw, ...(inner ? [inner] : [])]
      for (const c of candidates) {
        // message_type 2 = the bot's own outgoing messages; never activation
        if (c.message_type === 2) continue
        const userId =
          readString(c, 'from_user_id', 'from', 'from_user', 'fromUser', 'user', 'user_id', 'userId') ||
          (isRecord(c.from) ? readString(c.from, 'id', 'wxid') : '') ||
          (isRecord(c.sender) ? readString(c.sender, 'id', 'wxid') : '')
        if (userId) return { userId }
      }
    }
  }
  return {}
}
