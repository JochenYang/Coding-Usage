import type { QuotaOutcome } from './subscription-quotas'
import { readAllowlistedCookies, type CookieReadOptions } from './browser-cookies'

/**
 * Alibaba Cloud console quota probes (Coding Plan, Qwen Cloud, Token Plan).
 *
 * All three read the user's existing console session from the browser and post
 * to the OneConsole RPC the console itself uses. The cookie never leaves this
 * process. When Chrome stores an app-bound (`v20`) cookie, decryption is
 * impossible by design and the card says so instead of reporting no login.
 *
 * Request shapes follow the current console clients: a form body carrying
 * `params` (JSON), `region` and `sec_token`, with the console's own Origin,
 * Referer and CSRF headers. `sec_token` comes from the cookie, then from the
 * dashboard HTML. A missing token is sent as an empty field — the console
 * accepts cookie-only requests in that case.
 */

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

interface Endpoint {
  /** Dashboard page whose HTML may carry sec_token */
  dashboardUrl: string
  /** Host that serves `/data/api.json` for the quota RPC */
  dataHost: string
  action: string
  regionId: string
  language: string
  consoleSite: string
  /** Dashboard host, used to pick same-origin cookies */
  consoleDomain: string
  referer: string
  /** Hosts a cookie is read from. Anything not listed is never read. */
  cookieHosts: string[]
}

const CODING_INTERNATIONAL: Endpoint = {
  dashboardUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan',
  dataHost: 'https://bailian-singapore-cs.alibabacloud.com',
  action: 'IntlBroadScopeAspnGateway',
  regionId: 'ap-southeast-1',
  language: 'en-US',
  consoleSite: 'MODELSTUDIO_ALIBABACLOUD',
  consoleDomain: 'modelstudio.console.alibabacloud.com',
  referer: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan',
  cookieHosts: [
    'modelstudio.console.alibabacloud.com',
    'bailian-singapore-cs.alibabacloud.com',
    'console.alibabacloud.com',
    'passport.alibabacloud.com',
    'alibabacloud.com',
  ],
}

const CODING_CHINA: Endpoint = {
  dashboardUrl: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model',
  dataHost: 'https://bailian-cs.console.aliyun.com',
  action: 'BroadScopeAspnGateway',
  regionId: 'cn-beijing',
  language: 'zh-CN',
  consoleSite: 'BAILIAN_ALIYUN',
  consoleDomain: 'bailian.console.aliyun.com',
  referer: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model',
  cookieHosts: [
    'bailian.console.aliyun.com',
    'bailian-cs.console.aliyun.com',
    'console.aliyun.com',
    'account.aliyun.com',
    'signin.aliyun.com',
    'aliyun.com',
  ],
}

const QWEN_CLOUD: Endpoint = {
  dashboardUrl: 'https://home.qwencloud.com/billing/subscription/token-plan-individual',
  dataHost: 'https://cs-data.qwencloud.com',
  action: 'IntlBroadScopeAspnGateway',
  regionId: 'ap-southeast-1',
  language: 'en-US',
  consoleSite: 'QWENCLOUD',
  consoleDomain: 'home.qwencloud.com',
  referer: 'https://home.qwencloud.com/billing/subscription/token-plan-individual',
  cookieHosts: ['home.qwencloud.com', 'cs-data.qwencloud.com', 'qwencloud.com'],
}

const TOKEN_CHINA: Endpoint = {
  dashboardUrl: 'https://bailian.console.aliyun.com/cn-beijing/?tab=plan',
  dataHost: 'https://bailian-cs.console.aliyun.com',
  action: 'BroadScopeAspnGateway',
  regionId: 'cn-beijing',
  language: 'zh-CN',
  consoleSite: 'BAILIAN_ALIYUN',
  consoleDomain: 'bailian.console.aliyun.com',
  referer: 'https://bailian.console.aliyun.com/cn-beijing/?tab=plan',
  cookieHosts: [
    'bailian.console.aliyun.com',
    'bailian-cs.console.aliyun.com',
    'console.aliyun.com',
    'account.aliyun.com',
    'signin.aliyun.com',
    'aliyun.com',
  ],
}

const CODING_PLAN_API = 'zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2'
const PERSONAL_USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'

