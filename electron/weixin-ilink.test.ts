import { describe, expect, it } from 'vitest'
import { ilinkAuthHeaders, ilinkBeginLogin, ilinkGetUpdates, ilinkPollActivation, ilinkPollLogin } from './weixin-ilink'

/**
 * The iLink platform client's parseable surface, driven through an injected
 * fetcher (the same `net.fetch` shape registerIpc binds). The long-poll hold
 * windows live on the server; what this pins is the response-shape tolerance
 * the module is named for: envelopes, container key aliases, sender field
 * aliases, cursor key aliases, and the bot's own sends never counting as the
 * activation message.
 */

type NetFetch = typeof import('electron').net.fetch

interface CapturedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A fetcher answering every call with one JSON payload, capturing requests */
function fetcher(payload: unknown, capture?: CapturedCall[], status = 200): NetFetch {
  return (async (url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(String(init?.body ?? '')) as Record<string, unknown>
    } catch {
      // body not JSON — recorded empty
    }
    capture?.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as NetFetch
}

describe('ilinkAuthHeaders', () => {
  it('authenticates as an ilink bot token bearer', () => {
    const headers = ilinkAuthHeaders('tok-1')
    expect(headers.AuthorizationType).toBe('ilink_bot_token')
    expect(headers.Authorization).toBe('Bearer tok-1')
    // The UIN is random per call; only its presence is contractual.
    expect(headers['X-WECHAT-UIN']).toBeTruthy()
  })
})

describe('ilinkGetUpdates', () => {
  it('sends base_info, the cursor and bot auth on every request', async () => {
    const calls: CapturedCall[] = []
    const result = await ilinkGetUpdates(fetcher({ ret: 0 }, calls), 'tok-1', 'CUR-9')
    expect(result).toEqual({})
    const call = calls[0]!
    expect(call.url).toContain('https://ilinkai.weixin.qq.com/ilink/bot/getupdates')
    expect(call.method).toBe('POST')
    expect(call.headers.Authorization).toBe('Bearer tok-1')
    expect(call.body).toEqual({
      base_info: { channel_version: '2.0.0' },
      get_updates_buf: 'CUR-9',
    })
  })

  it('fails loudly on ret -2 — the prepare-failed signal that triggers recover', async () => {
    await expect(
      ilinkGetUpdates(fetcher({ ret: -2, errmsg: 'prepare failed' }), 'tok-1', ''),
    ).rejects.toThrow('prepare failed')
  })

  it('fails loudly on a nonzero errcode with the platform message', async () => {
    await expect(
      ilinkGetUpdates(fetcher({ errcode: 42, errmsg: 'token dead' }), 'tok-1', ''),
    ).rejects.toThrow('token dead')
  })

  it('reports the HTTP status when the call does not reach the JSON layer', async () => {
    await expect(ilinkGetUpdates(fetcher({}, [], 500), 'tok-1', '')).rejects.toThrow('HTTP 500')
  })

  it('unwraps a {data: …} envelope and reads sender and cursor from it', async () => {
    const result = await ilinkGetUpdates(
      fetcher({
        ret: 0,
        data: {
          msgs: [{ from_user_id: 'user-1' }],
          get_updates_buf: 'ENV-NEXT',
        },
      }),
      'tok-1',
      '',
    )
    expect(result.userId).toBe('user-1')
    expect(result.nextBuf).toBe('ENV-NEXT')
  })

  it('reads the sender from every documented container and field spelling', async () => {
    const flat = await ilinkGetUpdates(
      fetcher({ ret: 0, msgs: [{ from_user_id: 'u1' }] }),
      'tok-1',
      '',
    )
    expect(flat.userId).toBe('u1')

    const items = await ilinkGetUpdates(
      fetcher({ ret: 0, items: [{ sender: { id: 's-9' } }] }),
      'tok-1',
      '',
    )
    expect(items.userId).toBe('s-9')

    const nested = await ilinkGetUpdates(
      fetcher({ ret: 0, msg: { item_list: [{ msg: { from: { wxid: 'wx-inner' } } }] } }),
      'tok-1',
      '',
    )
    expect(nested.userId).toBe('wx-inner')
  })

  it('never treats the bot’s own sends (message_type 2) as the activation message', async () => {
    const result = await ilinkGetUpdates(
      fetcher({
        ret: 0,
        msgs: [
          { message_type: 2, from_user_id: 'bot-self' },
          { from_user_id: 'user-1' },
        ],
      }),
      'tok-1',
      '',
    )
    expect(result.userId).toBe('user-1')
  })

  it('returns no user when the round carries no new messages — that is not failure', async () => {
    const result = await ilinkGetUpdates(fetcher({ ret: 0 }), 'tok-1', 'CUR-9')
    expect(result.userId).toBeUndefined()
    expect(result.nextBuf).toBeUndefined()
  })

  it('accepts the cursor under its documented aliases', async () => {
    const buf = await ilinkGetUpdates(fetcher({ ret: 0, buf: 'B-2' }), 'tok-1', '')
    expect(buf.nextBuf).toBe('B-2')
    const sync = await ilinkGetUpdates(fetcher({ ret: 0, syncKey: 'SYNC-1' }), 'tok-1', '')
    expect(sync.nextBuf).toBe('SYNC-1')
  })
})

describe('ilinkPollLogin', () => {
  it('normalises the numeric status codes', async () => {
    expect((await ilinkPollLogin(fetcher({ ret: 0, status: 0 }), 'Q')).status).toBe('pending')
    expect((await ilinkPollLogin(fetcher({ ret: 0, status: 1 }), 'Q')).status).toBe('scanned')
    expect((await ilinkPollLogin(fetcher({ ret: 0, status: 3 }), 'Q')).status).toBe('expired')
  })

  it('returns the bot token and id on numeric success', async () => {
    const poll = await ilinkPollLogin(
      fetcher({ ret: 0, status: 2, bot_token: 'bt-1', ilink_bot_id: 'bot-9' }),
      'Q',
    )
    expect(poll).toEqual({ status: 'success', botToken: 'bt-1', botId: 'bot-9' })
  })

  it('normalises the string status spellings', async () => {
    // A string success still requires the bot_token — see the next case.
    const confirmed = await ilinkPollLogin(
      fetcher({ ret: 0, status: 'confirmed', bot_token: 'bt-2' }),
      'Q',
    )
    expect(confirmed.status).toBe('success')
    expect(confirmed.botToken).toBe('bt-2')
    expect((await ilinkPollLogin(fetcher({ ret: 0, status: 'scaned' }), 'Q')).status).toBe('scanned')
    expect((await ilinkPollLogin(fetcher({ ret: 0, status: 'cancelled' }), 'Q')).status).toBe('expired')
    expect((await ilinkPollLogin(fetcher({ ret: 0, status: 'nonsense' }), 'Q')).status).toBe('pending')
  })

  it('reports an error when a string success carries no usable token', async () => {
    const poll = await ilinkPollLogin(fetcher({ ret: 0, status: 'success' }), 'Q')
    expect(poll.status).toBe('error')
    expect(poll.message).toContain('bot_token')
  })

  it('surfaces the platform message on a string failure', async () => {
    const poll = await ilinkPollLogin(fetcher({ ret: 0, status: 'failed', errmsg: 'denied' }), 'Q')
    expect(poll.status).toBe('error')
    expect(poll.message).toBe('denied')
  })
})

describe('ilinkBeginLogin', () => {
  it('renders the payload string into a QR data URL instead of trusting a URL field', async () => {
    const session = await ilinkBeginLogin(
      fetcher({ ret: 0, qrcode: 'QRCODE-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/x', expires_in: 120 }),
    )
    expect(session.qrCode).toBe('QRCODE-1')
    expect(session.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(Math.abs(session.expiresAt - (Date.now() + 120_000))).toBeLessThan(5000)
  })

  it('falls back to the qrcode value when no payload string is provided', async () => {
    const session = await ilinkBeginLogin(fetcher({ ret: 0, qrcode: 'QRCODE-X' }))
    expect(session.qrCode).toBe('QRCODE-X')
    expect(session.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('fails closed when the platform returns no code at all', async () => {
    await expect(ilinkBeginLogin(fetcher({ ret: 0 }))).rejects.toThrow('did not return a QR code')
  })
})

describe('ilinkPollActivation', () => {
  it('issues one getupdates round with an empty cursor', async () => {
    const calls: CapturedCall[] = []
    const poll = await ilinkPollActivation(fetcher({ ret: 0, msgs: [{ from_user_id: 'first-user' }] }, calls), 'tok-1')
    expect(poll.userId).toBe('first-user')
    expect(calls[0]!.body.get_updates_buf).toBe('')
  })

  it('keeps polling honest when the user has not messaged the bot yet', async () => {
    const poll = await ilinkPollActivation(fetcher({ ret: 0 }), 'tok-1')
    expect(poll).toEqual({})
  })
})
