import { errorDetail, sanitize } from './agent-model-list'
import type { AgentModelTestResult } from '../src/lib/agent-config'

/**
 * Send one minimal request through a configured model to see whether it answers.
 *
 * This is a live call, not a configuration check — it is only ever issued on an
 * explicit click, and it costs a handful of tokens. The request is deliberately
 * the smallest thing the protocol allows, because the question being answered is
 * "does this model respond at all", not "is it good".
 *
 * Endpoint shape is not uniform, so the same walking strategy the model list
 * uses applies here: a short candidate list of paths combined with both
 * credential styles, stopping at the first attempt that gets a response.
 */

/** One request the probe may issue, in the order worth trying */
interface Attempt {
  url: string
  headers: Record<string, string>
  body: string
}

/** Long enough for a slow gateway, short enough not to feel hung */
const TIMEOUT_MS = 20_000

/** Output budget per probe — enough that a reasoning model is not rejected outright */
const MAX_OUTPUT_TOKENS = 16

function isAnthropic(protocol: string): boolean {
  return protocol === 'anthropic' || protocol === 'anthropic-messages'
}

function isResponses(protocol: string): boolean {
  return protocol === 'openai_responses' || protocol === 'openai-responses'
}

/**
 * Candidate requests, most likely first.
 *
 * A base URL may or may not already carry its version segment, and a gateway
 * may authenticate with either style regardless of the message format it
 * speaks, so both axes are walked.
 */
function buildAttempts(
  baseUrl: string,
  apiKey: string,
  protocol: string,
  modelId: string,
): Attempt[] {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return []
  const versioned = /\/v\d+$/i.test(base)
  const anthropic = isAnthropic(protocol)
  const responses = isResponses(protocol)

  const paths = anthropic
    ? versioned
      ? ['/messages']
      : ['/v1/messages', '/messages']
    : responses
      ? versioned
        ? ['/responses']
        : ['/v1/responses', '/responses']
      : versioned
        ? ['/chat/completions']
        : ['/v1/chat/completions', '/chat/completions']

  const payload = anthropic
    ? { model: modelId, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: 'ping' }] }
    : responses
      ? { model: modelId, input: 'ping', max_output_tokens: MAX_OUTPUT_TOKENS }
      : {
          model: modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: MAX_OUTPUT_TOKENS,
        }
  const body = JSON.stringify(payload)

  const jsonHeaders = { 'content-type': 'application/json' }
  const credentialHeaders: Record<string, string>[] = anthropic
    ? [
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...jsonHeaders },
        { Authorization: `Bearer ${apiKey}`, ...jsonHeaders },
      ]
    : [
        { Authorization: `Bearer ${apiKey}`, ...jsonHeaders },
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...jsonHeaders },
      ]

  const attempts: Attempt[] = []
  for (const path of paths) {
    for (const headers of credentialHeaders) {
      attempts.push({ url: `${base}${path}`, headers, body })
    }
  }
  return attempts
}

/**
 * Probe one model.
 *
 * A 2xx counts as working regardless of what came back — a truncated or empty
 * completion still proves the credential, the endpoint and the model id are all
 * accepted. Anything else is a failure, and the gateway's own wording is
 * surfaced (scrubbed of anything credential-shaped) because it is usually the
 * most actionable thing available.
 */
export async function testProviderModel(
  baseUrl: string,
  apiKey: string,
  protocol: string,
  modelId: string,
): Promise<AgentModelTestResult> {
  const attempts = buildAttempts(baseUrl, apiKey, protocol, modelId)
  if (attempts.length === 0) return { ok: false, message: 'no base url configured' }
  if (!apiKey) return { ok: false, message: 'provider has no stored credential' }

  const { net } = await import('electron')
  const started = Date.now()
  let lastMessage = 'request failed'
  let lastStatus: number | undefined

  for (const attempt of attempts) {
    try {
      const response = await net.fetch(attempt.url, {
        method: 'POST',
        headers: attempt.headers,
        body: attempt.body,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await response.text()
      if (response.ok) {
        return { ok: true, ms: Date.now() - started, status: response.status, message: attempt.url }
      }
      let parsed: unknown = null
      try {
        parsed = JSON.parse(text)
      } catch {
        // a non-JSON error body still carries the status
      }
      lastMessage = errorDetail(parsed, response.status)
      lastStatus = response.status
      // 404 means the path is wrong rather than the credential, so the second
      // auth style would repeat the same miss — move to the next path instead.
      if (response.status === 404) continue
      // 401/403 usually mean the other credential style is the right one, but a
      // 400/422 means the request body itself was rejected — retrying it with a
      // different header is pointless.
      if (response.status === 400 || response.status === 422) break
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      lastMessage =
        name === 'TimeoutError'
          ? `no response within ${TIMEOUT_MS / 1000}s`
          : sanitize(e instanceof Error ? e.message : String(e))
      break
    }
  }

  return { ok: false, ms: Date.now() - started, status: lastStatus, message: lastMessage }
}
