import { describe, expect, it } from 'vitest'
import { formatAgo, formatAgoShort, formatClock } from './format'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'

/**
 * Regression: alert rows used to print raw minutes forever, so an alert that had
 * been live for two months read "78776 分钟前". The label now steps up to hours
 * and days.
 */
describe('formatAgoShort', () => {
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  it('says "just now" below a minute and minutes below an hour', () => {
    expect(formatAgoShort(0, zhCN)).toBe('刚刚')
    expect(formatAgoShort(59_000, zhCN)).toBe('刚刚')
    expect(formatAgoShort(minute, zhCN)).toBe('1 分钟前')
    expect(formatAgoShort(59 * minute, zhCN)).toBe('59 分钟前')
  })

  it('steps up to hours and minutes at one hour', () => {
    expect(formatAgoShort(hour, zhCN)).toBe('1 小时 0 分钟前')
    expect(formatAgoShort(2 * hour + 5 * minute, zhCN)).toBe('2 小时 5 分钟前')
  })

  it('steps up to days and hours at one day', () => {
    expect(formatAgoShort(day, zhCN)).toBe('1 天 0 小时前')
    expect(formatAgoShort(78776 * minute, zhCN)).toBe('54 天 16 小时前')
  })

  it('formats the English ladder', () => {
    expect(formatAgoShort(2 * hour + 5 * minute, enUS)).toBe('2 h 5 min ago')
    expect(formatAgoShort(3 * day + 7 * hour, enUS)).toBe('3 d 7 h ago')
  })

  it('applies the same ladder to the "last updated" stamp', () => {
    const now = Date.now()
    expect(formatAgo(now - 30_000, now, zhCN)).toBe('30 秒前更新')
    expect(formatAgo(now - 5 * minute, now, zhCN)).toBe('5 分钟前更新')
    expect(formatAgo(now - (2 * hour + 5 * minute), now, zhCN)).toBe('2 小时 5 分钟前更新')
    expect(formatAgo(now - (3 * day + 7 * hour), now, zhCN)).toBe('3 天 7 小时前更新')
  })
})

describe('formatClock', () => {
  /** Local time on the day that is `dayOffset` days from "now", at hh:mm */
  const at = (now: Date, dayOffset: number, hours: number, minutes: number): number => {
    const d = new Date(now)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(hours, minutes, 0, 0)
    return d.getTime()
  }

  it('shows the zero-padded 24-hour clock for something that happened today', () => {
    const now = new Date(2026, 10, 22, 23, 30)
    expect(formatClock(at(now, 0, 23, 14), now.getTime())).toBe('23:14')
    expect(formatClock(at(now, 0, 9, 5), now.getTime())).toBe('09:05')
  })

  it('shows the calendar day for anything older, in both directions', () => {
    const now = new Date(2026, 10, 22, 23, 30)
    expect(formatClock(at(now, -1, 23, 14), now.getTime())).toBe('11-21')
    expect(formatClock(at(now, 1, 8, 0), now.getTime())).toBe('11-23')
  })
})
