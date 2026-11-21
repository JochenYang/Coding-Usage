import { describe, expect, it } from 'vitest'
import { buildChannelRequest, channelErrorDetail, isChannelSuccess } from './webhook-channels'

/**
 * Pure channel adapters (webhook-channels.ts). webhook-send.ts itself imports
 * Electron's net, so the testable contract lives here: the exact request shape
 * per platform (a wrong URL or payload is an outward-facing side effect) and
 * the per-platform success semantics, including the weixin fail-closed ack
 * where HTTP 200 without a delivery id is the platform's silent-drop shape.
 */

/** Body of a built request parsed back into an object */
function bodyOf(request: { body: string }): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>
}

describe('buildChannelRequest', () => {
  it('builds the wecom markdown payload and requires https', () => {
    const ok = buildChannelRequest('wecom', { url: 'https://qyapi.weixin.qq.com/hook' }, 'Title', 'line1\nline2')
    expect(ok?.url).toBe('https://qyapi.weixin.qq.com/hook')
    expect(bodyOf(ok ?? { body: '' })).toEqual({
      msgtype: 'markdown',
      markdown: { content: '**Title**\n> line1\n> line2' },
    })
    // Quoted markdown lines are capped at 3800 chars of content
    const long = buildChannelRequest('wecom', { url: 'https://x.example/hook' }, 'T', 'x'.repeat(5000))
    const content = ((bodyOf(long ?? { body: '' }).markdown as Record<string, unknown>).content as string) ?? ''
    expect(content).toHaveLength(3800)
    expect(content.startsWith('**T**\n> xxx')).toBe(true)

    expect(buildChannelRequest('wecom', { url: 'http://insecure.example/hook' }, 'T', 'B')).toBeNull()
    expect(buildChannelRequest('wecom', { url: '' }, 'T', 'B')).toBeNull()
  })

  it('builds the feishu text payload and requires https', () => {
    const ok = buildChannelRequest('feishu', { url: 'https://open.feishu.cn/hook' }, 'Title', 'Body')
    expect(bodyOf(ok ?? { body: '' })).toEqual({ msg_type: 'text', content: { text: 'Title\nBody' } })
    expect(buildChannelRequest('feishu', { url: 'http://open.feishu.cn/hook' }, 'T', 'B')).toBeNull()
  })

  it('builds the telegram sendMessage URL from the token and validates the shape', () => {
    const ok = buildChannelRequest('telegram', { token: '123456:ABC-def', chatId: ' 42 ' }, 'Title', 'Body')
    expect(ok?.url).toBe('https://api.telegram.org/bot123456:ABC-def/sendMessage')
    expect(bodyOf(ok ?? { body: '' })).toEqual({ chat_id: '42', text: 'Title\nBody' })
    // Long alerts are capped at 4000 chars of text
    const long = buildChannelRequest('telegram', { token: '123456:ABC-def', chatId: '42' }, 'T', 'y'.repeat(5000))
    expect(((bodyOf(long ?? { body: '' }).text as string) ?? '').length).toBe(4000)

    // Garbage tokens and missing chat ids fail closed
    expect(buildChannelRequest('telegram', { token: 'not-a-bot-token', chatId: '42' }, 'T', 'B')).toBeNull()
    expect(buildChannelRequest('telegram', { token: '123456:ABC-def' }, 'T', 'B')).toBeNull()
  })

  it('builds the weixin iLink request with its bearer headers and CRLF text', () => {
    const ok = buildChannelRequest('weixin', { token: 'ilink-token', userId: 'u-1' }, 'Title', 'a\r\nb\nc\rd')
    expect(ok?.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage')
    expect(ok?.headers).toMatchObject({
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer ilink-token',
    })
    expect(String((ok?.headers ?? {})['X-WECHAT-UIN'])).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    const parsed = bodyOf(ok ?? { body: '' }) as {
      msg: { from_user_id: string; to_user_id: string; client_id: string; message_type: number; message_state: number; item_list: Array<{ type: number; text_item: { text: string } }> }
    }
    expect(parsed.msg.from_user_id).toBe('u-1')
    expect(parsed.msg.to_user_id).toBe('u-1')
    expect(parsed.msg.client_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(parsed.msg.message_type).toBe(2)
    expect(parsed.msg.message_state).toBe(2)
    expect(parsed.msg.item_list[0]?.type).toBe(1)
    // Every newline becomes CRLF for the iLink text item
    expect(parsed.msg.item_list[0]?.text_item?.text).toBe('Title\r\na\r\nb\r\nc\r\nd')
    // The text item is capped at 3500 chars
    const long = buildChannelRequest('weixin', { token: 't', userId: 'u' }, 'T', 'z'.repeat(5000))
    const text = ((long && ((bodyOf(long).msg as Record<string, unknown>).item_list as Array<{ text_item: { text: string } }>)[0]?.text_item?.text) ?? '')
    expect(text).toHaveLength(3500)

    expect(buildChannelRequest('weixin', { token: 't' }, 'T', 'B')).toBeNull()
    expect(buildChannelRequest('weixin', { userId: 'u' }, 'T', 'B')).toBeNull()
  })
})

describe('isChannelSuccess', () => {
  it('requires a zero errcode for wecom', () => {
    expect(isChannelSuccess('wecom', true, { errcode: 0 })).toBe(true)
    expect(isChannelSuccess('wecom', true, { errcode: 9499, errmsg: 'api unauthorized' })).toBe(false)
    expect(isChannelSuccess('wecom', true, {})).toBe(false)
    expect(isChannelSuccess('wecom', false, { errcode: 0 })).toBe(false)
  })

  it('accepts both feishu ack spellings', () => {
    expect(isChannelSuccess('feishu', true, { code: 0 })).toBe(true)
    expect(isChannelSuccess('feishu', true, { StatusCode: 0 })).toBe(true)
    expect(isChannelSuccess('feishu', true, { code: 99991663, msg: 'app not exists' })).toBe(false)
    expect(isChannelSuccess('feishu', true, { code: '0' })).toBe(false)
  })

  it('requires ok:true for telegram and an unparseable body proves nothing', () => {
    expect(isChannelSuccess('telegram', true, { ok: true })).toBe(true)
    expect(isChannelSuccess('telegram', true, { ok: false })).toBe(false)
    expect(isChannelSuccess('telegram', true, {})).toBe(false)
    // A 200 with a gateway HTML page is not a delivery on any channel
    expect(isChannelSuccess('telegram', true, null)).toBe(false)
    expect(isChannelSuccess('weixin', true, 'text')).toBe(false)
  })

  it('fails weixin closed without a delivery ack even when the code is zero', () => {
    expect(isChannelSuccess('weixin', true, { ret: 0 })).toBe(false)
    expect(isChannelSuccess('weixin', true, { ret: 0, message_id: 'm1' })).toBe(true)
    expect(isChannelSuccess('weixin', true, { ret: '0', msg_id: 123 })).toBe(true)
    expect(isChannelSuccess('weixin', true, { ret: -2, errmsg: 'prepare failed' })).toBe(false)
    expect(isChannelSuccess('weixin', true, {})).toBe(false)
    // The ack id may sit under the known envelopes
    expect(isChannelSuccess('weixin', true, { data: { ret: 0, message_id: 'm2' } })).toBe(true)
    expect(isChannelSuccess('weixin', true, { result: { messageId: 'm3' } })).toBe(true)
    expect(isChannelSuccess('weixin', true, { data: { ret: -2 } })).toBe(false)
  })
})

describe('channelErrorDetail', () => {
  it('surfaces the platform code and message', () => {
    expect(channelErrorDetail('wecom', 200, { errcode: 9499, errmsg: 'api unauthorized' })).toBe('wecom-9499: api unauthorized')
    expect(channelErrorDetail('feishu', 200, { code: 99991663, msg: 'app not exists' })).toBe('feishu-99991663: app not exists')
  })

  it('reports the weixin silent-drop shape instead of a bare status', () => {
    expect(channelErrorDetail('weixin', 200, { ret: 0 })).toBe('weixin-noack')
    expect(channelErrorDetail('weixin', 200, {})).toBe('weixin-noack')
    expect(channelErrorDetail('weixin', 200, { ret: -2, errmsg: 'prepare failed' })).toBe('weixin--2: prepare failed')
    // A numeric code without a message falls back to its labeled form
    expect(channelErrorDetail('weixin', 200, { ret: -2 })).toBe('weixin-ret-2')
    // A numeric string keeps its raw text
    expect(channelErrorDetail('weixin', 200, { ret: '-2' })).toBe('weixin--2')
  })

  it('reads a nested platform message and falls back to the HTTP status', () => {
    expect(channelErrorDetail('weixin', 200, { data: { ret: 1001, errmsg: 'session gone' } })).toBe('weixin-1001: session gone')
    expect(channelErrorDetail('telegram', 502, null)).toBe('HTTP 502')
    expect(channelErrorDetail('telegram', 502, 'html')).toBe('HTTP 502')
  })
})
