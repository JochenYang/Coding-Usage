import type { AgentModelListResult } from '../src/lib/agent-config'

/**
 * Ask a provider which models it serves.
 *
 * Nothing about this is uniform across the providers the two agents talk to:
 * OpenAI-compatible gateways answer `GET {base}/models` with `{data:[…]}`,
 * Anthropic answers the same shape but authenticates with `x-api-key` instead
 * of a bearer token, and a base URL may or may not already carry the `/v1`
 * segment. Rather than guess once, this walks a short candidate list and keeps
 * the first answer that parses — the URL that worked is reported back so the UI
 * can show what was actually queried.
 */

/** Anthropic-style endpoints take `x-api-key`; everything else a bearer token */
function isAnthropicProtocol(protocol: string): boolean {
  return protocol === 'anthropic' || protocol === 'anthropic-messages'
}

interface AuthStyle {
  headers: Record<string, string>
}

/**
 * Ways of presenting the credential, most likely first.
 *
 * The declared protocol is only a hint: a gateway can speak Anthropic's message
 * format on its chat endpoint and still authenticate its model list with a
 * bearer token (stepfun's `step_plan` does exactly that). Both styles are
 * therefore attempted, ordered by what the protocol suggests.
 */
function authStyles(apiKey: string, protocol: string): AuthStyle[] {
  const anthropicStyle: AuthStyle = {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  }
  const bearerStyle: AuthStyle = { headers: { Authorization: `Bearer ${apiKey}` } }
  return isAnthropicProtocol(protocol) ? [anthropicStyle, bearerStyle] : [bearerStyle, anthropicStyle]
}

/**
 * URLs worth trying, most specific first.
 *
 * A base that already ends in a version segment (`…/v1`) only gets `/models`
 * appended; otherwise `/models` is tried before `/v1/models` because gateways
 * such as DeepSeek accept both while some proxies only implement the former.
 */
function candidateModelUrls(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return []
  if (/\/v\d+$/i.test(base)) return [`${base}/models`]
  return [`${base}/models`, `${base}/v1/models`]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Pull model ids out of the shapes the common gateways return */
function extractModelIds(payload: unknown): string[] {
  const ids = new Set<string>()
  const push = (entry: unknown): void => {
    if (typeof entry === 'string') {
      if (entry.trim()) ids.add(entry.trim())
      return
    }
    const record = asRecord(entry)
    if (!record) return
    for (const key of ['id', 'name', 'model', 'model_name']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        ids.add(value.trim())
        return
      }
    }
  }

  if (Array.isArray(payload)) payload.forEach(push)
  else {
    const record = asRecord(payload)
    if (record) {
      for (const key of ['data', 'models', 'result', 'items']) {
        const list = record[key]
        if (Array.isArray(list)) list.forEach(push)
      }
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

/** Strip anything that looks like a credential before a message reaches the UI */
export function sanitize(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***').replace(/[A-Za-z0-9_-]{40,}/g, '***').slice(0, 300)
}

/** Read an error message out of a gateway's error envelope */
export function errorDetail(payload: unknown, status: number): string {
  const record = asRecord(payload)
  const error = asRecord(record?.error)
  const message =
    (typeof error?.message === 'string' && error.message) ||
    (typeof record?.message === 'string' && record.message) ||
    (typeof record?.error === 'string' && record.error) ||
    ''
  return message ? sanitize(message) : `HTTP ${status}`
}

/**
 * Query one provider for its model list.
 *
 * Requests run in the main process, so there is no CORS preflight and the
 * credential never leaves this machine — it is placed in a header, used, and
 * dropped. A failure to reach any candidate resolves with `ok:false` rather
 * than throwing: a provider that does not expose a model list is a normal
 * situation, not an error condition.
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  protocol: string,
): Promise<AgentModelListResult> {
  const urls = candidateModelUrls(baseUrl)
  if (urls.length === 0) return { ok: false, message: 'no base url configured' }
  if (!apiKey) return { ok: false, message: 'provider has no stored credential' }

  // Imported lazily so this module can be loaded outside Electron — the
  // verification harness exercises the rest of the feature under plain Node.
  const { net } = await import('electron')
  const styles = authStyles(apiKey, protocol)

  let lastMessage = 'request failed'
  for (const url of urls) {
    for (const style of styles) {
      try {
        const response = await net.fetch(url, {
          method: 'GET',
          headers: style.headers,
          redirect: 'error',
          signal: AbortSignal.timeout(12_000),
        })
        const text = await response.text()
        if (!response.ok) {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(text)
          } catch {
            // non-JSON error body: the status alone is the useful part
          }
          lastMessage = errorDetail(parsed, response.status)
          // A 404 says the path is wrong, not the credential, so the remaining
          // auth styles would only repeat the same miss — move to the next URL.
          // Anything else (401/403/…) is worth retrying with the other style.
          if (response.status === 404) break
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          lastMessage = 'response was not JSON'
          continue
        }
        const models = extractModelIds(parsed)
        if (models.length === 0) {
          lastMessage = 'no models in the response'
          continue
        }
        return { ok: true, models, usedUrl: url }
      } catch (e) {
        const name = e instanceof Error ? e.name : ''
        lastMessage =
          name === 'TimeoutError'
            ? 'request timed out'
            : sanitize(e instanceof Error ? e.message : String(e))
        // The endpoint is unreachable, so the other auth style cannot help.
        break
      }
    }
  }
  return { ok: false, message: lastMessage }
}
