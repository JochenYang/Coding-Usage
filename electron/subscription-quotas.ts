import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Official subscription quota probes for Claude Code and Gemini CLI, matching
 * the `codex:quota` contract: read the LOCAL login state, call the vendor's
 * official endpoint, and return numbers-only results. Credentials (tokens,
 * refresh tokens, client secrets) stay inside the main process and are never
 * included in the returned body — the renderer receives parsed usage JSON.
 *
 * The module deliberately avoids importing Electron so the pure probe logic
 * can be exercised headlessly in tests; callers inject `net.fetch`.
 */

export interface QuotaOutcome {
  available: boolean
  body?: string
  reason?: string
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

/** Shared short timeout: quota probes are UX garnish, not critical path */
const PROBE_TIMEOUT_MS = 10_000

async function readJson(path: string): Promise<{ ok: true; json: unknown } | { ok: false; missing: boolean }> {
  try {
    return { ok: true, json: JSON.parse(await readFile(path, 'utf8')) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return { ok: false, missing: code === 'ENOENT' }
  }
}

/**
 * Read an object member that may sit under either of two spellings and is
 * possibly null/malformed (the credentials files evolve across CLI versions).
 */
function pickObject(root: unknown, key: string): Record<string, unknown> | null {
  if (!root || typeof root !== 'object') return null
  const value = (root as Record<string, unknown>)[key]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

// ===== Claude Code =====

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// Required for the OAuth-issued token; the official endpoint rejects requests
// carrying an account (console) API key without this beta header.
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'

/**
 * Claude Code quota via the official OAuth usage endpoint. Login state lives
 * in `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`, older CLIs
 * wrote `claude.ai_oauth`). On macOS the CLI can also mirror the token into
 * its Keychain entry — reading the file remains the portable, safe subset, so
 * a Keychain-only install degrades to the honest unavailable state.
 */
export async function fetchClaudeUsage(
  fetchImpl: FetchImpl,
  homeDir: string,
  configDirOverride?: string,
): Promise<QuotaOutcome> {
  try {
    const base = configDirOverride ?? join(homeDir, '.claude')
    const credFile = await readJson(join(base, '.credentials.json'))
    if (!credFile.ok) return { available: false, reason: 'no-auth-file' }
    const oauth =
      pickObject(credFile.json, 'claudeAiOauth') ?? pickObject(credFile.json, 'claude.ai_oauth')
    const token = oauth?.accessToken
    if (typeof token !== 'string' || token === '') return { available: false, reason: 'no-oauth-token' }

    // Expiry is not checked locally: cc-switch's behavior (and the server being
    // the source of truth) is to attempt once even for locally-stale tokens.
    const res = await fetchImpl(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return { available: false, reason: `http-${res.status}` }
    return { available: true, body: await res.text() }
  } catch {
    return { available: false, reason: 'probe-failed' }
  }
}

// ===== Gemini CLI =====

const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GEMINI_LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
// Public OAuth client of the open-source gemini-cli (an "installed app"
// client, whose secret is published upstream by design — not a user secret).
const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
const GEMINI_CLIENT_SECRET = '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'

async function refreshGeminiToken(
  fetchImpl: FetchImpl,
  refreshToken: string,
): Promise<string | null> {
  const form = new URLSearchParams({
    client_id: GEMINI_CLIENT_ID,
    client_secret: GEMINI_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetchImpl(GEMINI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { access_token?: unknown }
  return typeof json.access_token === 'string' ? json.access_token : null
}

/** `cloudaicompanionProject` arrives as a plain string or an {id|projectId} object */
function extractProjectId(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (!obj) return null
  for (const key of ['id', 'projectId']) {
    if (typeof obj[key] === 'string' && obj[key] !== '') return obj[key] as string
  }
  return null
}

/**
 * Gemini Code Assist quota. Chain: local `~/.gemini/oauth_creds.json` →
 * (optional) OAuth refresh → loadCodeAssist (project id) → retrieveUserQuota.
 * The renderer gets only normalized quota buckets. No file write-back happens:
 * refreshed tokens are used in-memory per probe, leaving the user's login
 * files untouched.
 */
export async function fetchGeminiUsage(fetchImpl: FetchImpl, homeDir: string): Promise<QuotaOutcome> {
  try {
    const credFile = await readJson(join(homeDir, '.gemini', 'oauth_creds.json'))
    if (!credFile.ok) return { available: false, reason: 'no-auth-file' }
    // Unlike Claude's file this one is flat: the fields sit at the top level
    const creds =
      credFile.json && typeof credFile.json === 'object'
        ? (credFile.json as Record<string, unknown>)
        : {}
    const accessToken = creds.access_token
    const refreshToken = creds.refresh_token
    const tokenOk = typeof accessToken === 'string' && accessToken !== ''
    const hasToken = tokenOk ? (accessToken as string) : null
    const expiry = typeof creds.expiry_date === 'number' ? creds.expiry_date : null
    const stale = expiry == null || Date.now() + 60_000 >= expiry

    let token = hasToken
    if ((token == null || stale) && typeof refreshToken === 'string' && refreshToken !== '') {
      const refreshed = await refreshGeminiToken(fetchImpl, refreshToken)
      if (refreshed) token = refreshed
    }
    if (token == null) {
      return { available: false, reason: hasToken ? 'refresh-failed' : 'no-refresh-token' }
    }

    const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    const postJson = async (url: string, payload: unknown): Promise<Response> =>
      fetchImpl(url, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })

    const loadRes = await postJson(GEMINI_LOAD_URL, {
      metadata: { ideType: 'GEMINI', pluginType: 'GEMINI' },
    })
    if (loadRes.status === 401 || loadRes.status === 403) {
      return { available: false, reason: `http-${loadRes.status}` }
    }
    let projectId: string | null = null
    if (loadRes.ok) {
      projectId = extractProjectId(
        ((await loadRes.json()) as { cloudaicompanionProject?: unknown }).cloudaicompanionProject,
      )
    }

    // Without a project id the quota endpoint still answers with personal buckets
    const quotaRes = await postJson(GEMINI_QUOTA_URL, projectId ? { project: projectId } : {})
    if (!quotaRes.ok) return { available: false, reason: `http-${quotaRes.status}` }
    const quotaJson = (await quotaRes.json()) as { buckets?: unknown }
    return {
      available: true,
      body: JSON.stringify({ buckets: Array.isArray(quotaJson.buckets) ? quotaJson.buckets : [] }),
    }
  } catch {
    return { available: false, reason: 'probe-failed' }
  }
}
