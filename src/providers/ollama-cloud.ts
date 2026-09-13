import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * Ollama Cloud adapter.
 *
 * Ollama Cloud is subscription-based (Free/Pro/Max) and is NOT billed by
 * token, so there is no balance figure — the only usage surface is
 * `GET https://ollama.com/api/usage` (Bearer API key), which returns:
 *
 *   activity.cost / activity.period / activity.models  → recent spend (usually 0)
 *   limits.session.usage   → 5-hour rolling window, used RATIO 0..1
 *   limits.weekly.usage    → 7-day rolling window, used RATIO 0..1
 *
 * The API returns no cap and no reset timestamp. The reset schedule is fixed
 * and global (ollama/ollama#12532): the session window is 5h aligned to the
 * epoch, the weekly window is 7 days with a 4-day epoch offset — so the reset
 * times are computed locally from those constants.
 */

const BASE = 'https://ollama.com'
const SESSION_PERIOD_S = 18_000 // 5 hours
const WEEKLY_PERIOD_S = 604_800 // 7 days
const WEEKLY_EPOCH_OFFSET_S = 4 * 86_400

/** Next 5h-window boundary (epoch-aligned) */
function sessionResetAt(nowSec: number): number {
  return nowSec + (SESSION_PERIOD_S - (nowSec % SESSION_PERIOD_S))
}

/** Next weekly boundary (7-day period, 4-day epoch offset) */
function weeklyResetAt(nowSec: number): number {
  return nowSec + (WEEKLY_PERIOD_S - ((nowSec - WEEKLY_EPOCH_OFFSET_S) % WEEKLY_PERIOD_S))
}

interface UsageBody {
  activity?: { cost?: unknown; period?: unknown }
  limits?: {
    session?: { usage?: unknown }
    weekly?: { usage?: unknown }
  }
}

/** The API reports a 0..1 ratio; some payloads spell it as a percent already */
function ratio(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return undefined
  return n <= 1 ? n : n / 100
}

export const ollamaCloud: ProviderDef = {
  id: 'ollama-cloud',
  name: 'Ollama Cloud',
  accent: 'from-neutral-700 to-neutral-900',
  logo: 'ollama-avatar',
  tagline: (t) => t.providers.ollamaCloud.tagline,
  docsUrl: 'https://docs.ollama.com/cloud',
  keyUrl: 'https://ollama.com/settings/keys',
  buildRequest(key) {
    return {
      url: `${BASE}/api/usage`,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    }
  },
  async parseResponse(json, ctx) {
    const body = json as UsageBody
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const errs = t.providerErrors
    if (body == null || typeof body !== 'object') throw new Error(errs.badResponse)

    const limits = body.limits ?? {}
    const session = ratio(limits.session?.usage)
    const weekly = ratio(limits.weekly?.usage)
    if (session == null && weekly == null) throw new Error(errs.noWindows)

    const nowSec = Math.floor(Date.now() / 1000)
    const metrics: UsageMetric[] = []
    if (session != null) {
      metrics.push({
        id: 'ollama-session',
        label: t.windows.fiveHour,
        kind: 'percent',
        percent: Math.min(100, session * 100),
        resetsAt: sessionResetAt(nowSec) * 1000,
      })
    }
    if (weekly != null) {
      metrics.push({
        id: 'ollama-weekly',
        label: t.windows.weeklyPlan,
        kind: 'percent',
        percent: Math.min(100, weekly * 100),
        resetsAt: weeklyResetAt(nowSec) * 1000,
      })
    }

    // Subscription plans have no balance; surface the recent spend as context
    // when the API reports one (it is normally 0.00 on subscription plans).
    const cost = typeof body.activity?.cost === 'number' ? body.activity.cost : undefined
    if (cost != null) {
      metrics.push({
        id: 'ollama-activity-cost',
        label: t.provider.recentSpend,
        kind: 'balance',
        remaining: cost,
        unit: 'USD',
        detail: [],
      })
    }
    return metrics
  },
}
