import type { ParseContext, ProviderConfig, ProviderDef, ProviderResult } from '../types'
import type { Locale } from '../i18n/types'

const bridge = window.desktopBridge

/**
 * Transport shared by every provider request. Under Electron it routes through
 * the main process (`net.fetch`, not subject to CORS); in the browser it uses
 * plain fetch. Returns null when the request could not be completed at all.
 */
async function transportFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown } | null> {
  if (bridge) {
    try {
      const r = await bridge.fetch(url, headers)
      let json: unknown = null
      try {
        json = JSON.parse(r.body)
      } catch {
        // Non-JSON response body
      }
      return { status: r.status, json }
    } catch {
      return null
    }
  }
  try {
    const res = await fetch(url, { headers })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // Non-JSON response body
    }
    return { status: res.status, json }
  } catch {
    return null
  }
}

/**
 * Fetch helper for extra requests issued from a provider adapter.
 * Goes through the shared transport (main-process under Electron), then wraps
 * the outcome in a synthetic Response so adapters can uniformly call `.json()`.
 */
async function makeCtxFetch(): Promise<NonNullable<ParseContext['fetch']>> {
  return async (targetUrl: string, targetHeaders: Record<string, string>) => {
    const r = await transportFetch(targetUrl, targetHeaders)
    // No usable response at all (status 0 is the bridge's failure marker):
    // surface as a thrown error so the adapter's own try/catch treats it as a
    // soft failure, exactly like a failed native fetch did before.
    if (!r || r.status === 0) {
      throw new Error('network request failed')
    }
    return new Response(JSON.stringify(r.json), { status: r.status })
  }
}

export async function fetchUsage(
  def: ProviderDef,
  cfg: ProviderConfig,
  locale?: Locale,
): Promise<ProviderResult> {
  if (!cfg.apiKey) return { status: 'unconfigured' }
  const { url, headers } = def.buildRequest(cfg.apiKey, cfg.regionId)
  // Adapters with skipPreflight sign asynchronously inside parseResponse —
  // their buildRequest URL is a placeholder, so no transport preflight runs
  // and "no result" is the expected path INTO parseResponse, not an error.
  const skipPreflight = def.skipPreflight === true
  try {
    // Preflight payload feeds parseResponse. Adapters with skipPreflight sign
    // asynchronously inside parseResponse — their buildRequest URL is a
    // placeholder, so no transport preflight runs and an empty payload is the
    // expected input there, not an error.
    let preflightJson: unknown = {}
    if (!skipPreflight) {
      // Try direct fetch first. If it fails (CORS), fall back to corsproxy.io —
      // browser path only: under Electron the main-process fetch has no CORS
      // restrictions and third-party proxies are not allowed.
      let result = await tryFetch(url, headers)
      if (!result && !bridge) {
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
      preflightJson = json
    }
    const ctxFetch = await makeCtxFetch()
    const metrics = await def.parseResponse(preflightJson, {
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
      error: /failed to fetch|networkerror|network request failed|load failed/i.test(msg)
        ? '网络请求失败或被拦截'
        : msg,
    }
  }
}

/** Shared-transport fetch; returns null on CORS / network error. */
async function tryFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{ httpStatus: number; json: unknown } | null> {
  const r = await transportFetch(url, headers)
  return r ? { httpStatus: r.status, json: r.json } : null
}
