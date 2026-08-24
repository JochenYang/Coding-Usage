import type { ParseContext, ProviderConfig, ProviderDef, ProviderResult } from '../types'
import type { Locale } from '../i18n/types'

/**
 * Fetch helper for extra requests issued from a provider adapter.
 * Returns a synthetic Response so adapters can uniformly call `.json()` on it.
 */
async function makeCtxFetch(): Promise<NonNullable<ParseContext['fetch']>> {
  return async (targetUrl: string, targetHeaders: Record<string, string>) => {
    return fetch(targetUrl, { headers: targetHeaders })
  }
}

export async function fetchUsage(
  def: ProviderDef,
  cfg: ProviderConfig,
  locale?: Locale,
): Promise<ProviderResult> {
  if (!cfg.apiKey) return { status: 'unconfigured' }
  const { url, headers } = def.buildRequest(cfg.apiKey, cfg.regionId)
  try {
    // Try direct fetch first. If it fails (CORS), fall back to corsproxy.io.
    let result = await tryFetch(url, headers)
    if (!result) {
      result = await tryFetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, headers)
    }
    if (!result) {
      return { status: 'error', error: '网络请求失败（跨域或网络不可达）' }
    }
    const { httpStatus, json } = result
    if (httpStatus === 401 || httpStatus === 403) {
      return { status: 'error', error: def.id === 'opencode' ? 'Key 无效，或该账号没有 Go 订阅' : 'Key 无效或无权限' }
    }
    if (httpStatus !== 200) {
      return { status: 'error', error: `HTTP ${httpStatus}` }
    }
    if (json == null || typeof json !== 'object') {
      return { status: 'error', error: '响应格式异常：空响应或非 JSON' }
    }
    const ctxFetch = await makeCtxFetch()
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

/** Direct fetch, returns null on CORS / network error. */
async function tryFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{ httpStatus: number; json: unknown } | null> {
  try {
    const res = await fetch(url, { headers })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // Non-JSON response
    }
    return { httpStatus: res.status, json }
  } catch {
    return null
  }
}