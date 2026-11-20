import { describe, expect, it } from 'vitest'
import { hasConsoleTicket } from './alibaba-connect'

/**
 * The ticket rule per console family. It is what decides whether the sign-in
 * window may close, so a wrong rule either closes the window mid-login or never
 * closes it at all. The Electron half of this module needs a running app and is
 * covered by the manual sign-in flow.
 */
describe('console session detection', () => {
  it('needs the ticket and an account cookie on the Alibaba consoles', () => {
    expect(hasConsoleTicket([{ name: 'login_aliyunid_ticket' }], 'coding')).toBe(false)
    expect(hasConsoleTicket([{ name: 'login_aliyunid_pk' }], 'coding')).toBe(false)
    expect(
      hasConsoleTicket([{ name: 'cna' }, { name: 'login_aliyunid_ticket' }, { name: 'login_aliyunid_pk' }], 'coding'),
    ).toBe(true)
    expect(
      hasConsoleTicket([{ name: 'cna' }, { name: 'login_aliyunid_ticket' }, { name: 'login_aliyunid_pk' }], 'token'),
    ).toBe(true)
  })

  it('accepts any of the three account cookie spellings', () => {
    for (const account of ['login_aliyunid_pk', 'login_current_pk', 'login_aliyunid']) {
      expect(hasConsoleTicket([{ name: 'login_aliyunid_ticket' }, { name: account }], 'coding')).toBe(true)
    }
  })

  it('treats any ticket as a Qwen Cloud session, with or without an account cookie', () => {
    for (const ticket of ['login_aliyunid_ticket', 'login_qwencloud_ticket', 'qwen_sso_ticket']) {
      expect(hasConsoleTicket([{ name: ticket }], 'qwen')).toBe(true)
    }
    expect(hasConsoleTicket([{ name: 'cna' }, { name: 'login_aliyunid_pk' }], 'qwen')).toBe(false)
  })

  it('is false for an empty jar', () => {
    expect(hasConsoleTicket([], 'coding')).toBe(false)
    expect(hasConsoleTicket([], 'qwen')).toBe(false)
  })
})
