import type { QuotaOutcome } from './subscription-quotas'
import { readAllowlistedCookies, type CookieReadOptions } from './browser-cookies'
import { isTimeoutError } from './fetch-errors'

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
    // Origin and Referer are both the console origin. Chromium rejects a
    // Referer carrying a path or query on a cross-origin request
    // (ERR_BLOCKED_BY_CLIENT, "invalid referrer"), so the request would never
    // leave the app; a data-host Origin would also contradict the page.
    Origin: `https://${endpoint.consoleDomain}`,
    Referer: `https://${endpoint.consoleDomain}/`,
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
  // Reasons a source can report directly (the in-app session does this).
  if (reason === 'no-auth' || reason === 'reauth' || reason === 'probe-failed' || reason === 'timeout') {
    return { available: false, reason }
  }
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

/** Top-level key names of a payload, for a failure detail that names no values. */
function topLevelKeys(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'none'
  return Object.keys(payload).slice(0, 8).join(',') || 'none'
}

/**
 * The OneConsole envelope (`code`, `data`, `httpStatusCode`, `successResponse`)
 * in one short line. Values here are status codes and counts only — never
 * account data — so the card can explain itself without a log file.
 */
function envelopeSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'envelope=none'
  const body = payload as Record<string, unknown>
  const parts: string[] = []
  if ('code' in body) parts.push(`code=${String(body.code).slice(0, 12)}`)
  if ('httpStatusCode' in body) parts.push(`status=${String(body.httpStatusCode).slice(0, 6)}`)
  if ('successResponse' in body) parts.push(`success=${String(body.successResponse)}`)
  const data = body.data
  if (data == null) parts.push('data=null')
  else if (Array.isArray(data)) parts.push(`data=array(${data.length})`)
  else if (typeof data === 'object') {
    // Shapes, not values — EXCEPT the gateway's own error/status fields
    // (ret / errorNo / errorCode / errorMsg), whose values are status text
    // and the one thing that decides the fix. Account-data keys still print
    // types only. A nested object prints its scalar members under the same
    // rule, so `DataV2{ret:-1}` says exactly why the call failed.
    const valueOf = (key: string, value: unknown): string => {
      if (/^(error(No|Code|Msg|Message)?|ret)$/i.test(key) && typeof value === 'string' && value.trim() !== '') {
        return value.trim().slice(0, 60)
      }
      if (/^ret$/i.test(key) && typeof value === 'number') return String(value)
      return typeof value
    }
    const entries = Object.entries(data as Record<string, unknown>)
      .slice(0, 6)
      .map(([key, value]) => {
        if (Array.isArray(value)) return `${key}[${value.length}]`
        if (value === null) return `${key}=null`
        if (typeof value === 'object') {
          const inner = Object.entries(value as Record<string, unknown>)
            .slice(0, 8)
            .map(([ik, iv]) => `${ik}:${valueOf(ik, iv)}`)
            .join(', ')
          return `${key}{${inner || '-'}}`
        }
        return `${key}=${valueOf(key, value)}`
      })
    parts.push(`dataKeys=${entries.join('|') || '-'}`)
  } else parts.push(`data=${typeof data}`)
  return parts.join(' ')
}

/** The console answered successfully, even if it carried nothing. */
function isSuccessEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const body = payload as Record<string, unknown>
  if (body.successResponse === true) return true
  return body.code === 200 || body.code === '200'
}

/** Keys inside `data` that carry a status, not a payload. */
const STATUS_KEYS = new Set([
  'success',
  'httpStatus',
  'httpStatusCode',
  'errorCode',
  'errorMessage',
  'code',
  'message',
  'requestId',
])

/**
 * What `data` actually carries.
 *
 * A signed-in account with no subscription answers `success` with a `data`
 * object that holds nothing but status fields (`success`, `httpStatus`,
 * `errorCode`). That is a real answer, not a shape we failed to parse. A
 * non-empty `errorCode` still means something went wrong, so it is reported
 * separately rather than as "no plan".
 */
