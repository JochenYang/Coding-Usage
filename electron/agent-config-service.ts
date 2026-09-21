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
import {
  applyOpencodeProviderEdit,
  parseOpencodeDocument,
  readOpencodePayload,
  readOpencodeProviderEndpoint,
  removeOpencodeProvider,
  revealOpencodeKey,
  serializeOpencodeDocument,
} from './opencode-config'
import {
  KIMI_PROTOCOLS,
  MCODE_PROTOCOLS,
  OPENCODE_PACKAGES,
} from '../src/lib/agent-config'
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
 * parse, transform, serialise, write with compare-and-swap — so the agents
 * differ only in their parser/writer pair. That pair is the `AgentOps` table
 * below; nothing else in this module branches on which agent it is talking to,
 * and nothing here knows about IPC.
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
 * would produce a document the agent cannot parse. The others have their own
 * constraints; this set is the intersection that is safe everywhere.
 */
const FORBIDDEN_KEY_CHARS = /["'\\[\]{}\r\n\t]/

/** Endpoint and credential of one provider, as the request builders need it */
interface ProviderEndpoint {
  baseUrl?: string
  protocol: string
  apiKey?: string
  /**
   * Environment variable names the provider's credential may come from.
   * Present when the config names variables rather than holding a value, so a
   * missing credential can say which name was looked for.
   */
  credentialEnv?: string[]
}

/** Everything that differs between the agents, in one place */
interface AgentOps {
  /** Parse the file; throws with the parser's own message when malformed */
  parse(text: string): unknown
  /** Project the document into the shape the UI consumes */
  read(text: string, configPath: string, cliAvailable: boolean): AgentConfigPayload
  /** Serialise the document back to file text */
  serialize(doc: unknown): string
  /** Apply a provider create/update, in place */
  applyEdit(doc: unknown, input: AgentProviderInput): void
  /** Remove a provider and clear the pointers into it, in place */
  removeProvider(doc: unknown, providerId: string): void
  /** Plaintext credential, or null when there is none to reveal */
  revealKey(text: string, providerId: string): string | null
  /** Credential and endpoint for the outbound requests */
  endpoint(text: string, providerId: string): ProviderEndpoint | null
  /** Protocol values this agent accepts */
  protocols: readonly string[]
  /**
   * True when the stored key is derived from the display name rather than
   * taken from the caller (mcode's immutable kebab-case id).
   */
  derivesKey?: boolean
}

const OPS: Record<AgentId, AgentOps> = {
  kimi: {
    parse: parseKimiDocument,
    read: readKimiPayload,
    serialize: (doc) => serializeKimiDocument(doc as Parameters<typeof serializeKimiDocument>[0]),
    applyEdit: (doc, input) =>
      applyKimiProviderEdit(doc as Parameters<typeof applyKimiProviderEdit>[0], input),
    removeProvider: (doc, id) =>
      removeKimiProvider(doc as Parameters<typeof removeKimiProvider>[0], id),
    revealKey: revealKimiKey,
    endpoint: readKimiProviderEndpoint,
    protocols: KIMI_PROTOCOLS,
  },
  mcode: {
    parse: parseMcodeDocument,
    read: readMcodePayload,
    serialize: (doc) => serializeMcodeDocument(doc as Parameters<typeof serializeMcodeDocument>[0]),
    applyEdit: (doc, input) => {
      const document = doc as Parameters<typeof applyMcodeProviderEdit>[0]
      // Creating a provider means choosing its key here: the UI supplies the
      // display name only, and the key is derived once and then immutable.
      const taken = new Set(Object.keys(document.custom_provider ?? {}))
      const resolved = input.originalId
        ? input
        : { ...input, id: deriveProviderKey(input.name || input.id, taken) }
      applyMcodeProviderEdit(document, resolved)
    },
    removeProvider: (doc, id) =>
      removeMcodeProvider(doc as Parameters<typeof removeMcodeProvider>[0], id),
    revealKey: revealMcodeKey,
    endpoint: readMcodeProviderEndpoint,
    protocols: MCODE_PROTOCOLS,
    derivesKey: true,
  },
  opencode: {
    parse: parseOpencodeDocument,
    read: readOpencodePayload,
    serialize: (doc) =>
      serializeOpencodeDocument(doc as Parameters<typeof serializeOpencodeDocument>[0]),
    applyEdit: (doc, input) =>
      applyOpencodeProviderEdit(doc as Parameters<typeof applyOpencodeProviderEdit>[0], input),
    removeProvider: (doc, id) =>
      removeOpencodeProvider(doc as Parameters<typeof removeOpencodeProvider>[0], id),
    revealKey: revealOpencodeKey,
    endpoint: readOpencodeProviderEndpoint,
    protocols: OPENCODE_PACKAGES,
  },
}

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
    return notInstalled(agent, 'not-found', null)
  }

  const snapshot = await readSnapshot(location.configPath)
  if (!snapshot) return notInstalled(agent, 'unreadable', location.configPath)
  if (snapshot.text.length > MAX_CONFIG_BYTES) {
    return notInstalled(agent, 'too-large', location.configPath)
  }

  try {
    const payload = OPS[agent].read(snapshot.text, location.configPath, cliAvailable)
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
    const key = OPS[agent].revealKey(snapshot.text, providerId)
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
  let credentialEnv: string[] | undefined

  if (!baseUrl || !apiKey) {
    const location = resolveAgentLocation(agent)
    if (location.configPath) {
      const snapshot = await readSnapshot(location.configPath)
      if (snapshot) {
        try {
          const endpoint = OPS[agent].endpoint(snapshot.text, providerId)
          if (endpoint) {
            baseUrl = baseUrl || endpoint.baseUrl
            apiKey = apiKey || endpoint.apiKey
            protocol = protocol || endpoint.protocol
            credentialEnv = endpoint.credentialEnv
          }
        } catch {
          // an unreadable file just means the override has to carry everything
        }
      }
    }
  }

  if (!baseUrl) return { ok: false, message: '这个 Provider 没有可用的 Base URL' }
  if (!apiKey) {
    // Naming the variable is the difference between a user knowing what to set
    // and a user being told only that something is missing.
    return {
      ok: false,
      message:
        credentialEnv && credentialEnv.length > 0
          ? `环境变量 ${credentialEnv.join(' / ')} 未设置`
          : '这个 Provider 没有可用的凭据',
    }
  }

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
    const endpoint = OPS[agent].endpoint(snapshot.text, providerId)
    if (!endpoint) return { ok: false, message: '没有找到这个 Provider' }
    if (!endpoint.baseUrl) return { ok: false, message: '这个 Provider 没有可用的 Base URL' }
    if (!endpoint.apiKey) {
      return {
        ok: false,
        message:
          endpoint.credentialEnv && endpoint.credentialEnv.length > 0
            ? `环境变量 ${endpoint.credentialEnv.join(' / ')} 未设置`
            : '这个 Provider 没有可用的凭据',
      }
    }
    return await testProviderModel(
      endpoint.baseUrl,
      endpoint.apiKey,
      endpoint.protocol,
      wireName,
    )
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** Reject input that would produce a config the agent cannot load */
function validateProviderInput(agent: AgentId, input: AgentProviderInput): string | null {
  if (!input.id.trim()) return 'provider id is empty'
  if (FORBIDDEN_KEY_CHARS.test(input.id)) {
    return 'provider name contains a character that cannot appear in a config key'
  }
  // opencode references a model as `<provider>/<model>`, so a slash inside the
  // provider id would make the reference ambiguous.
  if (agent === 'opencode' && /[/\s]/.test(input.id)) {
    return 'provider id cannot contain a slash or whitespace'
  }
  if (input.protocol) {
    const allowed: readonly string[] = OPS[agent].protocols
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
    const doc = OPS[agent].parse(snapshot.text)
    OPS[agent].applyEdit(doc, input)
    nextText = OPS[agent].serialize(doc)
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
    const doc = OPS[agent].parse(snapshot.text)
    OPS[agent].removeProvider(doc, providerId)
    nextText = OPS[agent].serialize(doc)
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
