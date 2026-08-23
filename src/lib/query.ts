import type { ParseContext, ProviderConfig, ProviderDef, ProviderResult } from '../types'
import type { Locale } from '../i18n/types'

export const PROXY_BASE = 'http://127.0.0.1:8787'

/** Probe whether the local proxy is online (required by providers without CORS, e.g. OpenCode Zen) */
export async function pingProxy(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${PROXY_BASE}/ping`, { signal })
    return res.ok
  } catch {
    return false
  }
}

async function requestViaProxyRaw(
  url: string,
  headers: Record<string, string>,
): Promise<{ httpStatus: number; bodyText: string }> {
  const res = await fetch(`${PROXY_BASE}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, headers }),
  })
  if (!res.ok) throw new Error(`本地代理异常（HTTP ${res.status}）`)
  const payload = (await res.json()) as { status: number; body: unknown }
  return { httpStatus: payload.status, bodyText: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body) }
}

async function requestViaProxy(
  url: string,
  headers: Record<string, string>,
): Promise<{ httpStatus: number; json: unknown }> {
  const { httpStatus, bodyText } = await requestViaProxyRaw(url, headers)
  let json: unknown = bodyText
  try {
    json = JSON.parse(bodyText)
  } catch {
    // Keep the raw string for downstream branches to handle
  }
  return { httpStatus, json }
}

async function requestDirect(
  url: string,
  headers: Record<string, string>,
): Promise<{ httpStatus: number; json: unknown }> {
  const res = await fetch(url, { headers })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    // Non-JSON response is left for the status-code branch below
  }
  return { httpStatus: res.status, json }
}

/**
 * Fetch helper for extra requests issued from a provider adapter.
 * Auto-selects direct vs. proxy forwarding based on `def.needsProxy` and the
 * current `proxyOnline` state. Returns a synthetic Response so adapters can
 * uniformly call `.json()` on it.
 */
async function makeCtxFetch(
  def: ProviderDef,
  proxyOnline: boolean,
): Promise<NonNullable<ParseContext['fetch']>> {
  return async (targetUrl: string, targetHeaders: Record<string, string>) => {
    if (def.needsProxy) {
      if (!proxyOnline) throw new Error('本地代理未启动')
      const { httpStatus, bodyText } = await requestViaProxyRaw(targetUrl, targetHeaders)
      return new Response(bodyText, { status: httpStatus, headers: { 'Content-Type': 'application/json' } })
    }
    return fetch(targetUrl, { headers: targetHeaders })
  }
}

export async function fetchUsage(
  def: ProviderDef,
  cfg: ProviderConfig,
  proxyOnline: boolean,
  locale?: Locale,
): Promise<ProviderResult> {
  if (!cfg.apiKey) return { status: 'unconfigured' }
  const { url, headers } = def.buildRequest(cfg.apiKey, cfg.regionId)
  try {
    const viaProxy = def.needsProxy === true
    if (viaProxy && !proxyOnline) return { status: 'needs-proxy' }
    const { httpStatus, json } = await (viaProxy ? requestViaProxy(url, headers) : requestDirect(url, headers))
    if (httpStatus === 401 || httpStatus === 403) {
      return { status: 'error', error: def.id === 'opencode' ? 'Key 无效，或该账号没有 Go 订阅' : 'Key 无效或无权限' }
    }
    if (httpStatus !== 200) {
      return { status: 'error', error: `HTTP ${httpStatus}` }
    }
    const ctxFetch = await makeCtxFetch(def, proxyOnline)
    const metrics = await def.parseResponse(json, {
      regionId: cfg.regionId,
      key: cfg.apiKey,
      fetch: ctxFetch,
      locale,
    })
    return { status: 'ok', metrics, fetchedAt: Date.now() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      status: 'error',
      error: /failed to fetch|networkerror|load failed/i.test(msg) ? '网络请求失败或被拦截' : msg,
    }
  }
}
