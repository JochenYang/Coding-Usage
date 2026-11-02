import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * GitHub Copilot plan quota.
 *
 * The credential is the Copilot OAuth token the editor itself stores
 * (`%LOCALAPPDATA%\github-copilot\hosts.json` → `github.com.oauth_token`, a
 * `gho_…` value), pasted as this account's key. The internal endpoint expects
 * an editor identity, so the same header trio the Copilot extension sends is
 * reproduced here.
 *
 * `quota_snapshots.*.percent_remaining` is REMAINING; this app renders used
 * percentages everywhere, so it is inverted exactly once, here.
 */

const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user'

interface CopilotBody {
  copilot_plan?: unknown
  quota_reset_date?: unknown
  quota_snapshots?: {
    premium_interactions?: { percent_remaining?: unknown; remaining?: unknown; entitlement?: unknown }
    chat?: { percent_remaining?: unknown }
  }
}

function remaining(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function isoToMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const copilot: ProviderDef = {
  id: 'copilot',
  name: 'GitHub Copilot',
  accent: 'from-slate-600 to-slate-800',
  logo: 'copilot-color',
  tagline: (t) => t.providers.copilot.tagline,
  docsUrl: 'https://docs.github.com/copilot/managing-copilot/monitoring-usage-and-entitlements',
  keyUrl: 'https://github.com/settings/copilot',
  buildRequest(key) {
    return {
      url: COPILOT_USER_URL,
      headers: {
        Authorization: `token ${key.trim()}`,
        'Editor-Version': 'vscode/1.96.2',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'X-Github-Api-Version': '2025-04-01',
        Accept: 'application/json',
      },
    }
  },
  async parseResponse(json, ctx) {
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const errs = t.providerErrors
    const body = json as CopilotBody
    if (!body || typeof body !== 'object') throw new Error(errs.badResponse)

    const resetsAt = isoToMs(body.quota_reset_date)
    const metrics: UsageMetric[] = []
    const windows: Array<[string, string, unknown]> = [
      ['copilot-premium', t.windows.copilotPremium, body.quota_snapshots?.premium_interactions?.percent_remaining],
      ['copilot-chat', t.windows.copilotChat, body.quota_snapshots?.chat?.percent_remaining],
    ]
    for (const [id, label, raw] of windows) {
      const left = remaining(raw)
      if (left == null) continue
      metrics.push({ id, label, kind: 'percent', percent: 100 - left, resetsAt })
    }
    if (metrics.length === 0) throw new Error(errs.noWindows)
    return metrics
  },
}
