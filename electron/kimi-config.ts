import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { maskKey, MODALITY_CAPABILITIES, sameMembers } from '../src/lib/agent-config'
import type {
  AgentConfigPayload,
  AgentGlobals,
  AgentModel,
  AgentProvider,
  AgentProviderInput,
} from '../src/lib/agent-config'

/**
 * kimicode (`~/.kimi-code/config.toml`) reader and writer.
 *
 * The file is a flat TOML document with three sections this feature touches:
 *
 *   [providers.<name>]          type / base_url / api_key / custom_headers
 *   [models."<provider>/<id>"]  one record per model alias
 *   default_model / default_provider / default_permission_mode  (top level)
 *
 * Everything else — `[experimental]`, `[[hooks]]`, `[thinking]`,
 * `[model_overrides]` — is carried through untouched: the whole document is
 * parsed into one object and only the addressed subtree is mutated, so unknown
 * keys survive by construction.
 *
 * Measured round-trip behaviour (see .tmp/verify-*.mjs at the time of writing):
 * `smol-toml` re-serialises the real 591-line file with 100% of lines landing
 * byte-identical, so an edit shows up as a one-line diff.
 */

/** Loose shape of the parts of config.toml this module understands */
interface KimiModelRecord {
  model?: unknown
  provider?: unknown
  display_name?: unknown
  max_context_size?: unknown
  max_input_size?: unknown
  max_output_size?: unknown
  capabilities?: unknown
  support_efforts?: unknown
  default_effort?: unknown
  off_effort?: unknown
  reasoning_key?: unknown
  [key: string]: unknown
}

interface KimiProviderRecord {
  type?: unknown
  base_url?: unknown
  api_key?: unknown
  api_key_env?: unknown
  custom_headers?: unknown
  [key: string]: unknown
}

