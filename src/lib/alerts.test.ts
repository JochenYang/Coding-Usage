import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderDef, ProviderResult } from '../types'
import type { Section } from './sections'
import {
  DEFAULT_ALERT_THRESHOLDS,
  deriveAlerts,
  loadAlerts,
  saveAlerts,
  restoredAlertId,
  unreadCount,
  type AlertItem,
  type AlertSource,
} from './alerts'

/**
 * Behavior lock for the P9 alert-retention semantics: the 48h window for a
 * resolved alert counts from lastSeenAt (the last derive round that saw the
 * condition live), NOT from firstSeenAt. A long-lived alert must stay readable
 * as dimmed history after it clears, and an alert quiet for more than 48h must
 * disappear — while still-live alerts never age out regardless of age.
 */

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-21T12:00:00Z')
const ALERT_ID = 'deepseek-0:high-usage:m1'

beforeEach(() => {
  // Node test environment has no localStorage; deriveAlerts persists nothing on
  // its own, the caller does — a Map-backed stub is the whole surface it needs.
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    key: (index: number) => [...map.keys()][index] ?? null,
  })
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A minimal section fixture exposing only what deriveAlerts reads */
function sections(): Section[] {
  return [
    {
      def: { name: 'DeepSeek' } as unknown as ProviderDef,
      cards: [
        {
          def: {} as unknown as ProviderDef,
          cfg: { enabled: true, apiKey: 'k', label: 'Primary' },
          index: 0,
          key: 'deepseek-0',
        },
      ],
    },
  ]
}

/** Current fetch result: highUsagePct default 90, so 95 is live and 50 is clear */
function results(percent: number, status: 'ok' | 'loading' | 'error' = 'ok'): Record<string, ProviderResult> {
  return {
    'deepseek-0':
      status === 'ok'
        ? { status: 'ok', metrics: [{ id: 'm1', label: 'Plan', kind: 'percent', percent }] }
        : { status },
  }
}

function storedAlert(overrides: Partial<AlertItem> & { firstSeenAt: number; lastSeenAt?: number }): AlertItem {
  return {
    id: ALERT_ID,
    level: 'warning',
    accountKey: 'deepseek-0',
    agentName: 'DeepSeek',
    kind: 'high-usage',
    pct: 96,
    read: false,
    ...overrides,
    lastSeenAt: overrides.lastSeenAt ?? overrides.firstSeenAt,
  }
}

function findAlert(items: AlertItem[], id = ALERT_ID): AlertItem | undefined {
  return items.find((a) => a.id === id)
}

describe('deriveAlerts retention (lastSeenAt semantics)', () => {
  it('re-stamps lastSeenAt on every round the alert stays live and keeps firstSeenAt/read', () => {
    saveAlerts([storedAlert({ firstSeenAt: NOW - 72 * HOUR, lastSeenAt: NOW - 2 * HOUR, read: true })])

    const merged = deriveAlerts(sections(), results(95))
    const alert = findAlert(merged)
    expect(alert).toBeDefined()
    expect(alert?.resolved).toBeUndefined()
    expect(alert?.firstSeenAt).toBe(NOW - 72 * HOUR)
    expect(alert?.lastSeenAt).toBe(NOW)
    expect(alert?.read).toBe(true)
    // The metric fields refresh from the current round
    expect(alert?.pct).toBe(95)
  })

  it('keeps a freshly resolved alert as dimmed history counted from lastSeenAt', () => {
    // First seen 72h ago — well beyond the 48h window — but last seen 1h ago:
    // the retention window starts at the LAST sighting, so it stays.
    saveAlerts([storedAlert({ firstSeenAt: NOW - 72 * HOUR, lastSeenAt: NOW - 1 * HOUR })])

    const merged = deriveAlerts(sections(), results(50))
    const alert = findAlert(merged)
    expect(alert?.resolved).toBe(true)
    expect(alert?.firstSeenAt).toBe(NOW - 72 * HOUR)
    expect(alert?.lastSeenAt).toBe(NOW - 1 * HOUR)
  })

  it('drops an alert that has been unseen for more than 48h', () => {
    saveAlerts([
      storedAlert({ id: 'deepseek-0:high-usage:m1', firstSeenAt: NOW - 100 * HOUR, lastSeenAt: NOW - 49 * HOUR }),
      storedAlert({ id: 'deepseek-0:high-usage:m2', firstSeenAt: NOW - 100 * HOUR, lastSeenAt: NOW - 47 * HOUR }),
    ])

    const merged = deriveAlerts(sections(), results(50))
    expect(findAlert(merged, 'deepseek-0:high-usage:m1')).toBeUndefined()
    // One hour short of the window: still kept as history
    expect(findAlert(merged, 'deepseek-0:high-usage:m2')?.resolved).toBe(true)
  })

  it('falls back to firstSeenAt for legacy rows persisted before lastSeenAt existed', () => {
    const legacy = (firstSeenAt: number): AlertItem =>
      ({
        id: firstSeenAt === NOW - 10 * HOUR ? ALERT_ID : 'deepseek-0:high-usage:m2',
        level: 'warning',
        accountKey: 'deepseek-0',
        agentName: 'DeepSeek',
        kind: 'high-usage',
        pct: 96,
        firstSeenAt,
        read: false,
      }) as AlertItem
    saveAlerts([legacy(NOW - 10 * HOUR), legacy(NOW - 72 * HOUR)])

    const merged = deriveAlerts(sections(), results(50))
    // Recent legacy row: keeps the pre-existing firstSeen-based window, resolved
    expect(findAlert(merged)?.resolved).toBe(true)
    // Ancient legacy row without lastSeenAt: expired, dropped
    expect(findAlert(merged, 'deepseek-0:high-usage:m2')).toBeUndefined()
  })

  it('never ages out an alert that is still live, however old it is', () => {
    saveAlerts([storedAlert({ firstSeenAt: NOW - 72 * HOUR, lastSeenAt: NOW - 72 * HOUR })])

    const merged = deriveAlerts(sections(), results(95))
    const alert = findAlert(merged)
    expect(alert?.resolved).toBeUndefined()
    expect(alert?.lastSeenAt).toBe(NOW)
  })

  it('keeps the previous state while the account is loading or errored', () => {
    // lastSeenAt is far beyond the window, but a loading fetch is not evidence
    // the condition cleared — the row must survive unresolved
    saveAlerts([storedAlert({ firstSeenAt: NOW - 72 * HOUR, lastSeenAt: NOW - 72 * HOUR })])

    for (const status of ['loading', 'error'] as const) {
      const merged = deriveAlerts(sections(), results(50, status))
      const alert = findAlert(merged)
      expect(alert).toBeDefined()
      expect(alert?.resolved).toBeUndefined()
      expect(alert?.lastSeenAt).toBe(NOW - 72 * HOUR)
    }
  })

  it('emits a fresh alert with firstSeenAt = lastSeenAt = now when nothing is stored', () => {
    const merged = deriveAlerts(sections(), results(95))
    const alert = findAlert(merged)
    expect(alert?.firstSeenAt).toBe(NOW)
    expect(alert?.lastSeenAt).toBe(NOW)
    expect(alert?.resolved).toBeUndefined()
  })
})

