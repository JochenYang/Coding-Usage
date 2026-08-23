import type { ParseContext, ProviderDef, UsageMetric } from '../types'
import { UNLIMITED_KEY } from '../lib/metric-helpers'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

const MINIMAX_BASE_URLS: Record<string, string> = {
  cn: 'https://www.minimaxi.com',
  intl: 'https://www.minimax.io',
}

/**
 * Real endpoint: `/v1/api/openplatform/coding_plan/remains`
 * Requires a `Referer` header; authenticated with the subscription key.
 * Field semantics come from the minimax-status project:
 *   - `*_remaining_percent` is literally the remaining percentage
 *   - `*_usage_count` is unreliable; compute usage from `remaining_percent`
 *
 * The main plan panel renders only 3 independent metrics (mirrors the
 * minimax-status official UI):
 *   1. Plan · 5h quota = `general` model's `current_interval_*` (5h window)
 *   2. Plan · Weekly quota = `general` model's `current_weekly_*` (plan's weekly/monthly refresh window)
 *   3. Video bonus = `video` model's `current_weekly_*` (video sub-quota, independent of the main plan pool)
 *
 * The `video` model's 5h window is NOT part of the main plan panel and is
 * not rendered. Other sub-models (image/speech/Hailuo/music) can be added
 * if needed, but are not rendered by default.
 */
const MAIN_MODEL_KEY = 'general'
const EXTRA_MODEL_KEY = 'video'

interface ParsedModel {
  modelName: string
  intervalTotal: number | null
  intervalRemainingPercent: number | null
  intervalRemainsMs: number | null
  weeklyTotal: number | null
  weeklyRemainingPercent: number | null
  weeklyRemainsMs: number | null
}

function parseModel(m: Record<string, unknown>): ParsedModel | null {
  const modelName = typeof m.model_name === 'string' ? m.model_name : ''
  const intervalTotal = typeof m.current_interval_total_count === 'number' ? m.current_interval_total_count : null
  const intervalRemainingPercent =
    typeof m.current_interval_remaining_percent === 'number' ? m.current_interval_remaining_percent : null
  const intervalRemainsMs = typeof m.remains_time === 'number' ? m.remains_time : null
  const weeklyTotal =
    typeof m.current_weekly_total_count === 'number' ? m.current_weekly_total_count : null
  const weeklyRemainingPercent =
    typeof m.current_weekly_remaining_percent === 'number' ? m.current_weekly_remaining_percent : null
  const weeklyRemainsMs = typeof m.weekly_remains_time === 'number' ? m.weekly_remains_time : null
  if (intervalRemainingPercent == null && weeklyRemainingPercent == null) return null
  return {
    modelName,
    intervalTotal,
    intervalRemainingPercent,
    intervalRemainsMs,
    weeklyTotal,
    weeklyRemainingPercent,
    weeklyRemainsMs,
  }
}

function buildMetric(
  prefix: string,
  label: string,
  total: number | null,
  remainingPercent: number | null,
  remainsMs: number | null,
  now: number,
  opts?: { unlimited?: boolean },
): UsageMetric | undefined {
  if (remainingPercent == null) return undefined

  // "Unlimited" classification (follows minimax-status CLI logic with one relaxation):
  //   - CLI strict: total === 0 && remainingPercent == null
  //   - Relaxed (weekly scenario): total === 0 (owner's `general` data with total=0 + remaining=100% also counts as unlimited)
  // Callers control this explicitly via `opts.unlimited`; the 5h window always passes `false`, the weekly window passes `true`
  const isUnlimited = opts?.unlimited === true && total === 0

  const remaining = Math.max(0, Math.min(100, remainingPercent))
  const usedPercent = Math.round(100 - remaining)
  const remainingCount =
    typeof total === 'number' && total > 0 ? Math.round((total * remaining) / 100) : null
  // For unlimited windows: stamp UNLIMITED_KEY into `unit` so MetricList can detect the state.
  // For count-based windows: leave `unit` undefined and surface concrete `used`/`total`
  // so MetricList can format them via `t.metric.remaining` (locale-aware).
  return {
    id: prefix,
    label,
    kind: 'percent',
    percent: usedPercent,
    unit: isUnlimited ? UNLIMITED_KEY : undefined,
    used: !isUnlimited && remainingCount != null ? remainingCount : undefined,
    total: !isUnlimited && typeof total === 'number' ? total : undefined,
    resetsAt: remainsMs != null && remainsMs > 0 ? now + remainsMs : undefined,
  }
}

/** Lets MetricList distinguish the unlimited state: when `unit` equals the unlimited sentinel, render a full green progress bar without the percent label */
export function isUnlimitedMetric(m: { unit?: string }): boolean {
  return m.unit === UNLIMITED_KEY
}

