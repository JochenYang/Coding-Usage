import type { Dict } from '../i18n/types'
import type { AlertItem } from './alerts'
import { currencySymbol, formatAmount, formatCompactValue } from './format'

/**
 * Shared alert text formatting. The same title/detail mapping feeds the
 * alerts page, the overview panel, and the webhook push — keep them in one
 * place so a wording change lands everywhere at once. Strings are produced
 * at call time through i18n, so locale switches stay live.
 */

/** Title text per alert kind */
export function alertTitle(alert: AlertItem, t: Dict): string {
  if (alert.kind === 'window-reset') return t.overview.alertWindowReset(alert.agentName)
  if (alert.kind === 'high-usage') return t.overview.alertHighUsage(alert.agentName, alert.pct ?? 0)
  return t.overview.alertLowBalance(alert.agentName)
}

/** Kind-specific detail line; null when the numeric payload is missing */
export function alertDetail(alert: AlertItem, t: Dict): string | null {
  if (alert.kind === 'window-reset' && alert.resetInMin != null) {
    return t.overview.alertResetSoon(alert.resetInMin)
  }
  if (alert.kind === 'high-usage' && alert.used != null && alert.total != null) {
    return t.overview.alertUsedDetail(formatCompactValue(alert.used), formatCompactValue(alert.total))
  }
  if (alert.kind === 'low-balance' && alert.balance != null && alert.currency != null) {
    return t.overview.alertBalanceDetail(`${currencySymbol(alert.currency)}${formatAmount(alert.balance)}`)
  }
  return null
}