export function formEncode(pairs: Array<[string, string]>): string {
  const encode = (value: string): string =>
    encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return pairs.map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&')
}

export function cookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

export function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    return value === '' ? null : value
  }
  return null
}

/** `secToken:"…"`, `sec_token: '…'` and the JSON form, in the dashboard bundle. */
export function secTokenFromHtml(html: string): string | null {
  const patterns = [
    /secToken\s*:\s*"([^"]+)"/,
    /sec_token\s*:\s*"([^"]+)"/,
    /sec_token\s*:\s*'([^']+)'/,
    /"sec_token"\s*:\s*"([^"]+)"/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[1]) return match[1]
  }
  return null
}

function quotaUrl(endpoint: Endpoint, api: string): string {
  const query = new URLSearchParams({ action: endpoint.action, product: 'sfm_bailian', api, _v: 'undefined' })
  return `${endpoint.dataHost}/data/api.json?${query.toString()}`
}

function cornerstone(endpoint: Endpoint, header: string): Record<string, unknown> {
  const param: Record<string, unknown> = {
    feTraceId: globalThis.crypto.randomUUID(),
    feURL: endpoint.dashboardUrl,
    protocol: 'V2',
    console: 'ONE_CONSOLE',
    productCode: 'p_efm',
    domain: endpoint.consoleDomain,
    consoleSite: endpoint.consoleSite,
    userNickName: '',
    userPrincipalName: '',
    xsp_lang: endpoint.language,
  }
  const anonymous = cookieValue(header, 'cna')
  if (anonymous) param['X-Anonymous-Id'] = anonymous
  return param
}

interface RequestOptions {
  api: string
  endpoint: Endpoint
  header: string
  secToken: string
  data: Record<string, unknown>
  /** Coding Plan's RPC also sends the region as its own form field */
  withRegionField?: boolean
}

async function postRpc(fetchImpl: FetchImpl, options: RequestOptions): Promise<Response> {
  const { api, endpoint, header, secToken } = options
  const params = {
    Api: api,
    V: '1.0',
    Data: { ...options.data, cornerstoneParam: cornerstone(endpoint, header) },
  }
  const fields: Array<[string, string]> = options.withRegionField
    ? [
        ['params', JSON.stringify(params)],
        ['region', endpoint.regionId],
        ['sec_token', secToken],
      ]
    : [
        ['product', 'sfm_bailian'],
        ['action', endpoint.action],
        ['sec_token', secToken],
        ['region', endpoint.regionId],
        ['language', endpoint.language],
        ['params', JSON.stringify(params)],
      ]
  const headers: Record<string, string> = {
    Cookie: header,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': USER_AGENT,
    // Origin is the console page the user is on; Referer is that same page.
    // A data-host Origin contradicts the Referer and trips the CSRF check.
    Origin: `https://${endpoint.consoleDomain}`,
    Referer: endpoint.referer,
    'X-Requested-With': 'XMLHttpRequest',
  }
  const csrf = cookieValue(header, 'login_aliyunid_csrf') ?? cookieValue(header, 'csrf')
  if (csrf) {
    headers['x-xsrf-token'] = csrf
    headers['x-csrf-token'] = csrf
  }
  return fetchImpl(quotaUrl(endpoint, api), {
    method: 'POST',
    headers,
    body: formEncode(fields),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
}

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds: anything below 1e12 is a seconds value
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) return parseTime(Number(trimmed))
    // A console wall-clock string without a zone is taken as UTC. Reading it in
    // the machine's zone would shift every reset countdown by the UTC offset.
    const zoned = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed
    const parsed = Date.parse(zoned)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Depth-first objects, so a nested `data` wrapper does not need a fixed path. */
function objects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) objects(item, out)
    return out
  }
  const record = value as Record<string, unknown>
  out.push(record)
  for (const child of Object.values(record)) objects(child, out)
  return out
}

interface QuotaWindow {
  id: 'ali5h' | 'aliWeekly' | 'aliMonthly'
  percent: number
  resetsAt: number | null
}

