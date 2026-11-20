import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchKiloQuota, kiloTokenFromAuth, windowsFromKiloBatch } from './kilo-quota'

describe('Kilo auth and payload', () => {
  it('reads kilo.access and ignores a broken file', () => {
    expect(kiloTokenFromAuth(JSON.stringify({ kilo: { access: 'tok' } }))).toBe('tok')
    expect(kiloTokenFromAuth('nope')).toBeNull()
  })

  it('sums credit blocks and keeps the pass window separate', () => {
    const parsed = windowsFromKiloBatch([
      {
        result: {
          data: {
            json: {
              creditBlocks: [
                { amount_mUsd: 2_000_000, balance_mUsd: 500_000 },
                { amount_mUsd: 1_000_000, balance_mUsd: 1_000_000 },
              ],
            },
          },
        },
      },
      {
        result: {
          data: {
            json: {
              planName: 'Kilo Pass',
              currentPeriodUsageUsd: 4,
              currentPeriodBaseCreditsUsd: 10,
              nextBillingAt: '2026-05-01T00:00:00Z',
            },
          },
        },
      },
    ])
    expect(parsed).toEqual({
      plan: 'Kilo Pass',
      windows: [
        { id: 'kiloCredits', percent: 50, resetsAt: null },
        { id: 'kiloPass', percent: 40, resetsAt: Date.parse('2026-05-01T00:00:00Z') },
      ],
    })
  })

  it('does not invent a window from an empty batch', () => {
    expect(windowsFromKiloBatch([{ result: { data: { json: {} } } }])).toBeNull()
  })
})

describe('fetchKiloQuota', () => {
  it('uses the CLI file and does not echo the token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kilo-quota-'))
    const data = join(home, 'xdg')
    const authDir = join(data, 'kilo')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({ kilo: { access: 'secret-token' } }))
    let authorization = ''
    const outcome = await fetchKiloQuota(
      async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return new Response(
          JSON.stringify([{ result: { data: { json: { totalBalance_mUsd: 0 } } } }, { result: { data: { json: {} } } }]),
        )
      },
      home,
      { XDG_DATA_HOME: data },
    )
    expect(authorization).toBe('Bearer secret-token')
    expect(outcome.body).not.toContain('secret-token')
    expect(JSON.parse(outcome.body ?? '{}').windows[0]).toMatchObject({ id: 'kiloCredits', percent: 100 })
  })
})
