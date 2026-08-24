import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

interface ZenWindow {
  status?: string
  percent?: number
  resetsAt?: string
}

const WINDOWS = [
  { key: 'rolling', dictKey: 'rolling' as const },
  { key: 'weekly', dictKey: 'weekly' as const },
  { key: 'monthly', dictKey: 'monthly' as const },
]

export const opencode: ProviderDef = {
  id: 'opencode',
  name: 'OpenCode Zen Go',
  logo: 'opencode',
  accent: 'from-zinc-300 to-slate-500',
  tagline: (t) => t.providers.opencode.tagline,
  docsUrl: 'https://opencode.ai/docs/zen/',
  keyUrl: 'https://opencode.ai/zh/zen',
  buildRequest(key) {
    return {
      url: 'https://opencode.ai/zen/go/v1/usage',
      headers: { Authorization: `Bearer ${key}` },
    }
  },
  async parseResponse(json, ctx) {
    const usage = (json as { usage?: Record<string, ZenWindow> }).usage
    if (!usage || typeof usage !== 'object') {
      throw new Error('响应缺少 usage 字段')
    }
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
    const metrics: UsageMetric[] = []
    for (const w of WINDOWS) {
      const win = usage[w.key]
      if (!win || typeof win.percent !== 'number') continue
      const label =
        win.status === 'rate-limited'
          ? `${t.windows[w.dictKey]}${t.windows.rateLimited}`
          : t.windows[w.dictKey]
      metrics.push({
        id: `opencode-${w.key}`,
        label,
        kind: 'percent',
        percent: win.percent,
        resetsAt: win.resetsAt ? Date.parse(win.resetsAt) : undefined,
      })
    }
    if (metrics.length === 0) throw new Error('响应中没有任何窗口数据')
    return metrics
  },
}