import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  devinCredentialsCandidates,
  fetchDevinQuota,
  planFromUserStatus,
  windsurfApiKeyFromToml,
  windowsFromUserStatus,
} from './devin-quota'

describe('Devin credentials location', () => {
  it('checks APPDATA, then XDG_DATA_HOME, then the shared data dir', () => {
    expect(devinCredentialsCandidates('/home/u', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })[0]).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'devin', 'credentials.toml'),
    )
    const paths = devinCredentialsCandidates('/home/u', { XDG_DATA_HOME: '/xdg' })
    expect(paths[0]).toBe(join('/xdg', 'devin', 'credentials.toml'))
    expect(devinCredentialsCandidates('/home/u', {})).toEqual([
      join('/home/u', '.local', 'share', 'devin', 'credentials.toml'),
    ])
  })

  it('expands a home-relative XDG override', () => {
    expect(devinCredentialsCandidates('/home/u', { XDG_DATA_HOME: '~/.local/share' })[0]).toBe(
      join('/home/u', '.local', 'share', 'devin', 'credentials.toml'),
    )
  })
})

describe('Devin credentials.toml', () => {
  it('reads only windsurf_api_key and tolerates surrounding sections', () => {
    const raw = [
      '# written by the devin CLI',
      '[other_section]',
      'other_key = "ignored"',
      '',
      'windsurf_api_key = "sk-windsurf-secret"',
    ].join('\n')
    expect(windsurfApiKeyFromToml(raw)).toBe('sk-windsurf-secret')
    expect(windsurfApiKeyFromToml('windsurf_api_key = "  spaced  "')).toBe('spaced')
    expect(windsurfApiKeyFromToml('not [valid toml')).toBeNull()
    expect(windsurfApiKeyFromToml('different_key = "x"')).toBeNull()
    expect(windsurfApiKeyFromToml('windsurf_api_key = ""')).toBeNull()
  })

  it('rejects a key that could break the JSON body', () => {
    expect(windsurfApiKeyFromToml('windsurf_api_key = "a\nb"')).toBeNull()
  })
})

describe('Devin GetUserStatus payload', () => {
  it('inverts remaining percentages and converts Unix-second resets', () => {
    const windows = windowsFromUserStatus({
      userStatus: {
        planStatus: {
          planInfo: { planName: 'Pro' },
          dailyQuotaRemainingPercent: 40,
          weeklyQuotaRemainingPercent: '70',
          dailyQuotaResetAtUnix: '1800000000',
          weeklyQuotaResetAtUnix: 1_806_000_000,
        },
      },
    })
    expect(windows).toEqual([
      { id: 'devinDaily', percent: 60, resetsAt: 1_800_000_000_000 },
      { id: 'devinWeekly', percent: 30, resetsAt: 1_806_000_000_000 },
    ])
    expect(planFromUserStatus({
      userStatus: { planStatus: { planInfo: { planName: 'Pro' } } },
    })).toBe('Pro')
  })

  it('reads a reset without a remaining percent as exhausted and keeps a percent without a reset', () => {
    const windows = windowsFromUserStatus({
      userStatus: { planStatus: { dailyQuotaResetAtUnix: 1_800_000_000, weeklyQuotaRemainingPercent: 25 } },
    })
    expect(windows).toEqual([
      { id: 'devinDaily', percent: 100, resetsAt: 1_800_000_000_000 },
      { id: 'devinWeekly', percent: 75, resetsAt: null },
    ])
  })

  it('drops implausible reset stamps and windows with no data at all', () => {
    expect(
      windowsFromUserStatus({ userStatus: { planStatus: { dailyQuotaResetAtUnix: 123, weeklyQuotaRemainingPercent: 10 } } }),
    ).toEqual([{ id: 'devinWeekly', percent: 90, resetsAt: null }])
    expect(windowsFromUserStatus({ userStatus: { planStatus: {} } })).toBeNull()
    expect(windowsFromUserStatus({ userStatus: {} })).toBeNull()
    expect(windowsFromUserStatus(null)).toBeNull()
    expect(planFromUserStatus({ userStatus: { planStatus: {} } })).toBeNull()
  })
})

describe('fetchDevinQuota', () => {
  it('returns no-auth when the CLI has never signed in', async () => {
    const home = await mkdtemp(join(tmpdir(), 'devin-quota-'))
    expect(await fetchDevinQuota(async () => new Response(''), home, {})).toEqual({
      available: false,
      reason: 'no-auth',
    })
  })

  it('posts the Connect-RPC JSON request with metadata.apiKey and returns only numbers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'devin-quota-'))
    const appdata = join(home, 'appdata')
    await mkdir(join(appdata, 'devin'), { recursive: true })
    await writeFile(join(appdata, 'devin', 'credentials.toml'), 'windsurf_api_key = "sk-devin-secret"\n')
    let url = ''
    let contentType = ''
    let body = ''
    const outcome = await fetchDevinQuota(
      async (_url, init) => {
        url = String(_url)
        contentType = new Headers(init?.headers).get('content-type') ?? ''
        body = String(init?.body ?? '')
        return new Response(
          JSON.stringify({
            userStatus: {
              planStatus: {
                planInfo: { planName: 'Teams' },
                dailyQuotaRemainingPercent: 90,
                weeklyQuotaRemainingPercent: 50,
                dailyQuotaResetAtUnix: 1_800_000_000,
                weeklyQuotaResetAtUnix: 1_806_000_000,
              },
            },
          }),
        )
      },
      home,
      { APPDATA: appdata },
    )
    expect(url).toBe('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus')
    expect(contentType).toBe('application/json')
    expect(body).toContain('"apiKey":"sk-devin-secret"')
    expect(outcome.available).toBe(true)
    expect(outcome.body).not.toContain('sk-devin-secret')
    const parsed = JSON.parse(outcome.body ?? '{}')
    expect(parsed.plan).toBe('Teams')
    expect(parsed.windows).toEqual([
      { id: 'devinDaily', percent: 10, resetsAt: 1_800_000_000_000 },
      { id: 'devinWeekly', percent: 50, resetsAt: 1_806_000_000_000 },
    ])
  })

  it('maps a rejected key to reauth and an unparsable response to its own reasons', async () => {
    const home = await mkdtemp(join(tmpdir(), 'devin-quota-'))
    const appdata = join(home, 'appdata')
    await mkdir(join(appdata, 'devin'), { recursive: true })
    await writeFile(join(appdata, 'devin', 'credentials.toml'), 'windsurf_api_key = "sk-devin-secret"\n')
    const env = { APPDATA: appdata }
    expect(await fetchDevinQuota(async () => new Response('no', { status: 403 }), home, env)).toEqual({
      available: false,
      reason: 'reauth',
    })
    const outcome = await fetchDevinQuota(async () => new Response('{"userStatus":{}}', { status: 200 }), home, env)
    expect(outcome).toEqual({ available: false, reason: 'parse-failed' })
    const bad = await fetchDevinQuota(async () => new Response('not json', { status: 200 }), home, env)
    expect(bad).toEqual({ available: false, reason: 'bad-response' })
  })
})
