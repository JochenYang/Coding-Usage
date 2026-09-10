import type { ProviderDef, UsageMetric } from '../types'
import { zhCN } from '../i18n/dict.zh-CN'
import { enUS } from '../i18n/dict.en-US'
import type { Locale } from '../i18n/types'

const DICTS = { 'zh-CN': zhCN, 'en-US': enUS } as const

/**
 * Volcengine Ark adapter (Coding Plan / Agent Plan quota).
 *
 * Auth is the raw account's AK/SK, NOT a Bearer inference key — the gateway
 * rejects inference keys with 400 InvalidAuthorization. The `apiKey` field
 * carries both values as "AK:SK" (the settings model has a single key slot);
 * the doc comment documents the convention.
 *
 * Signing follows cc-switch's verified SigV4 variant (Volcengine style):
 * SignedHeaders order host;x-date;x-content-sha256;content-type, algorithm
 * string "HMAC-SHA256", scope suffix "request", kDate = HMAC(SK, date)
 * WITHOUT the "AWS4" prefix. Extraction happens in parseResponse because the
 * signature is async (WebCrypto) — buildRequest only emits a placeholder.
 */

const HOST = 'ark.cn-beijing.volcengineapi.com'
const DEFAULT_REGION = 'cn-beijing'

interface ArkTier {
  Level?: string
  Type?: string
  Period?: string
  Label?: string
  Window?: string
  Percent?: number
  UsedPercent?: number
  UsagePercent?: number
  ResetTimestamp?: number
  ResetTime?: number
}

/** Ark APIs return numeric-ish strings ("123.45"); tolerate real numbers too.
 *  Variadic: returns the first parseable value (mirrors the old maxNum). */
function num(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(key: Uint8Array | ArrayBuffer, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  return new Uint8Array(sig)
}

async function hmacHexString(key: Uint8Array, data: string): Promise<string> {
  const bytes = await hmacHex(key, data)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Fixed SignedHeaders order used by Volcengine's variant */
const SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type'

async function buildArkRequest(
  action: string,
  ak: string,
  sk: string,
  region: string,
  fetchFn: (url: string, headers: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  const now = new Date()
  const amzDate = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}Z`
  const dateStamp = amzDate.slice(0, 8)
  const bodyHash = await sha256Hex('')

  const canonicalQuery = `Action=${action}&Region=${region}&Version=2024-01-01`
  const canonicalHeaders = `host:${HOST}\nx-date:${amzDate}\nx-content-sha256:${bodyHash}\ncontent-type:application/json; charset=utf-8\n`
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${bodyHash}`
  const scope = `${dateStamp}/${region}/ark/request`
  const stringToSign = `HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`

  const kDate = await hmacHex(new TextEncoder().encode(sk), dateStamp)
  const kRegion = await hmacHex(kDate, region)
  const kService = await hmacHex(kRegion, 'ark')
  const kSigning = await hmacHex(kService, 'request')
  const signature = await hmacHexString(kSigning, stringToSign)

  const authorization = `HMAC-SHA256 Credential=${ak}/${dateStamp}/${region}/ark/request, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`

  return fetchFn(`https://${HOST}/?${canonicalQuery}`, {
    'X-Date': amzDate,
    'X-Content-Sha256': bodyHash,
    'Content-Type': 'application/json; charset=utf-8',
    Authorization: authorization,
  } as Record<string, string>)
}

function isAuthError(json: unknown): boolean {
  const code = ((json as { ResponseMetadata?: { Error?: { Code?: string } } })?.ResponseMetadata?.Error?.Code ?? '').toLowerCase()
  return /auth|signature|accessdenied|unauthorized|forbidden|credential|token/.test(code)
}

/** Priority-1 attempt: GetAFPUsage (Agent Plan). Returns metrics when subscribed. */
async function tryAfp(fetchFn: (u: string, h: Record<string, string>) => Promise<Response>, ak: string, sk: string, region: string, t: (typeof zhCN)['windows'], errs: (typeof zhCN)['providerErrors']): Promise<UsageMetric[] | null> {
  const res = await buildArkRequest('GetAFPUsage', ak, sk, region, fetchFn)
  const json = (await res.json().catch(() => ({}))) as {
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } }
    Result?: {
      PlanType?: string
      AFPFiveHour?: { Quota?: number | string; Used?: number | string; ResetTime?: number }
      AFPDaily?: { Quota?: number | string; Used?: number | string; ResetTime?: number }
      AFPWeekly?: { Quota?: number | string; Used?: number | string; ResetTime?: number }
      AFPMonthly?: { Quota?: number | string; Used?: number | string; ResetTime?: number }
    }
  } | null
  if (isAuthError(json)) throw new Error(errs.volcSignature)
  const plan = json?.Result
  if (!plan) return null
  // Not subscribed: every window quota <= 0
  const anyActive = [plan.AFPFiveHour?.Quota, plan.AFPDaily?.Quota, plan.AFPWeekly?.Quota, plan.AFPMonthly?.Quota].some((q) => (num(q) ?? 0) > 0)
  if (!anyActive) return null

  const mk = (
    id: string,
    label: string,
    win: { Quota?: number | string; Used?: number | string; ResetTime?: number } | undefined,
  ): UsageMetric | null => {
    const quota = num(win?.Quota)
    if (!win || quota == null || quota <= 0) return null
    const used = num(win.Used) ?? 0
    return {
      id,
      label,
      kind: 'percent',
      percent: Math.min(100, (used / quota) * 100),
      used,
      total: quota,
      // Per the docs AFP ResetTime is already epoch milliseconds.
      resetsAt: win.ResetTime != null ? win.ResetTime : undefined,
    }
  }
  const out: UsageMetric[] = []
  const five = mk('volc-afp-5h', t.fiveHour, plan.AFPFiveHour)
  if (five) out.push(five)
  // AFPDaily (rolling 1-day window) participates in subscription detection
  // above but is not rendered: the shared windows dict has no label for it
  // (i18n subtree is another agent's scope) and it adds little beyond the
  // 5h/week/month trio for plan monitoring.
  const week = mk('volc-afp-week', t.weeklyPlan ?? '周窗口', plan.AFPWeekly)
  if (week) out.push(week)
  const month = mk('volc-afp-month', t.monthly ?? '月窗口', plan.AFPMonthly)
  if (month) out.push(month)
  return out.length > 0 ? out : null
}

