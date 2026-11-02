import { describe, expect, it } from 'vitest'
import { formatAgo, formatAgoShort } from './format'
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
