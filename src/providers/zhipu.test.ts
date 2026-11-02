import { describe, expect, it } from 'vitest'
import { zhipu } from './zhipu'

/**
 * The monitor endpoint reports each coding-plan window either as `percentage`
 * or as a credit pair (`currentValue` consumed / `usage` total). Reading only
 * `percentage` made a window vanish the day the API stopped sending it, which
 * looks identical to "this plan has no quota".
 */
const envelope = (limits: unknown[]): unknown => ({
  success: true,
  code: 200,
  data: { level: 'lite', limits },
})

describe('zhipu coding-plan quota', () => {
  it('reads percentage when the API sends it', async () => {
    const metrics = await zhipu.parseResponse(
      envelope([
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 42, nextResetTime: 1796039275000 },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 71, nextResetTime: 1796039275000 },
      ]),
      { locale: 'zh-CN' },
    )
    expect(metrics.map((m) => [m.label, m.percent])).toEqual([
      ['LITE · 套餐 · 5 小时窗口', 42],
      ['LITE · 套餐 · 周配额', 71],
    ])
  })

  it('derives the percentage from currentValue / usage when it is missing', async () => {
    const metrics = await zhipu.parseResponse(
      envelope([
        { type: 'CREDIT_LIMIT', unit: 3, currentValue: 30, usage: 120, nextResetTime: 1796039275000 },
        { type: 'CREDIT_LIMIT', unit: 6, currentValue: 1000, usage: 1000 },
      ]),
      { locale: 'zh-CN' },
    )
    expect(metrics.map((m) => [m.percent, m.used, m.total])).toEqual([
      [25, 30, 120],
      [100, 1000, 1000],
    ])
  })

  it('still reports a window whose counters are all zero', async () => {
    const metrics = await zhipu.parseResponse(
      envelope([{ type: 'CREDIT_LIMIT', unit: 3, currentValue: 0, usage: 0, percentage: 0 }]),
      { locale: 'zh-CN' },
    )
    expect(metrics.map((m) => m.percent)).toEqual([0])
  })

  it('drops a window only when neither percentage nor counters are usable', async () => {
    await expect(
      zhipu.parseResponse(envelope([{ type: 'TOKENS_LIMIT', unit: 3 }]), { locale: 'zh-CN' }),
    ).rejects.toThrow(/额度/)
  })

  it('keeps the MCP monthly window alongside the token windows', async () => {
    const metrics = await zhipu.parseResponse(
      envelope([
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 10 },
        { type: 'TIME_LIMIT', currentValue: 20, usage: 100 },
      ]),
      { locale: 'zh-CN' },
    )
    expect(metrics.map((m) => [m.id, Math.round(m.percent ?? 0)])).toEqual([
      ['zhipu-tokens-0', 10],
      ['zhipu-mcp', 20],
    ])
  })
})
