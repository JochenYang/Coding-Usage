import type { ParseContext, ProviderDef, UsageMetric } from '../types'
import { UNLIMITED_KEY } from '../lib/metric-helpers'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Dict, Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/** Per-site facts for the MiniMax Token Plan: the two sites are separate accounts, so each is its own provider. */
interface MiniMaxSite<Id extends keyof Dict['providers'] = keyof Dict['providers']> {
  /** Provider id; doubles as the key of its copy in the dictionary */
  id: Id
  name: string
  /** Open-platform API host the coding-plan endpoints live on */
  baseUrl: string
  /** The endpoints refuse a request without a console Referer */
  referer: string
  docsUrl: string
  keyUrl: string
}

/**
 * They used to be one provider with a region switch; accounts saved before
 * the split are moved by `normalizeProviders` (storage.ts).
 *
 * The China site moved off `minimaxi.com` in 2026-11: the console now lives on
 * `platform.minimax.cn` (the old host redirects there) and the API docs name
 * `api.minimax.cn` as the host. The international site keeps the China
 * Referer it has always sent — it is what the live endpoint was verified with.
 */
const MINIMAX_SITES = {
  cn: {
    id: 'minimax',
    name: 'MiniMax Token Plan',
    baseUrl: 'https://api.minimax.cn',
    referer: 'https://platform.minimax.cn/',
    docsUrl: 'https://platform.minimax.cn/docs/m-plan/faq',
    keyUrl: 'https://platform.minimax.cn/console/keys',
  },
  intl: {
    id: 'minimax-intl',
    name: 'MiniMax Token Plan Intl',
    baseUrl: 'https://www.minimax.io',
    referer: 'https://platform.minimaxi.com/',
    docsUrl: 'https://platform.minimax.io/docs/m-plan/faq',
    keyUrl: 'https://platform.minimax.io/console/keys',
  },
} as const satisfies Record<'cn' | 'intl', MiniMaxSite>

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
  site: MiniMaxSite,
): Promise<number | undefined> {
  if (!ctx.fetch) return undefined
  try {
    const url =
      `${site.baseUrl}/v1/api/openplatform/charge/combo/cycle_audio_resource_package` +
      `?biz_line=2&cycle_type=1&resource_package_type=7`
    const res = await ctx.fetch(url, {
      Authorization: `Bearer ${key}`,
      Referer: site.referer,
      Accept: 'application/json',
    })
    if (!res.ok) return undefined
    // Shape drift (observed 2026-09): the subscription block used to sit under
    // a `data` envelope, but the live API returns it at the top level. Accept
    // both. Prefer the numeric `*_ts` field over the locale date string.
    const json = (await res.json()) as {
      data?: { current_subscribe?: Record<string, unknown> }
      current_subscribe?: Record<string, unknown>
    }
    const sub = json.data?.current_subscribe ?? json.current_subscribe
    return toEpochMs(sub?.current_subscribe_end_time_ts ?? sub?.current_subscribe_end_time)
  } catch {
    return undefined
  }
}

/** Shared parser: the coding-plan payload is identical on both sites. */
async function parseMinimaxQuota(json: unknown, ctx: ParseContext | undefined, site: MiniMaxSite): Promise<UsageMetric[]> {
  const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN']
  const body = json as { base_resp?: { status_code?: number; status_msg?: string }; model_remains?: unknown[] }
  const base = body.base_resp
  if (!base || typeof base.status_code !== 'number') {
    throw new Error(t.providerErrors.missingField('base_resp'))
  }
  if (base.status_code !== 0) {
    // `status_msg` is the server's own text (data, not our copy); only the
    // synthesized fallbacks render through providerErrors.
    const msg = base.status_msg ?? t.providerErrors.errorCode(base.status_code)
    throw new Error(base.status_code === 1004 || base.status_code === 2049 ? t.providerErrors.keyInvalidWithReason(msg) : msg)
  }
  const rawList = Array.isArray(body.model_remains)
    ? (body.model_remains as Array<Record<string, unknown>>)
    : []
  if (rawList.length === 0) throw new Error(t.providerErrors.noModelRemains)
  const now = Date.now()

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
    throw new Error(t.providerErrors.subscriptionUnparsed)
  }

  if (ctx?.fetch && ctx.key) {
    const expiresAt = await fetchExpiry(ctx, ctx.key, site)
    if (expiresAt) {
      intervals.push({
        id: 'minimax-expiry',
        label: t.provider.planExpiry,
        kind: 'expiry',
        expiresAt,
      })
    }
  }
  return intervals
}

function minimaxDef<Id extends keyof Dict['providers']>(site: MiniMaxSite<Id>): ProviderDef {
  return {
    id: site.id,
    name: site.name,
    accent: 'from-red-500 to-orange-500',
    logo: 'MiniMax-color',
    tagline: (t) => t.providers[site.id].tagline,
    docsUrl: site.docsUrl,
    keyUrl: site.keyUrl,
    buildRequest(key) {
      return {
        url: `${site.baseUrl}/v1/api/openplatform/coding_plan/remains`,
        headers: {
          Authorization: `Bearer ${key}`,
          Referer: site.referer,
          Accept: 'application/json',
        },
      }
    },
    parseResponse: (json, ctx) => parseMinimaxQuota(json, ctx, site),
  }
}

export const minimax = minimaxDef(MINIMAX_SITES.cn)
export const minimaxIntl = minimaxDef(MINIMAX_SITES.intl)
