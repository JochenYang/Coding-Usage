import { describe, expect, it } from 'vitest'
import { parseCurl } from './pasted-requests'

const CODING_CURL = `curl 'https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2' \\
  -H 'accept: application/json' \\
  -H 'cookie: cna=abc; login_aliyunid_pk=42' \\
  -H 'x-evil: nope' \\
  --data-raw 'params=%7B%7D&region=cn-beijing&sec_token=tok'`

describe('parseCurl', () => {
  it('accepts a multiline coding-plan request and keeps only console headers', () => {
    const parsed = parseCurl(CODING_CURL)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.target).toBe('alibaba')
    expect(parsed.request.method).toBe('POST')
    expect(parsed.request.headers.cookie).toContain('login_aliyunid_pk')
    expect(parsed.request.headers.evil).toBeUndefined()
    expect(parsed.request.body).toContain('sec_token=tok')
  })

  it('routes by console host and api', () => {
    const qwen = parseCurl(
      `curl 'https://cs-data.qwencloud.com/data/api.json?api=zeldaHttp.apikeyMgr' -H 'cookie: a=b'`,
    )
    expect(qwen.ok && qwen.target).toBe('qwen')

    const token = parseCurl(
      `curl 'https://bailian-cs.console.aliyun.com/data/api.json?api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage' -H 'cookie: a=b'`,
    )
    expect(token.ok && token.target).toBe('alitoken')
  })

  it('refuses anything that is not an allowlisted https console', () => {
    expect(parseCurl(`curl 'http://bailian.console.aliyun.com/x' -H 'cookie: a=b'`)).toEqual({
      ok: false,
      reason: 'not-https',
    })
    expect(parseCurl(`curl 'https://evil.example/x' -H 'cookie: a=b'`)).toEqual({
      ok: false,
      reason: 'host-not-allowed',
    })
    expect(parseCurl(`curl -H 'cookie: a=b'`)).toEqual({ ok: false, reason: 'no-url' })
    expect(parseCurl(`curl 'https://bailian-cs.console.aliyun.com/x'`)).toEqual({
      ok: false,
      reason: 'no-cookie',
    })
    expect(parseCurl('')).toEqual({ ok: false, reason: 'empty' })
  })

  it('drops a header value carrying a line break', () => {
    // A real CRLF cannot be quoted by the tokenizer, so the value is either
    // truncated or the request is refused; it must never split the header.
    const crlf = String.fromCharCode(13, 10)
    const parsed = parseCurl(
      `curl 'https://bailian-cs.console.aliyun.com/data/api.json?api=codingPlan' -H 'cookie: a=b${crlf}X-Injected: 1'`,
    )
    if (parsed.ok) {
      expect(parsed.request.headers.cookie).not.toContain('X-Injected')
      expect(Object.keys(parsed.request.headers)).not.toContain('x-injected')
    } else {
      expect(parsed.reason).toBe('no-cookie')
    }
  })
})
