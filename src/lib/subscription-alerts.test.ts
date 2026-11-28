import { describe, expect, it } from 'vitest'
import { zhCN } from '../i18n/dict.zh-CN'
import { SNAPSHOT_MAX_AGE_MS, subscriptionAlertSources } from './subscription-alerts'

/**
 * Behavior lock for the subscription-card alert input: every card's own
 * parser feeds the alert engine, windows come out as USED percentages with
 * localized labels, and the three Antigravity slots collapse into one
 * source. Stale, unavailable, disabled and unsupported cards contribute
 * nothing.
 */

const NOW = Date.parse('2026-11-28T12:00:00Z')
const HOUR = 3_600_000
const RESET_SOON = NOW + 2 * HOUR

const fresh = (body: unknown, at = NOW - 60_000) => ({ at, result: { available: true, body: JSON.stringify(body) } })

describe('subscriptionAlertSources', () => {
  it('reads a multi-window card through its own parser and names windows in the active locale', () => {
    const sources = subscriptionAlertSources(
      {
        claude: fresh({
          five_hour: { utilization: 12, resets_at: '2026-11-28T14:00:00Z' },
          seven_day: { utilization: 95, resets_at: '2026-12-01T00:00:00Z' },
          limits: [{ kind: 'model', percent: 100, resets_at: '2026-11-29T00:00:00Z', scope: { model: { display_name: 'Opus' } } }],
        }),
      },
      new Set(['claude']),
      zhCN,
      NOW,
    )
    expect(sources).toHaveLength(1)
    const source = sources[0]
    expect(source.key).toBe('claude')
    expect(source.agentName).toBe('Claude Code')
    expect(source.metrics.map((m) => [m.id, m.label, m.percent, m.resetsAt])).toEqual([
      ['fiveHour', '5 小时窗口', 12, Date.parse('2026-11-28T14:00:00Z')],
      ['sevenDay', '每周窗口', 95, Date.parse('2026-12-01T00:00:00Z')],
      // Model-scoped allowances have no id: the server label is their identity
      ['scoped-Opus', 'Opus', 100, Date.parse('2026-11-29T00:00:00Z')],
    ])
  })

  it('labels Codex windows from their length since the endpoint gives no id', () => {
    const sources = subscriptionAlertSources(
      {
        codex: fresh({
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: Math.floor(RESET_SOON / 1000) },
            secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: Math.floor(RESET_SOON / 1000) },
          },
          credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: null },
        }),
      },
      new Set(['codex']),
      zhCN,
      NOW,
    )
    expect(sources[0]?.metrics.map((m) => [m.id, m.label, m.percent])).toEqual([
      ['primary', zhCN.windows.rolling, 100],
      ['secondary', zhCN.windows.weekly, 10],
    ])
  })

  it('collapses the three Antigravity slots into one source from the freshest reading, inverting remaining to used', () => {
    const older = fresh(
      { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'g-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-12-01T00:00:00Z' }] }] },
      NOW - 2 * HOUR,
    )
    const newer = fresh({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'g-weekly', window: 'weekly', remainingFraction: 0.05, resetTime: '2026-12-01T00:00:00Z' },
            { bucketId: 'g-5h', window: '5h', remainingFraction: 1 },
          ],
        },
      ],
    })
    const sources = subscriptionAlertSources(
      { 'antigravity-ide': older, antigravity: newer },
      new Set(['antigravity-ide', 'antigravity', 'antigravity-cli']),
      zhCN,
      NOW,
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]?.key).toBe('antigravity')
    expect(sources[0]?.agentName).toBe('Antigravity')
    expect(sources[0]?.metrics.map((m) => [m.id, m.label, m.percent])).toEqual([
      ['gemini.g-weekly', `${zhCN.antigravityQuota.groupGemini} · ${zhCN.antigravityQuota.windowWeekly}`, 95],
      ['gemini.g-5h', `${zhCN.antigravityQuota.groupGemini} · ${zhCN.antigravityQuota.windowFiveHour}`, 0],
    ])
  })

  it('labels local-plan windows from the shared windows table and leaves resetsAt out when the probe has none', () => {
    const sources = subscriptionAlertSources(
      {
        cline: fresh({
          plan: 'free',
          windows: [
            { id: 'clineFiveHour', percent: 42, resetsAt: RESET_SOON },
            { id: 'clineWeekly', percent: 7, resetsAt: null },
          ],
        }),
      },
      new Set(['cline']),
      zhCN,
      NOW,
    )
    expect(sources[0]?.metrics).toEqual([
      { id: 'clineFiveHour', label: zhCN.windows.clineFiveHour, kind: 'percent', percent: 42, resetsAt: RESET_SOON },
      { id: 'clineWeekly', label: zhCN.windows.clineWeekly, kind: 'percent', percent: 7 },
    ])
  })

  it('skips a snapshot older than the age limit, an unavailable probe and a disabled card', () => {
    const sources = subscriptionAlertSources(
      {
        claude: fresh({ five_hour: { utilization: 100 } }, NOW - SNAPSHOT_MAX_AGE_MS - 1),
        codex: { at: NOW, result: { available: false, reason: 'no-auth-file' } },
        gemini: fresh({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0 }] }),
      },
      new Set(['claude', 'codex']),
      zhCN,
      NOW,
    )
    expect(sources).toEqual([])
  })

  it('never speaks for a disabled Antigravity slot, even when it holds the freshest reading', () => {
    // The IDE keeps its own login, so its slot can be another account entirely;
    // a disabled card's reading must not override the enabled app card's.
    const body = (remaining: number) =>
      JSON.stringify({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'g-weekly', window: 'weekly', remainingFraction: remaining, resetTime: '2026-12-01T00:00:00Z' }],
          },
        ],
      })
    const sources = subscriptionAlertSources(
      {
        'antigravity-ide': { at: NOW, result: { available: true, body: body(0.05) } },
        antigravity: { at: NOW - 2 * HOUR, result: { available: true, body: body(0.9) } },
      },
      new Set(['antigravity']),
      zhCN,
      NOW,
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]?.metrics[0]?.percent).toBe(10)
  })

  it('skips a card that reports no reset time (qoder) rather than half-wiring it', () => {
    const sources = subscriptionAlertSources(
      { qoder: fresh({ percent: 95, used: 95, total: 100 }) },
      new Set(['qoder']),
      zhCN,
      NOW,
    )
    expect(sources).toEqual([])
  })

  it('does not mutate the caller arrays through the engine (source list is rebuilt per call)', () => {
    const snapshot = { claude: fresh({ five_hour: { utilization: 50 } }) }
    const enabled = new Set(['claude'])
    const first = subscriptionAlertSources(snapshot, enabled, zhCN, NOW)
    const second = subscriptionAlertSources(snapshot, enabled, zhCN, NOW)
    expect(first).not.toBe(second)
    expect(first[0]?.metrics).not.toBe(second[0]?.metrics)
  })
})