function windowOf(
  source: Record<string, unknown>,
  id: QuotaWindow['id'],
  usedKeys: string[],
  totalKeys: string[],
  resetKeys: string[],
): QuotaWindow | null {
  let used: number | null = null
  let total: number | null = null
  for (const key of usedKeys) {
    used = finite(source[key])
    if (used != null) break
  }
  for (const key of totalKeys) {
    total = finite(source[key])
    if (total != null) break
  }
  if (used == null || total == null || total <= 0 || used < 0) return null
  let resetsAt: number | null = null
  for (const key of resetKeys) {
    resetsAt = parseTime(source[key])
    if (resetsAt != null) break
  }
  return { id, percent: Math.max(0, Math.min(100, (used / total) * 100)), resetsAt }
}

/**
 * The three quota windows from a OneConsole payload.
 *
 * The Coding Plan answers under `codingPlanQuotaInfo`; the personal token plan
 * uses the same counter names in its usage object. A payload with no usable
 * counter returns null — this never degrades to 0%.
 */
export function windowsFromConsolePayload(payload: unknown): QuotaWindow[] | null {
  const candidates = objects(payload)
  // More than one plan instance means the payload does not identify a single
  // account; reporting the first would be a plausible but wrong percentage.
  const withInfo = candidates.filter(
    (record) => record.codingPlanQuotaInfo && typeof record.codingPlanQuotaInfo === 'object',
  )
  if (withInfo.length > 1) return null
  let source: Record<string, unknown> | null = null
  if (withInfo.length === 1) {
    source = withInfo[0].codingPlanQuotaInfo as Record<string, unknown>
  } else {
    const direct = candidates.filter(
      (record) => 'per5HourUsedQuota' in record || 'perWeekUsedQuota' in record || 'perBillMonthUsedQuota' in record,
    )
    if (direct.length !== 1) return null
    source = direct[0] ?? null
  }
  if (!source) return null
  const windows: QuotaWindow[] = []
  const five = windowOf(
    source,
    'ali5h',
    ['per5HourUsedQuota', 'perFiveHourUsedQuota'],
    ['per5HourTotalQuota', 'perFiveHourTotalQuota'],
    ['per5HourQuotaNextRefreshTime', 'perFiveHourQuotaNextRefreshTime'],
  )
  if (five) windows.push(five)
  const weekly = windowOf(
    source,
    'aliWeekly',
    ['perWeekUsedQuota'],
    ['perWeekTotalQuota'],
    ['perWeekQuotaNextRefreshTime'],
  )
  if (weekly) windows.push(weekly)
  const monthly = windowOf(
    source,
    'aliMonthly',
    ['perBillMonthUsedQuota', 'perMonthUsedQuota'],
    ['perBillMonthTotalQuota', 'perMonthTotalQuota'],
    ['perBillMonthQuotaNextRefreshTime', 'perMonthQuotaNextRefreshTime'],
  )
  if (monthly) windows.push(monthly)
  return windows.length > 0 ? windows : null
}

function planName(payload: unknown): string | null {
  for (const record of objects(payload)) {
    for (const key of ['planName', 'instanceName', 'packageName']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 80)
    }
  }
  return null
}

/** Map the cookie layer's result to a card reason. */
function cookieFailure(reason: string): QuotaOutcome {
  if (reason === 'app-bound') return { available: false, reason: 'cookie-app-bound' }
  if (reason === 'no-match') return { available: false, reason: 'no-auth' }
  if (reason === 'unsupported-platform') return { available: false, reason: 'unsupported-platform' }
  return { available: false, reason: reason === 'empty-allowlist' ? 'no-auth' : 'probe-failed' }
}

/** How much a failure explains: a sealed cookie says more than "no login". */
const REASON_RANK: Record<string, number> = {
  'cookie-app-bound': 5,
  reauth: 4,
  'probe-failed': 3,
  'parse-failed': 3,
  timeout: 3,
  network: 3,
  'unsupported-platform': 2,
  'no-auth': 1,
}