/** Priority-2: GetCodingPlanUsage (Coding Plan). */
async function tryCodingPlan(fetchFn: (u: string, h: Record<string, string>) => Promise<Response>, ak: string, sk: string, region: string, t: (typeof zhCN)['windows'], errs: (typeof zhCN)['providerErrors']): Promise<UsageMetric[]> {
  const res = await buildArkRequest('GetCodingPlanUsage', ak, sk, region, fetchFn)
  const json = (await res.json().catch(() => ({}))) as {
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } }
    Result?: { QuotaUsage?: ArkTier[]; Usages?: ArkTier[]; Details?: ArkTier[] }
  }
  if (isAuthError(json)) throw new Error(errs.volcSignature)
  const tiers: ArkTier[] = json.Result?.QuotaUsage ?? json.Result?.Usages ?? json.Result?.Details ?? []
  const out: UsageMetric[] = []
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]
    // Same string-ified numbers as GetAFPUsage — reuse num().
    const pct = Math.min(100, Math.max(0, num(tier.Percent, tier.UsedPercent, tier.UsagePercent) ?? 0))
    const level = String(tier.Level ?? tier.Type ?? tier.Period ?? tier.Label ?? tier.Window ?? '').toLowerCase()
    const label =
      level.includes('session') || level.includes('5h') ? t.fiveHour : level.includes('weekly') ? t.weeklyPlan ?? '周窗口' : level.includes('monthly') ? t.monthly ?? '月窗口' : tier.Level ?? t.planQuota
    const reset = num(tier.ResetTimestamp, tier.ResetTime)
    out.push({
      id: `volc-cp-${i}`,
      label,
      kind: 'percent',
      percent: pct,
      resetsAt: reset != null ? (reset < 1e12 ? reset * 1000 : reset) : undefined,
    })
  }
  if (out.length === 0) throw new Error(errs.volcNoWindows)
  return out
}

export const volcengine: ProviderDef = {
  id: 'volcengine',
  name: 'Volcengine Ark',
  accent: 'from-blue-500 to-indigo-600',
  logo: 'volcengine-ark',
  logoLetter: 'V',
  tagline: (t) => t.providers.volcengine.tagline,
  regions: [
    { id: 'cn-beijing', label: 'cn-beijing', baseUrl: 'https://ark.cn-beijing.volcengineapi.com' },
  ],
  docsUrl: 'https://www.volcengine.com/docs/82379/1540833',
  keyUrl: 'https://console.volcengine.com/iam/keymanage/',
  buildRequest() {
    // Actual request is issued inside parseResponse (async SigV4 signing);
    // this placeholder only satisfies the transport contract.
    return { url: `https://${HOST}/`, headers: {} }
  },
  skipPreflight: true,
  async parseResponse(_json, ctx) {
    const fetchFn = ctx?.fetch
    if (!fetchFn) return []
    const vErrors = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN'].providerErrors
    // apiKey slot carries "AK:SK" (see module docstring)
    const raw = (ctx?.key ?? '').trim()
    const sep = raw.indexOf(':')
    if (sep <= 0) throw new Error(vErrors.volcCredFormat)
    const ak = raw.slice(0, sep)
    const sk = raw.slice(sep + 1)
    const region = DEFAULT_REGION
    const t = DICTS[(ctx?.locale as Locale | undefined) ?? 'zh-CN'].windows

    const afp = await tryAfp(fetchFn, ak, sk, region, t, vErrors)
    if (afp && afp.length > 0) return afp
    return tryCodingPlan(fetchFn, ak, sk, region, t, vErrors)
  },
}
