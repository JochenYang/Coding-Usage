import { describe, expect, it } from 'vitest'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { AlertItem } from './alerts'
import { alertDetail, alertTitle } from './alert-text'

/**
 * Behavior lock for the alert wording that the subscription windows added:
 * the window name tells two windows of one card apart, an exhausted window
 * says when it recovers instead of quoting used/total, and the restored
 * announcement reads as a one-liner.
 */

const NOW = Date.parse('2026-11-28T12:00:00Z')
const HOUR = 3_600_000

function alert(overrides: Partial<AlertItem>): AlertItem {
  return {
    id: 'claude:high-usage:fiveHour',
    level: 'warning',
    accountKey: 'claude',
    agentName: 'Claude Code',
    kind: 'high-usage',
    pct: 95,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    read: false,
    ...overrides,
  }
}

describe('alertTitle with a window label', () => {
  it('names the window when the source has one and falls back to the generic wording otherwise', () => {
    expect(alertTitle(alert({ windowLabel: '5 小时窗口' }), zhCN)).toBe('Claude Code - 5 小时窗口额度使用 95%')
    expect(alertTitle(alert({}), zhCN)).toBe('Claude Code - 额度使用 95%')
    expect(alertTitle(alert({ windowLabel: 'Weekly window' }), enUS)).toBe('Claude Code - Weekly window quota 95% used')
  })

  it('titles the restored announcement', () => {
    const restored = alert({ id: 'r', kind: 'window-restored', level: 'info', windowLabel: '每周窗口' })
    expect(alertTitle(restored, zhCN)).toBe('Claude Code - 每周窗口已恢复')
    expect(alertTitle({ ...restored, windowLabel: undefined }, enUS)).toBe('Claude Code - quota restored')
  })
})

describe('alertDetail for an exhausted window', () => {
  it('gives the recovery countdown instead of used/total', () => {
    const exhausted = alert({ level: 'danger', pct: 100, used: 500, total: 500, resetsAt: NOW + 2 * HOUR })
    expect(alertDetail(exhausted, zhCN, NOW)).toBe('已用完，2 小时 0 分后重置')
    expect(alertDetail(exhausted, enUS, NOW)).toBe('Exhausted, restores in 2 h 0 m')
  })

  it('keeps used/total below 100% even when a reset time is present', () => {
    const high = alert({ pct: 95, used: 475, total: 500, resetsAt: NOW + 2 * HOUR })
    expect(alertDetail(high, zhCN, NOW)).toBe('475 / 500 tokens 已使用')
  })

  it('has no detail for an exhausted window without a reset time', () => {
    expect(alertDetail(alert({ pct: 100 }), zhCN, NOW)).toBeNull()
  })

  it('drops the countdown once the reset point has passed (a resolved-history row)', () => {
    const past = alert({ level: 'danger', pct: 100, used: 500, total: 500, resetsAt: NOW - HOUR })
    expect(alertDetail(past, zhCN, NOW)).toBe('500 / 500 tokens 已使用')
    expect(alertDetail({ ...past, used: undefined, total: undefined }, zhCN, NOW)).toBeNull()
  })
})
