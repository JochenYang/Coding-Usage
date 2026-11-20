import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fetchWindsurfQuota, windowsFromCachedPlan } from './windsurf-quota'

function writeDb(dir: string, value: string | Buffer): string {
  const root = join(dir, 'Windsurf', 'User', 'globalStorage')
  const file = join(root, 'state.vscdb')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('windsurf.settings.cachedPlanInfo', value)
  db.close()
  return dir
}

describe('Windsurf cached plan', () => {
  it('inverts remaining percents and treats reset timestamps as unix seconds', () => {
    const parsed = windowsFromCachedPlan({
      planName: 'Pro',
      quotaUsage: { dailyRemainingPercent: 30, weeklyRemainingPercent: 80, dailyResetAtUnix: 1_700_000_000 },
    })
    expect(parsed).toEqual({
      plan: 'Pro',
      windows: [
        { id: 'windsurfDaily', percent: 70, resetsAt: 1_700_000_000_000 },
        { id: 'windsurfWeekly', percent: 20, resetsAt: null },
      ],
    })
  })

  it('falls back to message and flow counters when quota windows are absent', () => {
    const parsed = windowsFromCachedPlan({
      usage: { messages: 100, usedMessages: 25, flowActions: 40, remainingFlowActions: 10 },
    })
    expect(parsed?.windows).toEqual([
      { id: 'windsurfMessages', percent: 25, resetsAt: null },
      { id: 'windsurfFlow', percent: 75, resetsAt: null },
    ])
  })

  it('does not add a flow-action bar when an official daily window is present', () => {
    const parsed = windowsFromCachedPlan({
      quotaUsage: { dailyRemainingPercent: 40 },
      usage: { flowActions: 40, remainingFlowActions: 10 },
    })
    expect(parsed?.windows).toEqual([{ id: 'windsurfDaily', percent: 60, resetsAt: null }])
  })

  it('does not invent a window from an empty cache', () => {
    expect(windowsFromCachedPlan({ planName: 'Free' })).toBeNull()
    expect(windowsFromCachedPlan({ usage: { messages: 0, usedMessages: 0 } })).toBeNull()
  })
})

describe('fetchWindsurfQuota', () => {
  it('reads a text row and marks the result stale', async () => {
    const home = await mkdtemp(join(tmpdir(), 'windsurf-quota-'))
    const appData = await mkdtemp(join(tmpdir(), 'windsurf-app-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(appData, 'Windsurf', 'User', 'globalStorage'), { recursive: true })
    writeDb(appData, JSON.stringify({ planName: 'Pro', quotaUsage: { dailyRemainingPercent: 0 } }))
    const outcome = await fetchWindsurfQuota(home, { APPDATA: appData })
    expect(outcome.available).toBe(true)
    const body = JSON.parse(outcome.body ?? '{}')
    expect(body.stale).toBe(true)
    expect(body.windows).toEqual([{ id: 'windsurfDaily', percent: 100, resetsAt: null }])
    expect(body.plan).toBe('Pro')
  })

  it('accepts a UTF-16 blob and reports no cache when the database is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'windsurf-quota-'))
    expect(await fetchWindsurfQuota(home, {})).toEqual({ available: false, reason: 'no-auth' })
    const appData = await mkdtemp(join(tmpdir(), 'windsurf-app-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(appData, 'Windsurf', 'User', 'globalStorage'), { recursive: true })
    writeDb(appData, Buffer.from(JSON.stringify({ usage: { messages: 10, usedMessages: 4 } }), 'utf16le'))
    const outcome = await fetchWindsurfQuota(home, { APPDATA: appData })
    expect(JSON.parse(outcome.body ?? '{}').windows).toEqual([{ id: 'windsurfMessages', percent: 40, resetsAt: null }])
  })
})
