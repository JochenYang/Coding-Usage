import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { maskKey, sameMembers } from '../src/lib/agent-config'
import type {
  AgentConfigPayload,
  AgentGlobals,
  AgentModel,
  AgentModelInput,
  AgentProvider,
  AgentProviderInput,
} from '../src/lib/agent-config'

/**
 * mcode (`~/.minimax/config.yaml`) reader and writer.
 *
 * Two provider trees live in this file and they behave very differently:
 *
 *   provider.*         managed/built-in tree. mcode restores it from its own
 *                      presets on every read, so editing it is pointless —
 *                      it is surfaced read-only, for context.
 *   custom_provider.*  the user's BYOK tree: name / api / options.apiKey /
 *                      options.baseURL / models. This is the editable surface.
 *
 * Everything else (`region`, `region_key_fingerprint`, `nexus`, `migrations`,
 * `minimax_api`, …) is carried through untouched by construction: the whole
 * document is parsed into one object and only the addressed subtree changes.
 *
 * Measured round-trip behaviour (see .tmp/verify-*.mjs): `yaml` re-serialises
 * the real 1155-line file with **100% of lines byte-identical** when the
 * `singleQuote` option is on — without it the file's `'@ai-sdk/anthropic'`
 * style quoting is rewritten to double quotes on every write.
 */

/** Serialisation options that keep mcode's own formatting intact */
const YAML_OPTIONS = { singleQuote: true } as const

/**
 * Provider keys mcode refuses to reuse for user providers. Taken from
 * `provider-key.ts` in the agent's source; a collision would make the entry
 * unreachable rather than merely ugly, so new keys avoid them.
 */
const RESERVED_PROVIDER_KEYS = new Set([
  'minimax',
  'minimax_api',
  'openai-codex',
  'provider',
  'custom_provider',
])

export interface McodeModelRecord {
  name?: unknown
  reasoning?: unknown
  attachment?: unknown
  tool_call?: unknown
  temperature?: unknown
  limit?: { context?: unknown; output?: unknown; input?: unknown }
  modalities?: { input?: unknown; output?: unknown }
  thinking?: { effortOptions?: unknown; defaultEffort?: unknown }
  thinking_config?: { mode?: unknown; default_value?: unknown }
  options?: { reasoningSummary?: unknown }
  [key: string]: unknown
}

export interface McodeProviderRecord {
  name?: unknown
  api?: unknown
  kind?: unknown
  enabled?: unknown
  npm?: unknown
  whitelist?: unknown
  model_order?: unknown
  options?: { apiKey?: unknown; baseURL?: unknown; authMode?: unknown; headers?: unknown }
  models?: Record<string, McodeModelRecord>
  [key: string]: unknown
}