function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const parsed = Date.parse(v)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** Asynchronously fetch plan details (expiration time). Failures silently return `undefined` — the main card must still render. */
async function fetchExpiry(
  ctx: ParseContext,
  key: string,
  regionBaseUrl: string,
): Promise<number | undefined> {
  if (!ctx.fetch) return undefined
  try {
    const url =
      `${regionBaseUrl}/v1/api/openplatform/charge/combo/cycle_audio_resource_package` +
      `?biz_line=2&cycle_type=1&resource_package_type=7`
    const res = await ctx.fetch(url, {
      Authorization: `Bearer ${key}`,
      Referer: 'https://platform.minimaxi.com/',
      Accept: 'application/json',
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as {
      data?: { current_subscribe?: { current_subscribe_end_time?: unknown } }
    }
    return toEpochMs(json.data?.current_subscribe?.current_subscribe_end_time)
  } catch {
    return undefined
  }
}

export const minimax: ProviderDef = {
  id: 'minimax',
  name: 'MiniMax Token Plan',
  accent: 'from-red-500 to-orange-500',
  logo: 'MiniMax-color',
  tagline: (t) => t.providers.minimax.tagline,
  regions: (t) => [
    { id: 'cn', label: t.regions.minimaxCN, baseUrl: MINIMAX_BASE_URLS.cn },
    { id: 'intl', label: t.regions.minimaxIntl, baseUrl: MINIMAX_BASE_URLS.intl },
  ],
  docsUrl: 'https://platform.minimaxi.com/docs/token-plan/faq',
  keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  buildRequest(key, regionId) {
    const baseUrl = MINIMAX_BASE_URLS[regionId ?? 'cn'] ?? MINIMAX_BASE_URLS.cn
    return {
      url: `${baseUrl}/v1/api/openplatform/coding_plan/remains`,
      headers: {
        Authorization: `Bearer ${key}`,
        Referer: 'https://platform.minimaxi.com/',
        Accept: 'application/json',
      },
    }
  },
  async parseResponse(json, ctx) {
    const body = json as { base_resp?: { status_code?: number; status_msg?: string }; model_remains?: unknown[] }
    const base = body.base_resp
    if (!base || typeof base.status_code !== 'number') {
      throw new Error('响应格式变化：缺少 base_resp')
    }
    if (base.status_code !== 0) {
      const msg = base.status_msg ?? `错误码 ${base.status_code}`
      throw new Error(base.status_code === 1004 || base.status_code === 2049 ? `Key 无效：${msg}` : msg)
    }
    const rawList = Array.isArray(body.model_remains)
      ? (body.model_remains as Array<Record<string, unknown>>)
      : []
    if (rawList.length === 0) throw new Error('响应中没有 model_remains 数据')
    const now = Date.now()
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']

    const main = rawList.find((m) => m.model_name === MAIN_MODEL_KEY)
    const extra = rawList.find((m) => m.model_name === EXTRA_MODEL_KEY)

    const intervals: UsageMetric[] = []

    // 1. Plan · 5h quota (`general` model's 5h window) — the 5h window is never classified as unlimited
    if (main) {
      const pm = parseModel(main)
      if (pm) {
        const m = buildMetric(
          'minimax-5h',
          t.windows.fiveHour,
          pm.intervalTotal,
          pm.intervalRemainingPercent,
          pm.intervalRemainsMs,
          now,
          { unlimited: false },
        )
        if (m) intervals.push(m)
      }
    }

    // 2. Plan · Weekly/monthly quota (`general` model's weekly) — classified as unlimited when total=0
    if (main) {
      const pm = parseModel(main)
      if (pm) {
        const m = buildMetric(
          'minimax-weekly',
          t.windows.weeklyPlan,
          pm.weeklyTotal,
          pm.weeklyRemainingPercent,
          pm.weeklyRemainsMs,
          now,
          { unlimited: true },
        )
        if (m) intervals.push(m)
      }
    }

    // 3. Video bonus (`video` model's weekly fields, an independent sub-quota) — `video` generally has a concrete total count and is never classified as unlimited
    if (extra) {
      const pm = parseModel(extra)
      if (pm) {
        const m = buildMetric(
          'minimax-video-bonus',
          t.windows.videoWeekly,
          pm.weeklyTotal,
          pm.weeklyRemainingPercent,
          pm.weeklyRemainsMs,
          now,
          { unlimited: false },
        )
        if (m) intervals.push(m)
      }
    }

    if (intervals.length === 0) {
      throw new Error('订阅有效但响应字段暂不支持解析，欢迎反馈')
    }

    if (ctx?.fetch && ctx.key) {
      const baseUrl = MINIMAX_BASE_URLS[ctx.regionId ?? 'cn'] ?? MINIMAX_BASE_URLS.cn
      const expiresAt = await fetchExpiry(ctx, ctx.key, baseUrl)
      if (expiresAt) {
        intervals.push({
          id: 'minimax-expiry',
          label: '套餐到期',
          kind: 'expiry',
          expiresAt,
        })
      }
    }
    return intervals
  },
}
