import { resolveAgentLocation, type AgentId } from './agent-config-paths'
import { readSnapshot, writeSnapshot } from './agent-config-io'
import { fetchProviderModels } from './agent-model-list'
import { testProviderModel } from './agent-model-test'
import {
  applyKimiProviderEdit,
  parseKimiDocument,
  readKimiPayload,
  readKimiProviderEndpoint,
  removeKimiProvider,
  revealKimiKey,
  serializeKimiDocument,
} from './kimi-config'
import {
  applyMcodeProviderEdit,
  deriveProviderKey,
  parseMcodeDocument,
  readMcodePayload,
  readMcodeProviderEndpoint,
  removeMcodeProvider,
  revealMcodeKey,
  serializeMcodeDocument,
} from './mcode-config'
import { KIMI_PROTOCOLS, MCODE_PROTOCOLS } from '../src/lib/agent-config'
import type {
  AgentConfigPayload,
  AgentKeyReveal,
  AgentModelListResult,
  AgentModelTestResult,
  AgentProviderInput,
  AgentWriteResult,
} from '../src/lib/agent-config'

/**
 * Orchestration for the Agent configuration feature.
 *
 * Every operation follows the same path — locate the file, read a snapshot,
 * parse, transform, serialise, write with compare-and-swap — so the two agents
 * differ only in their parser/writer pair. Nothing here knows about IPC; the
 * handlers in main.ts stay thin.
 */

/** Files larger than this are almost certainly not a config we should edit */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024

/** Shown when the file changed between the read the user saw and their save */
const DRIFT_MESSAGE = '配置文件在本次编辑期间被外部修改，请刷新后重试'

/**
 * Characters that cannot appear in a provider identifier.
 *
 * kimicode stores a provider under its own name as a TOML table header
 * (`[providers."Little Jochen"]`), so a quote, bracket or newline in that name
 * would produce a document the agent cannot parse. mcode derives its key from a
 * fixed kebab-case alphabet instead, so the check only applies to kimicode.
 */