describe('resolved history is display-only', () => {
  it('does not count resolved rows into the unread badge', () => {
    saveAlerts([
      storedAlert({ firstSeenAt: NOW - 1 * HOUR, lastSeenAt: NOW - 1 * HOUR, read: false }),
    ])
    const merged = deriveAlerts(sections(), results(50))
    expect(findAlert(merged)?.resolved).toBe(true)
    expect(unreadCount(merged)).toBe(0)
    // The same row while live does count
    expect(unreadCount(deriveAlerts(sections(), results(95)))).toBe(1)
  })

  it('persists derived state through save/load so the window survives restarts', () => {
    saveAlerts([storedAlert({ firstSeenAt: NOW - 1 * HOUR, lastSeenAt: NOW - 1 * HOUR })])
    const merged = deriveAlerts(sections(), results(50))
    saveAlerts(merged)
    expect(loadAlerts()).toEqual(merged)
  })
})

/**
 * Subscription quota windows enter the engine as extra sources: one alert
 * per window under the card's name, carrying the window id and label so a
 * multi-window card stays readable. An exhausted window is announced by the
 * high-usage row (which carries the recovery time), not by a second
 * "resetting soon" row.
 */
describe('deriveAlerts with extra (subscription) sources', () => {
  const RESET_AT = NOW + 30 * 60_000

  function claudeSource(percent: number): AlertSource {
    return {
      key: 'claude',
      agentName: 'Claude Code',
      metrics: [{ id: 'fiveHour', label: '5 小时窗口', kind: 'percent', percent, resetsAt: RESET_AT }],
    }
  }

  it('raises one high-usage alert per window with the window id, label and reset time', () => {
    const merged = deriveAlerts(sections(), {}, DEFAULT_ALERT_THRESHOLDS, [claudeSource(100)])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'claude:high-usage:fiveHour',
      kind: 'high-usage',
      level: 'danger',
      accountKey: 'claude',
      agentName: 'Claude Code',
      metricId: 'fiveHour',
      windowLabel: '5 小时窗口',
      resetsAt: RESET_AT,
      pct: 100,
    })
  })

  it('does not add a window-reset row for an exhausted window inside the reset-soon horizon', () => {
    const merged = deriveAlerts(sections(), {}, DEFAULT_ALERT_THRESHOLDS, [claudeSource(100)])
    expect(merged.some((a) => a.kind === 'window-reset')).toBe(false)
  })

  it('keeps the window-reset row for a window below 100% inside the horizon, naming the window', () => {
    const merged = deriveAlerts(sections(), {}, DEFAULT_ALERT_THRESHOLDS, [claudeSource(95)])
    expect(merged.map((a) => a.kind).sort()).toEqual(['high-usage', 'window-reset'])
    expect(merged.find((a) => a.kind === 'window-reset')).toMatchObject({ windowLabel: '5 小时窗口', resetsAt: RESET_AT })
  })

  it('files a subscription alert as resolved history once its window is no longer raised', () => {
    saveAlerts(deriveAlerts(sections(), {}, DEFAULT_ALERT_THRESHOLDS, [claudeSource(95)]))
    const merged = deriveAlerts(sections(), {}, DEFAULT_ALERT_THRESHOLDS, [])
    expect(findAlert(merged, 'claude:high-usage:fiveHour')?.resolved).toBe(true)
  })

  it('does not mutate the extra sources array the caller hands in', () => {
    const extra = [claudeSource(95)]
    deriveAlerts(sections(), results(95), DEFAULT_ALERT_THRESHOLDS, extra)
    expect(extra).toHaveLength(1)
  })

  it('builds the restore id from the source, the window and the reset point', () => {
    expect(restoredAlertId('claude', 'fiveHour', RESET_AT)).toBe(`claude:window-restored:fiveHour:${RESET_AT}`)
  })
})