export interface McodeDocument {
  defaultModel?: unknown
  defaultModelVariant?: unknown
  permissionMode?: unknown
  defaultModelThinking?: { effort?: unknown }
  provider?: Record<string, McodeProviderRecord>
  custom_provider?: Record<string, McodeProviderRecord>
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

/** Parse config.yaml; throws with the parser's own message on malformed input */
export function parseMcodeDocument(text: string): McodeDocument {
  const parsed = parseYaml(text)
  const record = asRecord(parsed)
  if (!record) throw new Error('config.yaml did not parse to a mapping')
  return record as McodeDocument
}

/** Serialise the document back to YAML text using mcode-compatible formatting */
export function serializeMcodeDocument(doc: McodeDocument): string {
  return stringifyYaml(doc as Record<string, unknown>, YAML_OPTIONS)
}

/**
 * Split one mcode model record into behaviour flags and input modalities.
 *
 * mcode keeps the two apart natively (`tool_call` / `reasoning` booleans versus
 * `modalities.input`), so this is a straight projection into the vocabulary the
 * shared UI uses — the write path derives the booleans back from it.
 */
function capabilitiesOf(record: McodeModelRecord): {
  capabilities: string[]
  inputModalities: string[]
} {
  const capabilities: string[] = []
  if (record.tool_call === true) capabilities.push('tool_use')
  const mode = str(asRecord(record.thinking_config)?.mode)
  if (mode === 'forced_on') capabilities.push('always_thinking')
  else if (mode === 'switchable' || record.reasoning === true) capabilities.push('thinking')

  const declared = strArray(asRecord(record.modalities)?.input)
  return { capabilities, inputModalities: declared.length > 0 ? declared : ['text'] }
}

function thinkingModeOf(record: McodeModelRecord): AgentModel['thinkingMode'] {
  const mode = str(asRecord(record.thinking_config)?.mode)
  if (mode === 'switchable' || mode === 'forced_on' || mode === 'forced_off' || mode === 'hidden') {
    return mode
  }
  return 'unknown'
}

function toModel(id: string, raw: McodeModelRecord): AgentModel {
  const limit = asRecord(raw.limit) ?? {}
  const thinking = asRecord(raw.thinking) ?? {}
  const { capabilities, inputModalities } = capabilitiesOf(raw)
  return {
    id,
    // mcode keys models by the bare id already, so id and alias coincide.
    alias: id,
    model: id,
    displayName: str(raw.name) ?? id,
    // mcode always writes `name`, so a record read from a file has it.
    displayNameExplicit: str(raw.name) !== undefined,
    providerId: '',
    contextLimit: num(limit.context),
    inputLimit: num(limit.input),
    outputLimit: num(limit.output),
    capabilities,
    inputModalities,
    supportEfforts: strArray(thinking.effortOptions),
    defaultEffort: str(thinking.defaultEffort),
    thinkingMode: thinkingModeOf(raw),
  }
}

function toProvider(
  id: string,
  raw: McodeProviderRecord,
  readOnly: boolean,
  readOnlyReason: string | undefined,
): AgentProvider {
  const options = asRecord(raw.options) ?? {}
  const apiKey = str(options.apiKey)
  const models = asRecord(raw.models) ?? {}
  return {
    id,
    name: str(raw.name) ?? id,
    protocol: str(raw.api) ?? '',
    baseUrl: str(options.baseURL),
    hasKey: Boolean(apiKey),
    maskedKey: apiKey ? maskKey(apiKey) : undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    readOnly,
    readOnlyReason,
    models: Object.entries(models).map(([mid, mraw]) =>
      toModel(mid, (asRecord(mraw) ?? {}) as McodeModelRecord),
    ),
  }
}

/** Split `custom_provider:<key>/<modelId>` into its two halves */
function splitDefaultModel(value: string): { providerKey: string; modelId: string } | null {
  const PREFIX = 'custom_provider:'
  if (!value.startsWith(PREFIX)) return null
  const rest = value.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return { providerKey: rest.slice(0, slash), modelId: rest.slice(slash + 1) }
}

/**
 * Build the IPC payload from config text.
 *
 * The built-in `provider.*` tree is included so the UI can show what mcode
 * manages by itself, but it is flagged read-only: those entries are rebuilt
 * from presets on load, so an edit would silently disappear.
 */
export function readMcodePayload(
  text: string,
  configPath: string,
  cliAvailable: boolean,
): AgentConfigPayload {
  const doc = parseMcodeDocument(text)
  const providers: AgentProvider[] = []

  for (const [id, raw] of Object.entries(asRecord(doc.provider) ?? {})) {
    providers.push(
      toProvider(
        id,
        (asRecord(raw) ?? {}) as McodeProviderRecord,
        true,
        '内置托管 provider：mcode 每次加载都会用官方预设重建它，修改不会保留',
      ),
    )
  }

  const migrations = asRecord(doc.migrations)
  const migratedKeys = new Set<string>()
  if (migrations) {
    for (const entry of Object.values(migrations)) {
      const record = asRecord(asRecord(entry)?.providers)
      if (record) for (const target of Object.values(record)) if (typeof target === 'string') migratedKeys.add(target)
    }
  }

  for (const [id, raw] of Object.entries(asRecord(doc.custom_provider) ?? {})) {
    providers.push(
      toProvider(
        id,
        (asRecord(raw) ?? {}) as McodeProviderRecord,
        false,
        migratedKeys.has(id) ? '由内置 provider 迁移而来（migrations 记录）' : undefined,
      ),
    )
  }

  const globals: AgentGlobals = {
    defaultModel: str(doc.defaultModel),
    permissionMode: str(doc.permissionMode),
    defaultModelVariant: str(doc.defaultModelVariant),
  }

  return {
    agent: 'mcode',
    installed: true,
    configPath,
    revision: '',
    globals,
    providers,
    cliAvailable,
  }
}

/** Plaintext credential of one custom provider, for the reveal action */
export function revealMcodeKey(text: string, providerId: string): string | null {
  const doc = parseMcodeDocument(text)
  const record = asRecord(asRecord(doc.custom_provider)?.[providerId])
  if (!record) return null
  return str(asRecord(record.options)?.apiKey) ?? null
}

/** Endpoint and credential of one custom provider, for the model-list request */
export function readMcodeProviderEndpoint(
  text: string,
  providerId: string,
): { baseUrl?: string; protocol: string; apiKey?: string } | null {
  const doc = parseMcodeDocument(text)
  const record = asRecord(asRecord(doc.custom_provider)?.[providerId])
  if (!record) return null
  const options = asRecord(record.options) ?? {}
  return { baseUrl: str(options.baseURL), protocol: str(record.api) ?? '', apiKey: str(options.apiKey) }
}

/**
 * Derive a provider key from a display name, mcode-style.
 *
 * ASCII names become lowercase kebab; anything else (Chinese, symbols only)
 * falls back to `provider-<6 hex>`. Collisions and reserved keys get a numeric
 * suffix. Once created the key is immutable — renaming it would break every
 * `defaultModel` pointer — so this runs exactly once, at creation.
 */
export function deriveProviderKey(name: string, taken: Set<string>): string {
  const kebab = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = /^[a-z0-9][a-z0-9-]*$/.test(kebab)
    ? kebab
    : `provider-${Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`

  let candidate = RESERVED_PROVIDER_KEYS.has(base) ? `${base}-2` : base
  let suffix = 2
  while (taken.has(candidate) || RESERVED_PROVIDER_KEYS.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

/**
 * Fold the editor's fields into one mcode model record.
 *
 * A field left undefined keeps whatever the record already had. mcode spreads
 * one concept across several keys — `limit`, `modalities`, three booleans and
 * two separate thinking tables — so this is where they are kept consistent with
 * each other (declaring an image modality also turns `attachment` on, and an
 * `always_thinking` flag forces `thinking_config.mode`).
 */
function applyModelFields(entry: McodeModelRecord, model: AgentModelInput): void {
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
    const current = strArray(asRecord(entry.modalities)?.input)
    const next_modalities = model.inputModalities.length > 0 ? [...model.inputModalities] : ['text']
    if (!sameMembers(current, next_modalities)) {
      const modalities = { ...(asRecord(entry.modalities) ?? {}) }
      modalities.input = next_modalities
      if (!Array.isArray(modalities.output)) modalities.output = ['text']
      entry.modalities = modalities
      // `attachment` is mcode's single flag for "accepts more than text".
      entry.attachment = model.inputModalities.some((m) => m !== 'text')
    }
  }

  if (model.capabilities !== undefined) {
    const alwaysThinking = model.capabilities.includes('always_thinking')
    const anyThinking = alwaysThinking || model.capabilities.includes('thinking')
    entry.tool_call = model.capabilities.includes('tool_use')
    entry.reasoning = anyThinking

    const config = { ...(asRecord(entry.thinking_config) ?? {}) }
    const hadConfig = Object.keys(config).length > 0
    if (anyThinking) {
      config.mode = alwaysThinking ? 'forced_on' : 'switchable'
      // Only a record that carried no thinking_config at all gets a default
      // value. Adding one to an existing record would introduce a field the
      // user never touched — the edit writes what changed, not what it thinks
      // the record ought to contain.
      if (!hadConfig && config.default_value === undefined) config.default_value = 'true'
      entry.thinking_config = config
    } else if (hadConfig) {
      entry.thinking_config = { ...config, mode: 'forced_off' }
    }
  }

  if (model.supportEfforts !== undefined || model.defaultEffort !== undefined) {
    const thinking = { ...(asRecord(entry.thinking) ?? {}) }
    if (model.supportEfforts !== undefined) {
      const current = strArray(thinking.effortOptions)
      if (!sameMembers(current, model.supportEfforts)) {
        if (model.supportEfforts.length > 0) thinking.effortOptions = [...model.supportEfforts]
        else delete thinking.effortOptions
      }
    }
    if (model.defaultEffort !== undefined) {
      if (model.defaultEffort) thinking.defaultEffort = model.defaultEffort
      else delete thinking.defaultEffort
    }
    if (Object.keys(thinking).length > 0) entry.thinking = thinking
    else delete entry.thinking
  }
}

/**
 * Apply a provider create/update to the document, in place.
 *
 * `input.id` is the tree key. When `input.originalId` is set and differs, the
 * entry is moved — mcode's `defaultModel` pointer is rewritten in the same
 * pass so the move cannot leave the agent pointing at a key that no longer
 * exists.
 */
export function applyMcodeProviderEdit(doc: McodeDocument, input: AgentProviderInput): {
  /** The key the provider now lives under (may differ from input.originalId) */
  providerKey: string
} {
  const tree = asRecord(doc.custom_provider) ?? {}
  doc.custom_provider = tree as Record<string, McodeProviderRecord>

  const fromKey = input.originalId
  const toKey = input.id
  const existing = (fromKey ? asRecord(tree[fromKey]) : null) ?? {}
  const next: McodeProviderRecord = { ...existing }

  next.name = input.name || str(existing.name) || toKey
  if (input.protocol) next.api = input.protocol
  if (input.enabled !== undefined) next.enabled = input.enabled
  else if (next.enabled === undefined) next.enabled = true
  if (next.kind === undefined) next.kind = 'custom'

  const options = { ...(asRecord(existing.options) ?? {}) }
  if (input.baseUrl) options.baseURL = input.baseUrl
  else delete options.baseURL
  if (options.authMode === undefined) options.authMode = 'api-key'

  // Credential semantics mirror kimicode's REST contract, and this is the one
  // place the masked-read-modify-write hazard could bite: an empty string
  // clears, undefined keeps, anything else replaces. A masked preview must
  // never reach here — the renderer only ever sends a freshly typed value.
  if (input.apiKey !== undefined) {
    if (input.apiKey === '') delete options.apiKey
    else options.apiKey = input.apiKey
  }
  next.options = options as McodeProviderRecord['options']

  const models = { ...(asRecord(existing.models) ?? {}) }
  // Ids being moved by a rename are held back until the move itself runs.
  const keep = new Set<string>()
  for (const model of input.models) {
    keep.add(model.id)
    if (model.originalId && model.originalId !== model.id) keep.add(model.originalId)
  }
  for (const key of Object.keys(models)) if (!keep.has(key)) delete models[key]
  for (const model of input.models) {
    const from = model.originalId && model.originalId !== model.id ? model.originalId : null
    const current = asRecord(from ? models[from] : models[model.id])
    const entry: McodeModelRecord = current ? { ...current } : {}
    applyModelFields(entry, model)
    if (from) {
      delete models[from]
      // mcode names a default model as `custom_provider:<provider>/<id>`.
      const pointer = str(doc.defaultModel)
      if (pointer) {
        const split = splitDefaultModel(pointer)
        if (split && split.providerKey === input.id && split.modelId === from) {
          doc.defaultModel = `custom_provider:${input.id}/${model.id}`
        }
      }
    }
    models[model.id] = entry
  }
  next.models = models as Record<string, McodeModelRecord>

  if (fromKey && fromKey !== toKey) {
    delete tree[fromKey]
    // Move the pointer with the provider so the default model keeps resolving.
    const current = str(doc.defaultModel)
    if (current) {
      const split = splitDefaultModel(current)
      if (split && split.providerKey === fromKey) {
        doc.defaultModel = `custom_provider:${toKey}/${split.modelId}`
      }
    }
  }
  tree[toKey] = next

  return { providerKey: toKey }
}

/**
 * Remove a custom provider and clear the pointers into it.
 *
 * A `defaultModel` left pointing at a removed key is the failure worth
 * preventing: mcode would start every session with an unresolvable model.
 */
export function removeMcodeProvider(doc: McodeDocument, providerKey: string): void {
  const tree = asRecord(doc.custom_provider)
  if (tree) {
    delete tree[providerKey]
    doc.custom_provider = tree as Record<string, McodeProviderRecord>
  }

  const current = str(doc.defaultModel)
  if (current) {
    const split = splitDefaultModel(current)
    if (split && split.providerKey === providerKey) delete doc.defaultModel
  }

  const nexus = asRecord(doc.nexus)
  const nexusModel = asRecord(nexus?.model)
  const nexusProvider = str(nexusModel?.providerID)
  if (nexusModel && nexusProvider === `custom_provider:${providerKey}`) {
    nexusModel.providerID = undefined
    nexusModel.modelID = undefined
  }
}