function dataStatus(payload: unknown): {
  onlyStatus: boolean
  /** DataV2.data answered success:true with no counters — the token-plan empty form */
  dataSuccess: boolean
  errorCode: string | null
  errorMsg: string | null
  errorNo: string | null
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { onlyStatus: false, dataSuccess: false, errorCode: null, errorMsg: null, errorNo: null }
  }
  const data = (payload as Record<string, unknown>).data
  if (data == null) return { onlyStatus: true, dataSuccess: false, errorCode: null, errorMsg: null, errorNo: null }
  if (Array.isArray(data)) {
    return { onlyStatus: data.length === 0, dataSuccess: false, errorCode: null, errorMsg: null, errorNo: null }
  }
  if (typeof data !== 'object') {
    return { onlyStatus: false, dataSuccess: false, errorCode: null, errorMsg: null, errorNo: null }
  }
  const keys = Object.keys(data)
  const onlyStatus = keys.length === 0 || keys.every((key) => STATUS_KEYS.has(key))
  const record = data as Record<string, unknown>
  // The token-plan empty form: DataV2.data answers success:true and carries
  // msg/requestId but no counters (verified live 2026-11-21, see schemaDump).
  const dataV2 = record.DataV2
  const dataV2Inner = dataV2 && typeof dataV2 === 'object' && !Array.isArray(dataV2) ? (dataV2 as Record<string, unknown>).data : undefined
  const dataSuccess =
    !!dataV2Inner &&
    typeof dataV2Inner === 'object' &&
    (dataV2Inner as Record<string, unknown>).success === true
  const code = record.errorCode
  const message = record.errorMsg ?? record.errorMessage
  const no = record.errorNo
  const errorCode = typeof code === 'string' && code.trim() !== '' ? code.trim().slice(0, 64) : null
  // Gateway error messages are status text ("User not login" and the like) —
  // the one value in this envelope that is safe and decisive to surface.
  const errorMsg = typeof message === 'string' && message.trim() !== '' ? message.trim().slice(0, 120) : null
  const errorNo =
    typeof no === 'string' && no.trim() !== '' ? no.trim().slice(0, 32) : typeof no === 'number' ? String(no) : null
  return { onlyStatus, dataSuccess, errorCode, errorMsg, errorNo }
}

/**
 * Full key-path dump of a response tree, for a parse failure that the top-level
 * shape lines cannot explain. Key paths + scalar types only — EXCEPT
 * ret / errorNo / errorCode / errorMsg, whose values are gateway status text
 * and the one thing that decides the fix. Depth- and length-capped.
 */
function schemaDump(payload: unknown): string {
  const out: string[] = []
  const visit = (node: unknown, path: string, depth: number): void => {
    if (out.length >= 48 || depth > 5) return
    if (Array.isArray(node)) {
      // Arrays: sample the first element — a one-element sample names the shape
      if (node.length > 0) visit(node[0], `${path}[0]`, depth + 1)
      else out.push(`${path}[]`)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (out.length >= 48) return
        const next = path ? `${path}.${key}` : key
        if (child !== null && typeof child === 'object') visit(child, next, depth + 1)
        else {
          const decisive = /^(ret|errorNo|errorCode|errorMsg|msg|httpStatus)$/i.test(key)
          const shown =
            decisive && (typeof child === 'string' || typeof child === 'number')
              ? `=${String(child).slice(0, 48)}`
              : ''
          out.push(`${next}:${typeof child}${shown}`)
        }
      }
      return
    }
    out.push(`${path}:${typeof node}`)
  }
  visit(payload, '', 0)
  return out.join(' ')
}

