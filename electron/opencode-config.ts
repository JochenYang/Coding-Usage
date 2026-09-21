import { maskKey } from '../src/lib/agent-config'
import type {
  AgentConfigPayload,
  AgentGlobals,
  AgentModel,
  AgentModelInput,
  AgentProvider,
  AgentProviderInput,
} from '../src/lib/agent-config'

/**
 * opencode (`~/.config/opencode/opencode.json`) reader and writer.
 *
 * Two config generations exist and both must be understood:
 *
 *   v1 shape:  provider.<id>.npm       + provider.<id>.options.{apiKey,baseURL}
 *   v2 shape:  providers.<id>.package  + providers.<id>.settings.{apiKey,baseURL}
 *
 * The installed build (v2.0.10) still reads the v1 shape — `opencode models`
 * lists every provider defined in `provider` — so this module writes whichever
 * shape the file already uses rather than migrating it.
 *
 * Field shapes also drifted *within* models: input media appear under
 * `modalities.input` in older entries and `capabilities.input` in newer ones,
 * and reasoning levels are expressed as named `variants` (each a request-body
 * patch) rather than an effort list. Both are normalised on read and written
 * back to the spelling the record already had.
 *
 * Formatting: the whole document is parsed and re-serialised with a 2-space
 * indent. Measured against the real 485-line file that costs 15 diff lines —
 * one compact array gets expanded and trailing blank lines are dropped —
 * because `JSON.stringify` renders arrays one element per line.
 */

/** Credential references look like `{env:NAME}` and are not secrets */
const ENV_REFERENCE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

const DEFAULT_PACKAGE = '@ai-sdk/openai-compatible'

export interface OpencodeModelRecord {
  name?: unknown
  id?: unknown
  modelID?: unknown
  limit?: { context?: unknown; input?: unknown; output?: unknown }
  modalities?: { input?: unknown; output?: unknown }
  capabilities?: { input?: unknown; output?: unknown }
  attachment?: unknown
  reasoning?: unknown
  tool_call?: unknown
  variants?: Record<string, unknown>
  [key: string]: unknown
}

export interface OpencodeProviderRecord {
  name?: unknown
  npm?: unknown
  package?: unknown
  env?: unknown
  options?: Record<string, unknown>
  settings?: Record<string, unknown>
  models?: Record<string, OpencodeModelRecord>
  [key: string]: unknown
}