export interface KimiDocument {
  default_model?: unknown
  default_provider?: unknown
  default_permission_mode?: unknown
  providers?: Record<string, KimiProviderRecord>
  models?: Record<string, KimiModelRecord>
  [key: string]: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Parse config.toml; throws with the parser's own message on malformed input */
export function parseKimiDocument(text: string): KimiDocument {
  const parsed = parseToml(text)
  const record = asRecord(parsed)
  if (!record) throw new Error('config.toml did not parse to a table')
  return record as KimiDocument
}

/** Serialise the document back to TOML text */
export function serializeKimiDocument(doc: KimiDocument): string {
  return stringifyToml(doc as Record<string, unknown>)
}

/**
 * Thinking mode from kimicode's capability flags.
 *
 * kimicode has no explicit `thinking_config.mode`; the same three states are
 * expressed through `capabilities` plus whether an effort list exists.
 */
function thinkingModeOf(capabilities: string[], supportEfforts: string[]): AgentModel['thinkingMode'] {
  if (capabilities.includes('always_thinking')) return 'forced_on'
  if (capabilities.includes('thinking')) return supportEfforts.length > 0 ? 'switchable' : 'forced_on'
  if (supportEfforts.length > 0) return 'switchable'
  return 'forced_off'
}

/** Modality marker → the capability flag kimicode stores it as */
const MODALITY_TO_CAPABILITY: Record<string, string> = {
  image: 'image_in',
  video: 'video_in',
  audio: 'audio_in',
}

/**
 * Split kimicode's single `capabilities` array into modalities and behaviour.
 *
 * `text` is implied rather than declared, so it is always present in the
 * modality list even when the array says nothing about input kinds.
 */
function splitCapabilities(rawCapabilities: string[]): {
  capabilities: string[]
  inputModalities: string[]
} {
  const inputModalities = ['text']
  const capabilities: string[] = []
  for (const flag of rawCapabilities) {
    const modality = MODALITY_CAPABILITIES[flag]
    if (modality) inputModalities.push(modality)
    else capabilities.push(flag)
  }
  return { capabilities, inputModalities }
}

/** Recombine the two lists into the single array the file stores */
function joinCapabilities(inputModalities: string[], capabilities: string[]): string[] {
  const out: string[] = []
  for (const modality of inputModalities) {
    const flag = MODALITY_TO_CAPABILITY[modality]
    if (flag) out.push(flag)
  }
  for (const capability of capabilities) if (!out.includes(capability)) out.push(capability)
  return out
}

function toModel(key: string, raw: KimiModelRecord, providerId: string): AgentModel {
  const { capabilities, inputModalities } = splitCapabilities(strArray(raw.capabilities))
  const supportEfforts = strArray(raw.support_efforts)
  // Only the first slash separates provider from id: mcode-style routers alias
  // models whose own id contains slashes (`command-goat/deepseek/x-flash`).
  const slash = key.indexOf('/')
  const bareId = slash >= 0 ? key.slice(slash + 1) : key
  return {
    id: bareId,
    alias: key,
    // The alias key and the wire name differ often enough (routers rewrite it)
    // that the record's own `model` wins when present.
    model: str(raw.model) ?? bareId,
    displayName: str(raw.display_name) ?? str(raw.model) ?? key,
    displayNameExplicit: str(raw.display_name) !== undefined,
    providerId: str(raw.provider) ?? providerId,
    contextLimit: num(raw.max_context_size),
    inputLimit: num(raw.max_input_size),
    outputLimit: num(raw.max_output_size),
    capabilities,
    inputModalities,
    supportEfforts,
    defaultEffort: str(raw.default_effort),
    offEffort: str(raw.off_effort),
    reasoningKey: str(raw.reasoning_key),
    thinkingMode: thinkingModeOf(capabilities, supportEfforts),
  }
}

/** Map a provider record plus its models onto the shared shape */
function toProvider(id: string, raw: KimiProviderRecord, models: AgentModel[]): AgentProvider {
  const inlineKey = str(raw.api_key)
  const envName = str(raw.api_key_env)
  // A credential named by environment variable only counts as present when the
  // variable is actually set: the UI uses this to decide whether the provider
  // can be queried at all, and a declared-but-unset variable would otherwise
  // look ready right up until the request fails.
  const envValue = envName ? process.env[envName]?.trim() : undefined
  const masked = inlineKey ? maskKey(inlineKey) : envName ? `env:${envName}` : undefined
  return {
    id,
    name: id,
    protocol: str(raw.type) ?? '',
    baseUrl: str(raw.base_url),
    hasKey: Boolean(inlineKey) || Boolean(envValue),
    maskedKey: masked,
    models,
  }
}

/**
 * Build the IPC payload from config text.
 *
 * Models are grouped by each record's own `provider` field rather than by the
 * alias prefix, matching what `kimi provider list` reports: a model aliased
 * `opencode-go/gpt-5.6-luna` whose record says `provider = "opencode-go-responses"`
 * is listed under the latter. Aliases pointing at a provider that has no
 * `[providers.*]` section land in a synthetic bucket so they are visible rather
 * than silently dropped.
 */
export function readKimiPayload(
  text: string,
  configPath: string,
  cliAvailable: boolean,
): AgentConfigPayload {
  const doc = parseKimiDocument(text)
  const providerRecords = asRecord(doc.providers) ?? {}
  const modelRecords = asRecord(doc.models) ?? {}

  const byProvider = new Map<string, AgentModel[]>()
  for (const id of Object.keys(providerRecords)) byProvider.set(id, [])

  const orphaned: AgentModel[] = []
  for (const [key, raw] of Object.entries(modelRecords)) {
    const record = asRecord(raw) as KimiModelRecord | null
    if (!record) continue
    const prefix = key.includes('/') ? key.slice(0, key.indexOf('/')) : ''
    const owner = str(record.provider) ?? prefix
    const model = toModel(key, record, owner)
    const bucket = byProvider.get(owner)
    if (bucket) bucket.push(model)
    else orphaned.push(model)
  }

  const providers: AgentProvider[] = Object.entries(providerRecords)
    .map(([id, raw]) => toProvider(id, (asRecord(raw) ?? {}) as KimiProviderRecord, byProvider.get(id) ?? []))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (orphaned.length > 0) {
    providers.push({
      id: '__unlinked__',
      name: '未关联的模型',
      protocol: '',
      hasKey: false,
      readOnly: true,
      readOnlyReason: '这些模型的 provider 字段没有对应的 [providers.*] 段落',
      models: orphaned,
    })
  }

  const globals: AgentGlobals = {
    defaultModel: str(doc.default_model),
    defaultProvider: str(doc.default_provider),
    defaultPermissionMode: str(doc.default_permission_mode),
  }

  return {
    agent: 'kimi',
    installed: true,
    configPath,
    revision: '',
    globals,
    providers,
    cliAvailable,
  }
}

/** Plaintext credential of one provider, for the reveal action */
export function revealKimiKey(text: string, providerId: string): string | null {
  const doc = parseKimiDocument(text)
  const record = asRecord(asRecord(doc.providers)?.[providerId])
  if (!record) return null
  return str(record.api_key) ?? null
}

/**
 * Endpoint and credential of one provider, for the model-list request.
 *
 * A credential may live in the file or be named by `api_key_env` for the
 * runtime to read — the latter is resolved here so the request can be made
 * without the user re-typing a key.
 */
export function readKimiProviderEndpoint(
  text: string,
  providerId: string,
): { baseUrl?: string; protocol: string; apiKey?: string; credentialEnv?: string[] } | null {
  const doc = parseKimiDocument(text)
  const record = asRecord(asRecord(doc.providers)?.[providerId])
  if (!record) return null
  const envName = str(record.api_key_env)
  const apiKey = str(record.api_key) ?? (envName ? process.env[envName]?.trim() : undefined)
  return {
    baseUrl: str(record.base_url),
    protocol: str(record.type) ?? '',
    apiKey,
    // Surfaced so a missing credential can name the variable it looked for.
    credentialEnv: envName ? [envName] : undefined,
  }
}

/**
 * Apply a provider create/update to the document, in place.
 *
 * The provider id is immutable: renaming a section would have to rewrite every
 * model alias key and every `provider` field, and a half-applied rename would
 * leave dangling aliases that only fail at request time. The UI therefore only
 * offers the display name for editing, and `input.id` is the section key.
 */
export function applyKimiProviderEdit(doc: KimiDocument, input: AgentProviderInput): void {
  const providers = asRecord(doc.providers) ?? {}
  doc.providers = providers as Record<string, KimiProviderRecord>
  const models = asRecord(doc.models) ?? {}
  doc.models = models as Record<string, KimiModelRecord>

  const existing = asRecord(providers[input.id]) ?? {}
  const next: KimiProviderRecord = { ...existing }

  if (input.protocol) next.type = input.protocol
  if (input.baseUrl) next.base_url = input.baseUrl
  else delete next.base_url

  // Credential semantics mirror kimicode's own REST contract: undefined keeps
  // the stored value, an empty string clears it, anything else replaces it.
  if (input.apiKey !== undefined) {
    if (input.apiKey === '') {
      delete next.api_key
      delete next.api_key_env
    } else {
      next.api_key = input.apiKey
      delete next.api_key_env
    }
  }

  providers[input.id] = next

  // Reconcile the model list. A field the caller left undefined keeps its
  // stored value, which is what lets the editor send only what the user
  // actually changed; ids no longer listed are removed — except the ones a
  // rename is about to move, which are held until the move has happened.
  const keep = new Set<string>()
  for (const model of input.models) {
    keep.add(`${input.id}/${model.id}`)
    if (model.originalId && model.originalId !== model.id) keep.add(`${input.id}/${model.originalId}`)
  }
  for (const key of Object.keys(models)) {
    const record = asRecord(models[key])
    if (!record) continue
    if (str(record.provider) !== input.id) continue
    if (!keep.has(key)) delete models[key]
  }

  for (const model of input.models) {
    const key = `${input.id}/${model.id}`
    const previousKey =
      model.originalId && model.originalId !== model.id ? `${input.id}/${model.originalId}` : null
    const existing = asRecord(previousKey ? models[previousKey] : models[key])
    const next: KimiModelRecord = existing
      ? { ...existing }
      : { model: model.model ?? model.id, provider: input.id }

    // A bare alias whose wire name was simply the old id follows the rename; one
    // that points at a different upstream name is left as it was.
    if (previousKey && str(next.model) === model.originalId) next.model = model.id
    if (previousKey) {
      delete models[previousKey]
      // A default-model pointer must follow the record rather than dangle.
      if (str(doc.default_model) === previousKey) doc.default_model = key
    }

    if (model.model !== undefined) next.model = model.model
    if (model.displayName !== undefined) {
      if (model.displayName) next.display_name = model.displayName
      else delete next.display_name
    }
    if (model.contextLimit !== undefined) {
      if (model.contextLimit > 0) next.max_context_size = model.contextLimit
      else delete next.max_context_size
    }
    if (model.outputLimit !== undefined) {
      if (model.outputLimit > 0) next.max_output_size = model.outputLimit
      else delete next.max_output_size
    }
    if (model.inputModalities !== undefined || model.capabilities !== undefined) {
      // Either half may be sent alone, so the untouched half is read back from
      // the record instead of being silently dropped.
      const stored = splitCapabilities(strArray(next.capabilities))
      const combined = joinCapabilities(
        model.inputModalities ?? stored.inputModalities,
        model.capabilities ?? stored.capabilities,
      )
      const current = strArray(next.capabilities)
      // An unchanged set is left exactly as it was, so an edit that touches
      // nothing does not reorder the array.
      if (!sameMembers(current, combined)) {
        if (combined.length > 0) next.capabilities = combined
        else delete next.capabilities
      }
    }
    if (model.supportEfforts !== undefined) {
      const current = strArray(next.support_efforts)
      if (!sameMembers(current, model.supportEfforts)) {
        if (model.supportEfforts.length > 0) next.support_efforts = [...model.supportEfforts]
        else delete next.support_efforts
      }
    }
    if (model.defaultEffort !== undefined) {
      if (model.defaultEffort) next.default_effort = model.defaultEffort
      else delete next.default_effort
    }
    if (model.offEffort !== undefined) {
      if (model.offEffort) next.off_effort = model.offEffort
      else delete next.off_effort
    }
    models[key] = next
  }
}

/**
 * Remove a provider and everything that pointed at it.
 *
 * Dangling pointers are the failure mode worth handling: a `default_model`
 * referencing a removed alias makes every new session start with a model the
 * engine cannot resolve, so the pointers are cleared in the same write.
 */
export function removeKimiProvider(doc: KimiDocument, providerId: string): void {
  const providers = asRecord(doc.providers)
  const models = asRecord(doc.models)

  if (models) {
    for (const [key, raw] of Object.entries(models)) {
      const record = asRecord(raw)
      if (!record) continue
      const owner = str(record.provider) ?? (key.includes('/') ? key.slice(0, key.indexOf('/')) : '')
      if (owner === providerId || key.startsWith(`${providerId}/`)) delete models[key]
    }
    doc.models = models as Record<string, KimiModelRecord>
  }

  if (providers) {
    delete providers[providerId]
    doc.providers = providers as Record<string, KimiProviderRecord>
  }

  if (str(doc.default_provider) === providerId) delete doc.default_provider
  const defaultModel = str(doc.default_model)
  if (defaultModel && defaultModel.startsWith(`${providerId}/`)) delete doc.default_model
}
