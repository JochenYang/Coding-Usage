import type { Dict } from '../i18n/types'

/** Countdown text: "3 days 2 hours" / "in 2 h 15 m" / "in 8 min" / "resetting soon". */
export function formatCountdown(resetsAt: number | undefined, now: number, t: Dict): string {
  if (!resetsAt) return ''
  const diffMs = resetsAt - now
  if (diffMs <= 0) return t.time.countdownResetting
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return t.time.countdownWithin1Min
  if (min < 60) return t.time.countdownMinutes(min)
  const hours = Math.floor(min / 60)
  if (hours < 24) return t.time.countdownHoursMinutes(hours, min % 60)
  const days = Math.floor(hours / 24)
  return t.time.countdownDaysHours(days, hours % 24)
}

/** Amount: up to 2 decimal places, no thousands separator (balances are small). */
export function formatAmount(n: number, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  return n.toLocaleString(locale, { maximumFractionDigits: 2 })
}

/** Compact symbol for common display currencies; unknown codes render as-is. */
export function currencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case 'CNY':
      return '¥'
    case 'USD':
      return '$'
    case 'HKD':
      return 'HK$'
    case 'TWD':
      return 'NT$'
    default:
      return `${code} `
  }
}

/** Relative time: "x minutes ago" / "x 秒前更新". */
export function formatAgo(fetchedAt: number | undefined, now: number, t: Dict): string {
  if (!fetchedAt) return ''
  const sec = Math.max(0, Math.floor((now - fetchedAt) / 1000))
  if (sec < 60) return t.time.agoSeconds(sec)
  return t.time.agoMinutes(Math.floor(sec / 60))
}

/** Generic relative day offset: "今天到期" / "in N days" / "已过期 N 天". */
export function formatDaysFromNow(
  expiresAt: number,
  now: number,
  t: Dict,
): { primary: string; tone: 'foreground' | 'warning' | 'danger' } {
  const diffMs = expiresAt - now
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
  if (days > 30) return { primary: t.time.expiresInDays(days), tone: 'foreground' }
  if (days > 7) return { primary: t.time.expiresInDays(days), tone: 'foreground' }
  if (days > 0) return { primary: t.time.expiresInDays(days), tone: 'warning' }
  if (days === 0) return { primary: t.time.expiresToday, tone: 'warning' }
  return { primary: t.time.expiresOverdueDays(Math.abs(days)), tone: 'danger' }
}

/**
 * Shared compact number formatter used by the chart + KPI components:
 * >= 1e9 -> "17.5B", >= 1e6 -> "2.71M", >= 1e3 -> "345K", else integer.
 */
export function formatCompactValue(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trimZeros((value / 1e9).toFixed(2))}B`
  if (abs >= 1e6) return `${trimZeros((value / 1e6).toFixed(2))}M`
  if (abs >= 1e3) return `${Math.round(value / 1e3)}K`
  return `${Math.round(value)}`
}

/** Drop trailing zeros from a fixed-decimal string ("2.00" -> "2", "2.10" -> "2.1") */
function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}