import type { Dict } from '../i18n/types'
import type { AlertItem } from './alerts'
import { currencySymbol, formatAmount, formatCompactValue, formatCountdown } from './format'

/**
 * Shared alert text formatting. The same title/detail mapping feeds the
 * alerts page, the overview panel, and the webhook push — keep them in one
 * place so a wording change lands everywhere at once. Strings are produced
 * at call time through i18n, so locale switches stay live.
 */

/** Title text per alert kind */
export function alertTitle(alert: AlertItem, t: Dict): string {
  if (alert.kind === 'window-reset') return t.overview.alertWindowReset(alert.agentName, alert.windowLabel)
  if (alert.kind === 'window-restored') return t.overview.alertWindowRestored(alert.agentName, alert.windowLabel)
  if (alert.kind === 'high-usage') {
    return t.overview.alertHighUsage(alert.agentName, alert.pct ?? 0, alert.windowLabel)
  }
  return t.overview.alertLowBalance(alert.agentName)
}

/**
 * Kind-specific detail line; null when the numeric payload is missing.
 * `now` is the clock the recovery countdown is measured against — callers
 * that already tick (the alerts page, the overview panel) pass theirs so the
 * text moves with their re-render; the rest take the wall clock.
 */
export function alertDetail(alert: AlertItem, t: Dict, now: number = Date.now()): string | null {
  if (alert.kind === 'window-reset' && alert.resetInMin != null) {
    return t.overview.alertResetSoon(alert.resetInMin)
  }
  if (alert.kind === 'high-usage') {
    // An exhausted window says when it comes back: that is the only number
    // the user still needs. Only while the reset is still ahead — a row kept
    // as resolved history after its reset would otherwise read "exhausted,
    // resetting soon" for as long as it is retained. Below 100% (or past the
    // reset) the used/total figures stay the detail when the source has them.
    if ((alert.pct ?? 0) >= 100 && alert.resetsAt != null && alert.resetsAt > now) {
      return t.overview.alertExhaustedDetail(formatCountdown(alert.resetsAt, now, t))
    }
    if (alert.used != null && alert.total != null) {
      return t.overview.alertUsedDetail(formatCompactValue(alert.used), formatCompactValue(alert.total))
    }
  }
  if (alert.kind === 'low-balance' && alert.balance != null && alert.currency != null) {
    return t.overview.alertBalanceDetail(`${currencySymbol(alert.currency)}${formatAmount(alert.balance)}`)
  }
  return null
}