const FORBIDDEN_KEY_CHARS = /["'\\[\]{}\r\n\t]/

/** Empty payload for an agent with no readable config file */
function notInstalled(agent: AgentId, note: string, configPath: string | null): AgentConfigPayload {
  return {
    agent,
    installed: false,
    configPath,
    revision: '',
    globals: {},
    providers: [],
    cliAvailable: false,
    note,
  }
}

/** Read one agent's configuration, degrading to a not-installed payload on failure */
export async function readAgentConfig(agent: AgentId): Promise<AgentConfigPayload> {
  const location = resolveAgentLocation(agent)
  const cliAvailable = location.cliPaths.length > 0

  if (!location.configPath) {
    return notInstalled(
      agent,
      'not-found',
      null,
    )
  }

  const snapshot = await readSnapshot(location.configPath)
  if (!snapshot) return notInstalled(agent, 'unreadable', location.configPath)
  if (snapshot.text.length > MAX_CONFIG_BYTES) {
    return notInstalled(agent, 'too-large', location.configPath)
  }

  try {
    const payload =
      agent === 'kimi'
        ? readKimiPayload(snapshot.text, location.configPath, cliAvailable)
        : readMcodePayload(snapshot.text, location.configPath, cliAvailable)
    // The CAS token is the hash of the exact text this payload was built from.
    payload.revision = snapshot.hash
    return payload
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return {
      ...notInstalled(agent, 'parse-error', location.configPath),
      cliAvailable,
      // The parser's message names the offending line; it never contains keys.
      note: `parse-error: ${message}`,
    }
  }
}

/**
 * Hand back one provider's plaintext credential.
 *
 * The read path deliberately ships masked previews only, so the plaintext is
 * fetched per provider and only when the user asks to see it.
 */
export async function revealAgentKey(agent: AgentId, providerId: string): Promise<AgentKeyReveal> {
  const location = resolveAgentLocation(agent)
  if (!location.configPath) return { ok: false, message: 'not-installed' }
  const snapshot = await readSnapshot(location.configPath)
  if (!snapshot) return { ok: false, message: 'unreadable' }

  try {
    const key =
      agent === 'kimi'
        ? revealKimiKey(snapshot.text, providerId)
        : revealMcodeKey(snapshot.text, providerId)
    if (!key) return { ok: false, message: 'no-key' }
    return { ok: true, key }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Ask one configured provider which models it serves.
 *
 * `override` lets the editor query with values that are not saved yet — a base
 * URL the user has just typed, or a credential they just pasted — which is what
 * makes "fetch models" work while a provider is still being created. Anything
 * the caller does not supply is filled in from the file, so editing an existing
 * provider does not require re-entering its key.
 */
export async function listAgentProviderModels(
  agent: AgentId,
  providerId: string,
  override?: { baseUrl?: string; apiKey?: string; protocol?: string },
): Promise<AgentModelListResult> {
  let baseUrl = override?.baseUrl?.trim()
  let apiKey = override?.apiKey?.trim()
  let protocol = override?.protocol ?? ''

  if (!baseUrl || !apiKey) {
    const location = resolveAgentLocation(agent)
    if (location.configPath) {
      const snapshot = await readSnapshot(location.configPath)
      if (snapshot) {
        try {
          const endpoint =
            agent === 'kimi'
              ? readKimiProviderEndpoint(snapshot.text, providerId)
              : readMcodeProviderEndpoint(snapshot.text, providerId)
          if (endpoint) {
            baseUrl = baseUrl || endpoint.baseUrl
            apiKey = apiKey || endpoint.apiKey
            protocol = protocol || endpoint.protocol
          }
        } catch {
          // an unreadable file just means the override has to carry everything
        }
      }
    }
  }

  if (!baseUrl) return { ok: false, message: 'provider has no base url' }
  if (!apiKey) return { ok: false, message: 'provider has no stored credential' }

  try {
    return await fetchProviderModels(baseUrl, apiKey, protocol)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Probe one model with a minimal live request.
 *
 * `modelId` must be the wire name (the record's own `model` field), not the
 * alias: for kimicode the two differ whenever a router rewrites the name. The
 * credential is read from the config file, used for this one call, and never
 * returned to the caller.
 */
export async function testAgentModel(
  agent: AgentId,
  providerId: string,
  modelId: string,
): Promise<AgentModelTestResult> {
  const wireName = modelId.trim()
  if (!wireName) return { ok: false, message: 'invalid model id' }

  const location = resolveAgentLocation(agent)
  if (!location.configPath) return { ok: false, message: 'not-installed' }
  const snapshot = await readSnapshot(location.configPath)
  if (!snapshot) return { ok: false, message: 'unreadable' }

  try {
    const endpoint =
      agent === 'kimi'
        ? readKimiProviderEndpoint(snapshot.text, providerId)
        : readMcodeProviderEndpoint(snapshot.text, providerId)
    if (!endpoint) return { ok: false, message: 'provider not found' }
    if (!endpoint.baseUrl) return { ok: false, message: 'provider has no base url' }
    return await testProviderModel(
      endpoint.baseUrl,
      endpoint.apiKey ?? '',
      endpoint.protocol,
      wireName,
    )
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** Reject input that would produce a config the agent cannot load */
function validateProviderInput(agent: AgentId, input: AgentProviderInput): string | null {  if (!input.id.trim()) return 'provider id is empty'
  if (agent === 'kimi' && FORBIDDEN_KEY_CHARS.test(input.id)) {
    return 'provider name contains a character that cannot appear in a config table header'
  }
  if (input.protocol) {
    const allowed: readonly string[] = agent === 'kimi' ? KIMI_PROTOCOLS : MCODE_PROTOCOLS
    if (!allowed.includes(input.protocol)) return `unsupported protocol: ${input.protocol}`
  }
  if (input.baseUrl) {
    let parsed: URL
    try {
      parsed = new URL(input.baseUrl)
    } catch {
      return 'base url is not a valid URL'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'base url must use http or https'
    }
  }
  for (const model of input.models) {
    if (!model.id.trim()) return 'model id is empty'
    if (FORBIDDEN_KEY_CHARS.test(model.id)) {
      return `model id contains an unsupported character: ${model.id}`
    }
    if (model.contextLimit !== undefined && (!Number.isInteger(model.contextLimit) || model.contextLimit <= 0)) {
      return `context limit must be a positive integer: ${model.id}`
    }
    if (model.outputLimit !== undefined && (!Number.isInteger(model.outputLimit) || model.outputLimit <= 0)) {
      return `output limit must be a positive integer: ${model.id}`
    }
  }
  return null
}

/** Shared create/update path */
export async function saveAgentProvider(
  agent: AgentId,
  revision: string,
  input: AgentProviderInput,
): Promise<AgentWriteResult> {
  const location = resolveAgentLocation(agent)
  if (!location.configPath) return { ok: false, reason: 'missing', message: 'not-installed' }

  const invalid = validateProviderInput(agent, input)
  if (invalid) return { ok: false, reason: 'invalid', message: invalid }

  const snapshot = await readSnapshot(location.configPath)
  if (!snapshot) return { ok: false, reason: 'missing' }

  // The renderer echoes back the revision it read from. A mismatch means the
  // file changed since that read, so the edit is refused up front; the write
  // itself re-checks, which closes the window between this test and the rename.
  if (revision && revision !== snapshot.hash) {
    return { ok: false, reason: 'conflict', message: DRIFT_MESSAGE }
  }

  let nextText: string
  try {
    if (agent === 'kimi') {
      const doc = parseKimiDocument(snapshot.text)
      applyKimiProviderEdit(doc, input)
      nextText = serializeKimiDocument(doc)
    } else {
      const doc = parseMcodeDocument(snapshot.text)
      const tree = doc.custom_provider ?? {}
      // Creating a provider means choosing its key here: the UI supplies the
      // display name only, and the key is derived once and then immutable.
      const resolved: AgentProviderInput = input.originalId
        ? input
        : { ...input, id: deriveProviderKey(input.name || input.id, new Set(Object.keys(tree))) }
      applyMcodeProviderEdit(doc, resolved)
      nextText = serializeMcodeDocument(doc)
    }
  } catch (e) {
    return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) }
  }

  const outcome = await writeSnapshot(location.configPath, nextText, snapshot)
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      message:
        outcome.reason === 'conflict'
          ? DRIFT_MESSAGE
          : outcome.reason === 'missing'
            ? '配置文件不存在'
            : outcome.message,
    }
  }
  return { ok: true, backupPath: outcome.backupPath }
}

/** Delete a provider and clear the pointers into it */
export async function removeAgentProvider(
  agent: AgentId,
  revision: string,
  providerId: string,
): Promise<AgentWriteResult> {
  const location = resolveAgentLocation(agent)
  if (!location.configPath) return { ok: false, reason: 'missing', message: 'not-installed' }

  const snapshot = await readSnapshot(location.configPath)
  if (!snapshot) return { ok: false, reason: 'missing' }
  if (revision && revision !== snapshot.hash) {
    return { ok: false, reason: 'conflict', message: DRIFT_MESSAGE }
  }

  let nextText: string
  try {
    if (agent === 'kimi') {
      const doc = parseKimiDocument(snapshot.text)
      removeKimiProvider(doc, providerId)
      nextText = serializeKimiDocument(doc)
    } else {
      const doc = parseMcodeDocument(snapshot.text)
      removeMcodeProvider(doc, providerId)
      nextText = serializeMcodeDocument(doc)
    }
  } catch (e) {
    return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) }
  }

  const outcome = await writeSnapshot(location.configPath, nextText, snapshot)
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      message:
        outcome.reason === 'conflict'
          ? DRIFT_MESSAGE
          : outcome.reason === 'missing'
            ? '配置文件不存在'
            : outcome.message,
    }
  }
  return { ok: true, backupPath: outcome.backupPath }
}