/** `secToken` / `sec_token` anywhere in a small JSON tree. */
function findSecToken(value: unknown, depth = 0): string | null {
  if (depth > 6 || !value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecToken(item, depth + 1)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of ['secToken', 'sec_token']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  for (const child of Object.values(record)) {
    const found = findSecToken(child, depth + 1)
    if (found) return found
  }
  return null
}

/** The console's own user-info endpoint, which publishes the RPC token. */
async function secTokenFromUserInfo(
  fetchImpl: FetchImpl,
  endpoint: Endpoint,
  header: string,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://${endpoint.consoleDomain}/tool/user/info.json`, {
      headers: {
        Cookie: header,
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        Referer: `https://${endpoint.consoleDomain}/`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(await res.text())
    } catch {
      return null
    }
    return findSecToken(parsed)
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export type CookieSourceResult =
  | { ok: true; header: string; detail?: string }
  | { ok: false; reason: string; detail?: string }

function isCookieSourceOk(
  result: CookieSourceResult,
): result is { ok: true; header: string; detail?: string } {
  return result.ok
}

/**
 * Where a probe gets its cookie header. The Electron console session is the
 * default in the app; tests and non-Electron callers fall back to reading the
 * browser's store.
 */
export type ConsoleCookieSource = (requestUrl: string) => Promise<CookieSourceResult>

export interface AliyunProbeOptions extends CookieReadOptions {
  /** Overrides the browser-store reader (the app injects its own session). */
  cookieSource?: ConsoleCookieSource
}

async function browserCookieSource(
  hosts: string[],
  requestUrl: string,
  options?: CookieReadOptions,
): Promise<
  | { ok: true; header: string; detail?: string }
  | { ok: false; reason: string; detail?: string }
> {
  const read = await readAllowlistedCookies(hosts, { ...options, forHost: hostOf(requestUrl) })
  const detail = read.ok
    ? `browser-cookies=${read.cookies.length}`
    : `browser-cookies=${read.reason}`
  return read.ok
    ? { ok: true, header: cookieHeader(read.cookies), detail }
    : { ok: false, reason: read.reason, detail }
}
async function fetchConsoleQuota(
  fetchImpl: FetchImpl,
  endpoint: Endpoint,
  api: string,
  data: Record<string, unknown>,
  withRegionField: boolean,
  options?: AliyunProbeOptions,
): Promise<QuotaOutcome> {
  try {
    const dataHost = hostOf(endpoint.dataHost)
    const dashboardHost = hostOf(endpoint.dashboardUrl)
    const source: ConsoleCookieSource =
      options?.cookieSource ?? ((url: string) => browserCookieSource(endpoint.cookieHosts, url, options))
    // Each request carries only what its own origin would send. The dashboard
    // and the data gateway are different origins, so the session cookie is
    // never forwarded from one to the other.
    const apiRead = await source(`${endpoint.dataHost}/data/api.json`)
    if (!apiRead.ok) return { ...cookieFailure(apiRead.reason), detail: apiRead.detail }
    const header = apiRead.header
    const dashboardRead: CookieSourceResult =
      dashboardHost === dataHost ? apiRead : await source(endpoint.dashboardUrl)
    // A type guard rather than a discriminant read: the two branches of the
    // expression above widen `.ok` to `boolean`.
    const secJar = isCookieSourceOk(dashboardRead) ? dashboardRead.header : null
    let secToken = cookieValue(header, 'sec_token') ?? ''
    let secFrom = secToken ? 'cookie' : 'none'
    if (!secToken && secJar) {
      secToken = cookieValue(secJar, 'sec_token') ?? ''
      if (secToken) secFrom = 'cookie'
    }
    // Only talk to the dashboard when its own jar exists. Sending the data
    // host's jar to the dashboard would hand the session cookie to a third
    // origin.
    if (!secToken && secJar) {
      try {
        const dashboardHeaders: Record<string, string> = {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          Referer: `https://${endpoint.consoleDomain}/`,
        }
        dashboardHeaders.Cookie = secJar
        const dashboard = await fetchImpl(endpoint.dashboardUrl, {
          headers: dashboardHeaders,
          signal: AbortSignal.timeout(12_000),
        })
        if (dashboard.ok) {
          const fromHtml = secTokenFromHtml(await dashboard.text())
          if (fromHtml) {
            secToken = fromHtml
            secFrom = 'html'
          }
        }
      } catch {
        // A dashboard miss leaves the token empty; the RPC still carries the cookie.
      }
    }
    // The console also publishes the token on its own user-info endpoint. This
    // is the reliable source: the HTML may be a shell with the token injected
    // later, which is why the dashboard scrape came back empty on a signed-in
    // session.
    if (!secToken && secJar) {
      const fromUserInfo = await secTokenFromUserInfo(fetchImpl, endpoint, secJar)
      if (fromUserInfo) {
        secToken = fromUserInfo
        secFrom = 'userinfo'
      }
    }
    // `sec` is the OneConsole security token the RPC requires; whether we found
    // one is the difference between "not logged in" and "logged in but the
    // token was not handed over".
    const trace = `${apiRead.detail ?? ''} sec=${secToken ? `yes:${secFrom}` : 'no'}`
    const res = await postRpc(fetchImpl, { api, endpoint, header, secToken, data, withRegionField })
    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: 'reauth', detail: `http-${res.status} ${trace}`.trim() }
    }
    if (!res.ok) return { available: false, reason: `http-${res.status}`, detail: trace }
    const text = await res.text()
    if (text.includes('ConsoleNeedLogin')) return { available: false, reason: 'reauth', detail: `need-login ${trace}`.trim() }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return { available: false, reason: 'parse-failed', detail: `not-json bytes=${text.length} ${trace}`.trim() }
    }
    const windows = windowsFromConsolePayload(payload)
    if (!windows) {
      const keys = topLevelKeys(payload)
      const envelope = envelopeSummary(payload)
      const shape = dataStatus(payload)
      // A successful envelope whose data holds only status fields is the honest
      // "this account has no plan" answer. So is the token-plan empty form: an
      // envelope whose DataV2.data answers success:true with msg/requestId and
      // no counters (verified live 2026-11-21). A real error code or an
      // unexpected shape stays a failure, so nothing is reported as a business
      // fact unless the response says so.
      if (isSuccessEnvelope(payload) && !shape.errorCode && (shape.onlyStatus || shape.dataSuccess)) {
        return { available: false, reason: 'no-plan', detail: `${envelope} ${trace}`.trim() }
      }
      const errorFields = [
        shape.errorCode ? `errorCode=${shape.errorCode}` : '',
        shape.errorNo ? `errorNo=${shape.errorNo}` : '',
        shape.errorMsg ? `errorMsg=${shape.errorMsg}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      return {
        available: false,
        reason: 'parse-failed',
        detail: `no-window keys=${keys} ${envelope}${errorFields ? ` ${errorFields}` : ''} schema=${schemaDump(payload)} ${trace}`.trim(),
      }
    }
    return {
      available: true,
      body: JSON.stringify({ plan: planName(payload), windows, topUpCredits: null, stale: false }),
    }
  } catch (error) {
    // Nothing from the failure object is returned: a rejected file write or a
    // fetch error can carry a path or a URL into the renderer.
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}

/**
 * Replay a request the user pasted from the console's own Network panel.
 *
 * This exists because a reconstructed request is rejected: the console's
 * session token lives in page runtime state, so only its own request carries
 * everything the gateway wants.
 */
export async function fetchPastedQuota(
  fetchImpl: FetchImpl,
  request: { url: string; method: string; headers: Record<string, string>; body: string },
): Promise<QuotaOutcome> {
  const trace = `pasted ${request.method}`
  try {
    const res = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' ? undefined : request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: 'reauth', detail: `http-${res.status} ${trace}` }
    }
    if (!res.ok) return { available: false, reason: `http-${res.status}`, detail: trace }
    const text = await res.text()
    if (text.includes('ConsoleNeedLogin') || text.includes('Login.NotLogined')) {
      return { available: false, reason: 'reauth', detail: `need-login ${trace}` }
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return { available: false, reason: 'parse-failed', detail: `not-json bytes=${text.length} ${trace}` }
    }
    const windows = windowsFromConsolePayload(payload)
    if (!windows) {
      const shape = dataStatus(payload)
      if (isSuccessEnvelope(payload) && !shape.errorCode && (shape.onlyStatus || shape.dataSuccess)) {
        return { available: false, reason: 'no-plan', detail: `${envelopeSummary(payload)} ${trace}` }
      }
      return {
        available: false,
        reason: 'parse-failed',
        detail: `no-window ${envelopeSummary(payload)}${shape.errorCode ? ` errorCode=${shape.errorCode}` : ''} ${trace}`,
      }
    }
    return {
      available: true,
      body: JSON.stringify({ plan: planName(payload), windows, topUpCredits: null, stale: false }),
      detail: trace,
    }
  } catch (error) {
    return { available: false, reason: isTimeoutError(error) ? 'timeout' : 'network', detail: trace }
  }
}

/**
 * Alibaba Cloud Coding Plan. The China mainland console is tried first: this
 * build targets a Chinese install, and the international host has no session
 * for a mainland login, so leading with it reported "not logged in" while the
 * mainland console would have answered.
 */
export async function fetchAlibabaCodingPlanQuota(
  fetchImpl: FetchImpl,
  options?: AliyunProbeOptions,
): Promise<QuotaOutcome> {
  const cn = await fetchConsoleQuota(
    fetchImpl,
    CODING_CHINA,
    CODING_PLAN_API,
    { queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_cn', onlyLatestOne: true } },
    true,
    options,
  )
  if (cn.available) return cn
  const intl = await fetchConsoleQuota(
    fetchImpl,
    CODING_INTERNATIONAL,
    CODING_PLAN_API,
    { queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_intl', onlyLatestOne: true } },
    true,
    options,
  )
  return bestReason(cn, intl)
}

/** Qwen Cloud individual Token Plan (international gateway). */
export function fetchQwenCloudQuota(fetchImpl: FetchImpl, options?: AliyunProbeOptions): Promise<QuotaOutcome> {
  return fetchConsoleQuota(fetchImpl, QWEN_CLOUD, PERSONAL_USAGE_API, {}, false, options)
}

/** Alibaba Token Plan, personal/Solo windows on the mainland gateway. */
export function fetchAlibabaTokenPlanQuota(fetchImpl: FetchImpl, options?: AliyunProbeOptions): Promise<QuotaOutcome> {
  return fetchConsoleQuota(fetchImpl, TOKEN_CHINA, PERSONAL_USAGE_API, {}, false, options)
}