export interface OpencodeDocument {
  provider?: Record<string, OpencodeProviderRecord>
  providers?: Record<string, OpencodeProviderRecord>
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

/** Parse opencode.json; throws with the parser's own message on malformed input */
export function parseOpencodeDocument(text: string): OpencodeDocument {
  const parsed = JSON.parse(text) as unknown
  const record = asRecord(parsed)
  if (!record) throw new Error('opencode.json did not parse to an object')
  return record as OpencodeDocument
}

/** Serialise with a trailing newline, matching the file's own ending */
export function serializeOpencodeDocument(doc: OpencodeDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** The provider map this file uses, whichever generation wrote it */
function providerMap(doc: OpencodeDocument): {
  key: 'provider' | 'providers'
  map: Record<string, OpencodeProviderRecord>
} {
  if (doc.provider !== undefined) {
    return { key: 'provider', map: (asRecord(doc.provider) ?? {}) as Record<string, OpencodeProviderRecord> }
  }
  return { key: 'providers', map: (asRecord(doc.providers) ?? {}) as Record<string, OpencodeProviderRecord> }
}

/** Where a provider keeps its runtime package and settings, per generation */
function optionsKey(record: OpencodeProviderRecord): 'options' | 'settings' {
  return record.settings !== undefined && record.options === undefined ? 'settings' : 'options'
}

/** Input media declared under either spelling */
function inputModalitiesOf(record: OpencodeModelRecord): string[] {
  const declared = strArray(asRecord(record.modalities)?.input)
  if (declared.length > 0) return declared
  const newer = strArray(asRecord(record.capabilities)?.input)
  return newer.length > 0 ? newer : ['text']
}

/**
 * Behaviour flags.
 *
 * `thinking` here means "the model reasons"; opencode has no separate
 * always-on marker, and the reasoning levels live in `variants`.
 */
function capabilitiesOf(record: OpencodeModelRecord): string[] {
  const out: string[] = []
  if (record.tool_call === true) out.push('tool_use')
  if (record.reasoning === true) out.push('thinking')
  return out
}

function toModel(id: string, raw: OpencodeModelRecord): AgentModel {
  const limit = asRecord(raw.limit) ?? {}
  const variants = asRecord(raw.variants) ?? {}
  return {
    id,
    alias: id,
    model: str(raw.modelID) ?? str(raw.id) ?? id,
    displayName: str(raw.name) ?? id,
    displayNameExplicit: str(raw.name) !== undefined,
    providerId: '',
    contextLimit: num(limit.context),
    inputLimit: num(limit.input),
    outputLimit: num(limit.output),
    capabilities: capabilitiesOf(raw),
    inputModalities: inputModalitiesOf(raw),
    // opencode names reasoning levels, so the variant keys are the ladders.
    supportEfforts: Object.keys(variants),
    thinkingMode: thinkingModeOf(raw),
  }
}

/** opencode has no explicit mode; a variant list implies switchable */
function thinkingModeOf(record: OpencodeModelRecord): AgentModel['thinkingMode'] {
  if (record.reasoning === true) return 'switchable'
  return Object.keys(asRecord(record.variants) ?? {}).length > 0 ? 'switchable' : 'unknown'
}

/**
 * Credential state of one provider.
 *
 * opencode resolves a credential from two places, and both are common in real
 * configs: a literal `apiKey` (which may itself be an `{env:NAME}` reference),
 * or the provider-level `env` list — an ordered set of environment variable
 * names the runtime tries in turn. Only the first of those was handled at
 * first, which made every provider declaring `env: […]` look credential-less.
 */
function credentialOf(record: OpencodeProviderRecord): { hasKey: boolean; maskedKey?: string } {
  const holder = asRecord(record[optionsKey(record)]) ?? {}
  const direct = str(holder.apiKey)
  if (direct) {
    const envReference = ENV_REFERENCE.exec(direct)
    // `{env:NAME}` is a reference the runtime resolves, not a stored secret.
    if (envReference) return { hasKey: true, maskedKey: `env:${envReference[1]}` }
    return { hasKey: true, maskedKey: maskKey(direct) }
  }

  const names = strArray(record.env)
  if (names.length > 0) {
    // Show the name the runtime would actually resolve, falling back to the
    // first candidate so an unset variable is still visible in the UI.
    const resolved = names.find((name) => (process.env[name] ?? '').trim().length > 0)
    return { hasKey: Boolean(resolved), maskedKey: `env:${resolved ?? names[0]}` }
  }
  return { hasKey: false }
}

function toProvider(id: string, raw: OpencodeProviderRecord, models: AgentModel[]): AgentProvider {
  const holder = asRecord(raw[optionsKey(raw)]) ?? {}
  const credential = credentialOf(raw)
  return {
    id,
    name: str(raw.name) ?? id,
    protocol: str(raw.npm) ?? str(raw.package) ?? '',
    baseUrl: str(holder.baseURL),
    hasKey: credential.hasKey,
    maskedKey: credential.maskedKey,
    models,
  }
}

/**
 * Build the IPC payload from config text.
 *
 * The built-in catalogue providers (openai, openrouter, …) are not in the file
 * and therefore not shown — this surface is about the providers the user
 * defined or overrode here.
 */
export function readOpencodePayload(
  text: string,
  configPath: string,
  cliAvailable: boolean,
): AgentConfigPayload {
  const doc = parseOpencodeDocument(text)
  const { map } = providerMap(doc)

  const providers: AgentProvider[] = Object.entries(map)
    .map(([id, raw]) => {
      const record = (asRecord(raw) ?? {}) as OpencodeProviderRecord
      const models = Object.entries(asRecord(record.models) ?? {}).map(([mid, mraw]) =>
        toModel(mid, (asRecord(mraw) ?? {}) as OpencodeModelRecord),
      )
      return toProvider(id, record, models)
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const globals: AgentGlobals = {
    defaultModel: str(doc.model),
  }

  return {
    agent: 'opencode',
    installed: true,
    configPath,
    revision: '',
    globals,
    providers,
    cliAvailable,
  }
}

/** Plaintext credential of one provider, for the reveal action (null when env-backed) */
export function revealOpencodeKey(text: string, providerId: string): string | null {
  const doc = parseOpencodeDocument(text)
  const { map } = providerMap(doc)
  const record = asRecord(map[providerId])
  if (!record) return null
  const value = str(asRecord(record[optionsKey(record as OpencodeProviderRecord)])?.apiKey)
  if (!value || ENV_REFERENCE.test(value)) return null
  return value
}

/** Endpoint and credential of one provider, for the model-list request */
export function readOpencodeProviderEndpoint(
  text: string,
  providerId: string,
): { baseUrl?: string; protocol: string; apiKey?: string; credentialEnv?: string[] } | null {
  const doc = parseOpencodeDocument(text)
  const { map } = providerMap(doc)
  const record = map[providerId]
  if (!record) return null
  const holder = asRecord(record[optionsKey(record)]) ?? {}
  const raw = str(holder.apiKey)
  const reference = raw ? ENV_REFERENCE.exec(raw) : null
  const names = strArray(record.env)

  let apiKey = reference ? process.env[reference[1]]?.trim() : raw
  if (!apiKey) {
    // Provider-level env list: the runtime tries each name in order.
    for (const name of names) {
      const value = process.env[name]?.trim()
      if (value) {
        apiKey = value
        break
      }
    }
  }

  const pkg = str(record.npm) ?? str(record.package) ?? ''
  return {
    baseUrl: str(holder.baseURL),
    // Both spellings of the package name mean the same protocol.
    protocol: pkg.includes('anthropic') ? 'anthropic' : 'openai',
    apiKey,
    // Surfaced so a missing credential can name the variable it looked for.
    credentialEnv: reference ? [reference[1]] : names.length > 0 ? names : undefined,
  }
}

/** Merge the editor's fields into one model record, in place */
function applyModelFields(entry: OpencodeModelRecord, model: AgentModelInput): void {
  if (model.displayName !== undefined) entry.name = model.displayName || model.id
  else if (entry.name === undefined) entry.name = model.id

  if (model.contextLimit !== undefined || model.outputLimit !== undefined) {
    const limit = { ...(asRecord(entry.limit) ?? {}) }
    if (model.contextLimit !== undefined) {
      if (model.contextLimit > 0) limit.context = model.contextLimit
      else delete limit.context
    }
    if (model.outputLimit !== undefined) {
      if (model.outputLimit > 0) limit.output = model.outputLimit
      else delete limit.output
    }
    if (Object.keys(limit).length > 0) entry.limit = limit
    else delete entry.limit
  }

  if (model.inputModalities !== undefined) {
    // Keep whichever spelling this record already used.
    const usesCapabilities = entry.capabilities !== undefined && entry.modalities === undefined
    const holder = usesCapabilities
      ? { ...(asRecord(entry.capabilities) ?? {}) }
      : { ...(asRecord(entry.modalities) ?? {}) }
    holder.input = model.inputModalities.length > 0 ? [...model.inputModalities] : ['text']
    if (!Array.isArray(holder.output)) holder.output = ['text']
    if (usesCapabilities) entry.capabilities = holder
    else entry.modalities = holder
    entry.attachment = model.inputModalities.some((m) => m !== 'text')
  }

  if (model.capabilities !== undefined) {
    entry.tool_call = model.capabilities.includes('tool_use')
    const reasons = model.capabilities.includes('thinking') || model.capabilities.includes('always_thinking')
    entry.reasoning = reasons
    if (reasons) {
      const interleaved = asRecord(entry.interleaved)
      if (interleaved === null) entry.interleaved = { field: 'reasoning_content' }
    }
  }

  if (model.supportEfforts !== undefined) {
    // A level becomes a variant that patches the request body, which is how
    // opencode expresses reasoning effort.
    const existing = { ...(asRecord(entry.variants) ?? {}) }
    const next: Record<string, unknown> = {}
    for (const level of model.supportEfforts) {
      next[level] = existing[level] ?? { body: { reasoning_effort: level } }
    }
    if (Object.keys(next).length > 0) entry.variants = next
    else delete entry.variants
  }
}

/** Apply a provider create/update to the document, in place */
export function applyOpencodeProviderEdit(doc: OpencodeDocument, input: AgentProviderInput): void {
  const { key, map } = providerMap(doc)
  const existing = asRecord(map[input.id]) ?? {}
  const next: OpencodeProviderRecord = { ...existing }

  next.name = input.name || str(existing.name) || input.id
  if (input.protocol) {
    if (existing.package !== undefined && existing.npm === undefined) next.package = input.protocol
    else next.npm = input.protocol
  }

  const holderKey = optionsKey(existing as OpencodeProviderRecord)
  const holder = { ...(asRecord(existing[holderKey]) ?? {}) }
  if (input.baseUrl) holder.baseURL = input.baseUrl
  else delete holder.baseURL

  // Same credential contract as the other agents: undefined keeps, '' clears,
  // a value replaces. An `{env:NAME}` reference is stored text like any other.
  if (input.apiKey !== undefined) {
    if (input.apiKey === '') delete holder.apiKey
    else holder.apiKey = input.apiKey
  }
  next[holderKey] = holder

  const models = { ...(asRecord(existing.models) ?? {}) }
  // Ids being moved by a rename are held back until the move itself runs.
  const keep = new Set<string>()
  for (const model of input.models) {
    keep.add(model.id)
    if (model.originalId && model.originalId !== model.id) keep.add(model.originalId)
  }
  for (const id of Object.keys(models)) if (!keep.has(id)) delete models[id]
  for (const model of input.models) {
    const from = model.originalId && model.originalId !== model.id ? model.originalId : null
    const current = asRecord(from ? models[from] : models[model.id])
    const entry: OpencodeModelRecord = current ? { ...current } : {}
    applyModelFields(entry, model)
    if (from) {
      delete models[from]
      // The top-level default names a model as `provider/id`.
      if (str(doc.model) === `${input.id}/${from}`) doc.model = `${input.id}/${model.id}`
    }
    models[model.id] = entry
  }
  next.models = models as Record<string, OpencodeModelRecord>

  map[input.id] = next
  doc[key] = map
}

/**
 * Remove a provider and clear the default-model pointer when it named one.
 *
 * opencode writes a default as `provider/model`, so the pointer check is a
 * prefix match on the provider id.
 */
export function removeOpencodeProvider(doc: OpencodeDocument, providerId: string): void {
  const { key, map } = providerMap(doc)
  delete map[providerId]
  doc[key] = map

  const current = str(doc.model)
  if (current && current.startsWith(`${providerId}/`)) delete doc.model
}

/** Package names offered in the editor, matching the shape this file uses */
export function opencodePackageChoices(existing: string[]): string[] {
  const base = [
    DEFAULT_PACKAGE,
    '@ai-sdk/anthropic',
    '@ai-sdk/openai',
    '@ai-sdk/google',
  ]
  return [...new Set([...base, ...existing])]
}
