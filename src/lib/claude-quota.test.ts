import { describe, expect, it } from 'vitest'
import { summarizeClaudeQuota } from './claude-quota'

describe('summarizeClaudeQuota', () => {
  it('keeps the four legacy windows in canonical order', () => {
    const vm = summarizeClaudeQuota({
      available: true,
      body: JSON.stringify({
        seven_day: { utilization: 40, resets_at: '2026-11-05T00:00:00Z' },
        five_hour: { utilization: 12, resets_at: '2026-11-02T10:00:00Z' },
      }),
    })
    expect(vm.windows.map((w) => w.id)).toEqual(['fiveHour', 'sevenDay'])
    expect(vm.windows[1].percent).toBe(40)
    expect(vm.scoped).toEqual([])
  })

  it('reads model-scoped weekly limits from limits[]', () => {
    const vm = summarizeClaudeQuota({
      available: true,
      body: JSON.stringify({
        five_hour: { utilization: 5 },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 82,
            resets_at: '2026-11-06T00:00:00Z',
            scope: { model: { display_name: 'Opus 4.6' } },
          },
          { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 'Haiku 4.5' } } },
        ],
      }),
    })
    expect(vm.scoped.map((s) => [s.label, s.percent])).toEqual([
      ['Opus 4.6', 82],
      ['Haiku 4.5', 10],
    ])
    expect(vm.scoped[0].resetsAt).toBe(Date.parse('2026-11-06T00:00:00Z'))
  })

  it('keeps the tightest reading when a model repeats', () => {
    const vm = summarizeClaudeQuota({
      available: true,
      body: JSON.stringify({
        limits: [
          { kind: 'weekly_scoped', percent: 30, scope: { model: { display_name: 'Opus' } } },
          { kind: 'weekly_scoped', percent: 71, scope: { model: { display_name: 'Opus' } } },
        ],
      }),
    })
    expect(vm.scoped).toHaveLength(1)
    expect(vm.scoped[0].percent).toBe(71)
  })

  it('stays available on limits alone, which is what a scoped-only plan returns', () => {
    const vm = summarizeClaudeQuota({
      available: true,
      body: JSON.stringify({ limits: [{ kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'Sonnet' } } }] }),
    })
    expect(vm.available).toBe(true)
    expect(vm.reason).toBeNull()
    expect(vm.windows).toEqual([])
  })

  it('degrades to unavailable when nothing parses', () => {
    const vm = summarizeClaudeQuota({ available: true, body: '{}' })
    expect(vm.available).toBe(false)
    expect(vm.reason).toBe('malformed-body')
  })
})