/** Prefer the failure that tells the user the most, keeping the first on a tie. */
function bestReason(primary: QuotaOutcome, secondary: QuotaOutcome): QuotaOutcome {
  if (primary.available) return primary
  if (secondary.available) return secondary
  const a = REASON_RANK[primary.reason ?? ''] ?? 3
  const b = REASON_RANK[secondary.reason ?? ''] ?? 3
  return b > a ? secondary : primary
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

async function fetchConsoleQuota(
  fetchImpl: FetchImpl,
  endpoint: Endpoint,
  api: string,
  data: Record<string, unknown>,
  withRegionField: boolean,
  options?: CookieReadOptions,
): Promise<QuotaOutcome> {
  try {
    const dataHost = hostOf(endpoint.dataHost)
    const dashboardHost = hostOf(endpoint.dashboardUrl)
    // Each request carries only what the browser would send to that host. The
    // dashboard and the data gateway are different origins, so the session
    // cookie is never forwarded from one to the other.
    const apiRead = await readAllowlistedCookies(endpoint.cookieHosts, { ...options, forHost: dataHost })
    if (!apiRead.ok) return cookieFailure(apiRead.reason)
    const header = cookieHeader(apiRead.cookies)
    const dashboardRead =
      dashboardHost === dataHost
        ? apiRead
        : await readAllowlistedCookies(endpoint.cookieHosts, { ...options, forHost: dashboardHost })
    const dashboardHeader = dashboardRead.ok ? cookieHeader(dashboardRead.cookies) : header
    let secToken = cookieValue(header, 'sec_token') ?? cookieValue(dashboardHeader, 'sec_token') ?? ''
    if (!secToken) {
      try {
        const dashboard = await fetchImpl(endpoint.dashboardUrl, {
          // The dashboard is its own origin: it gets the dashboard jar, not the
          // data host's.
          headers: { Cookie: dashboardHeader, 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
          redirect: 'error',
          signal: AbortSignal.timeout(12_000),
        })
        if (dashboard.ok) secToken = secTokenFromHtml(await dashboard.text()) ?? ''
      } catch {
        // A dashboard miss leaves the token empty; the RPC still carries the cookie.
      }
    }
    const res = await postRpc(fetchImpl, { api, endpoint, header, secToken, data, withRegionField })
    if (res.status === 401 || res.status === 403) return { available: false, reason: 'reauth' }
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    const text = await res.text()
    if (text.includes('ConsoleNeedLogin')) return { available: false, reason: 'reauth' }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return { available: false, reason: 'parse-failed' }
    }
    const windows = windowsFromConsolePayload(payload)
    if (!windows) return { available: false, reason: 'parse-failed' }
    return {
      available: true,
      body: JSON.stringify({ plan: planName(payload), windows, topUpCredits: null, stale: false }),
    }
  } catch (error) {
    // Nothing from the failure object is returned: a rejected file write or a
    // fetch error can carry a path or a URL into the renderer.
    return { available: false, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network' }
  }
}

/**
 * Alibaba Cloud Coding Plan. Tries the international console first, then the
 * China mainland one; a rejected session is not retried against the other host,
 * but a sealed or empty intl jar still lets the mainland console answer, and
 * the more explanatory failure wins when both miss.
 */
export async function fetchAlibabaCodingPlanQuota(
  fetchImpl: FetchImpl,
  options?: CookieReadOptions,
): Promise<QuotaOutcome> {
  const data = {
    queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_intl', onlyLatestOne: true },
  }
  const intl = await fetchConsoleQuota(fetchImpl, CODING_INTERNATIONAL, CODING_PLAN_API, data, true, options)
  if (intl.available) return intl
  const cn = await fetchConsoleQuota(
    fetchImpl,
    CODING_CHINA,
    CODING_PLAN_API,
    { queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_cn', onlyLatestOne: true } },
    true,
    options,
  )
  return bestReason(intl, cn)
}

/** Qwen Cloud individual Token Plan (international gateway). */
export function fetchQwenCloudQuota(fetchImpl: FetchImpl, options?: CookieReadOptions): Promise<QuotaOutcome> {
  return fetchConsoleQuota(fetchImpl, QWEN_CLOUD, PERSONAL_USAGE_API, {}, false, options)
}

/** Alibaba Token Plan, personal/Solo windows on the mainland gateway. */
export function fetchAlibabaTokenPlanQuota(fetchImpl: FetchImpl, options?: CookieReadOptions): Promise<QuotaOutcome> {
  return fetchConsoleQuota(fetchImpl, TOKEN_CHINA, PERSONAL_USAGE_API, {}, false, options)
}
