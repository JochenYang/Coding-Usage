/**
 * Shared contract for the Agent configuration feature.
 *
 * This module is imported by both the Electron main process (to shape what it
 * sends over IPC) and the renderer (to validate what it receives and to build
 * view models). It must therefore stay free of Node and Electron imports.
 *
 * The shapes below are deliberately a common denominator of three agents whose
 * config files share a vocabulary but not a spelling: kimicode writes
 * `type = "openai_responses"` where mcode writes `api = "openai-responses"` and
 * opencode writes an npm package name; reasoning levels are `support_efforts`
 * in one, `thinking.effortOptions` in another, and named `variants` in the
 * third. Normalising happens in the main process so the UI never has to branch
 * on the agent — except where the value is shown or edited, and there the
 * per-agent enums below apply.
 */

export type AgentId = 'kimi' | 'mcode' | 'opencode'

/** Display order and identity of the agents the feature covers */
export const AGENT_IDS: readonly AgentId[] = ['kimi', 'mcode', 'opencode'] as const

/** Narrow an IPC-supplied agent id to a known one */
export function toAgentId(value: unknown): AgentId {
  return value === 'mcode' || value === 'opencode' ? value : 'kimi'
}

/** Protocol values accepted by kimicode's `[providers.<name>].type` */
export const KIMI_PROTOCOLS = ['openai', 'anthropic', 'openai_responses', 'google-genai', 'kimi'] as const

/** Protocol values accepted by mcode's `custom_provider.<id>.api` */
export const MCODE_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/**
 * Runtime packages accepted by opencode's `provider.<id>.npm`.
 *
 * opencode does not name a protocol — the package *is* the protocol — so this
 * list doubles as its protocol picker.
 */
export const OPENCODE_PACKAGES = [
  '@ai-sdk/openai-compatible',
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
] as const

/** Input modalities a model can declare; `text` is always present */
export const MODEL_MODALITIES = ['text', 'image', 'video', 'audio', 'pdf'] as const

/**
 * Capability flags that are really modality markers.
 *
 * kimicode keeps input modalities in the same `capabilities` array as
 * behavioural flags (`image_in` sitting next to `tool_use`), while mcode has a
 * dedicated `modalities.input` list. The two are split apart on read and
 * recombined on write so the editor can present one checkbox group per concept.
 */
export const MODALITY_CAPABILITIES: Record<string, string> = {
  image_in: 'image',
  video_in: 'video',
  audio_in: 'audio',
}

/**
 * Reasoning levels offered in the editor.
 *
 * Neither agent validates an effort against a fixed enum — the accepted set is
 * whatever the model declares — so this is a starting point for the checkboxes
 * rather than a constraint. Levels already present in a config are merged in by
 * the UI, and the write path stores exactly what the user selected.
 *
 * It is also the canonical order a ladder is *stored* in, weakest first. That
 * is not cosmetic: every one of the three agents renders the ladder in the
 * order it appears in its config (opencode lists `variants` in insertion
 * order), so the sequence carries meaning and {@link orderEfforts} is what
 * keeps it from becoming click order.
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Levels that are not rungs on the strength axis but do appear in the same
 * list, with the rank they sort at.
 *
 * kimicode's engine types a level as `'off' | 'on' | string`, and the project's
 * own findings record both as boolean states rather than rungs: `off` means
 * "thinking disabled" and is only legal when the model lacks `always_thinking`,
 * while `on` means "thinks but is not graded". Ranking them with the rungs would
 * sort "off" *above* "max" — the disable switch would sit at the strongest end of
 * the picker — so they get fixed positions instead: off before everything, on
 * just above off.
 */
const EFFORT_STATE_RANK: Record<string, number> = { off: -2, on: -1 }

/** Strength rank of a known level; unknown levels rank last */
const EFFORT_RANK = new Map<string, number>([
  ...Object.entries(EFFORT_STATE_RANK),
  ...EFFORT_LEVELS.map((level, index): [string, number] => [level, index]),
])

/**
 * Sort a ladder into strength order: `off`, `on`, then
 * {@link EFFORT_LEVELS} weakest first.
 *
 * Applied wherever a ladder becomes a stored sequence: the read path so the UI
 * shows what is meant rather than what a previous write left behind, and each
 * agent's write path so the file always carries the canonical order.
 *
 * Levels this module does not know are *placed after* the known ones, keeping
 * their relative order among themselves (`sort` is stable). That is the one
 * judgement call here: the accepted set is whatever the model declares, so an
 * unfamiliar name is assumed to be a rung stronger than any it knows, which is
 * right for a vendor that adds `ultra` above `max` and wrong for a vendor that
 * invents a new non-rung state. Known non-rung states are enumerated in
 * {@link EFFORT_STATE_RANK} for that reason.
 */
export function orderEfforts(levels: readonly string[]): string[] {
  const unknown = EFFORT_LEVELS.length
  const rank = (level: string): number => EFFORT_RANK.get(level) ?? unknown
  return [...levels].sort((a, b) => rank(a) - rank(b))
}

/**
 * How a model's thinking can be controlled.
 *
 * `switchable` / `forced_on` / `forced_off` / `hidden` come from mcode;
 * kimicode expresses the same idea through capability flags, which the main
 * process folds into the first three values so the UI has one field to read.
 */
export type ThinkingMode = 'switchable' | 'forced_on' | 'forced_off' | 'hidden' | 'unknown'

export interface AgentModel {
  /**
   * Bare model id, scoped to its provider — what a user types and what
   * {@link AgentModelInput.id} carries back. kimicode aliases a model as
   * `<provider>/<id>` in the file, and the id itself may contain slashes
   * (`deepseek/deepseek-v4.1-flash`), so only the first slash separates them.
   */
  id: string
  /** Full key as it appears in the config file (equal to `id` for mcode) */
  alias: string
  /** Upstream wire model name (`model` field); defaults to the id */
  model: string
  displayName: string
  /**
   * True when the config file carries an explicit display name.
   *
   * False means `displayName` above is a fallback for rendering only — writing
   * it back would add a field the file never had, so the edit path skips it
   * unless the user actually changes it.
   */
  displayNameExplicit: boolean
  /** Provider id this model belongs to (normalised, per-agent form) */
  providerId: string
  contextLimit?: number
  inputLimit?: number
  outputLimit?: number
  /** Behavioural flags only (tool_use / thinking / always_thinking / …) */
  capabilities: string[]
  /** Input modalities the model accepts; `text` is always present */
  inputModalities: string[]
  /** Selectable reasoning levels, ascending; empty means the model takes none */
  supportEfforts: string[]
  defaultEffort?: string
  offEffort?: string
  reasoningKey?: string
  thinkingMode: ThinkingMode
}

export interface AgentProvider {
  /** Provider key in the config file (kimi section name / mcode key after `custom_provider:`) */
  id: string
  name: string
  /** Raw protocol string as stored in the file */
  protocol: string
  baseUrl?: string
  /** True when a credential is present — the plaintext is never sent unsolicited */
  hasKey: boolean
  /** Masked preview (first 4 + last 4), safe to render without a reveal click */
  maskedKey?: string
  /** mcode only: `enabled` flag */
  enabled?: boolean
  /** True for entries the UI must not treat as ordinary user providers */
  readOnly?: boolean
  /** Why the entry is read-only, for the UI to explain */
  readOnlyReason?: string
  models: AgentModel[]
}

/** One provider/global setting the UI may edit, keyed by agent */
export interface AgentGlobals {
  /** `default_model` / `defaultModel` */
  defaultModel?: string
  /** `default_provider` (kimi only) */
  defaultProvider?: string
  /** `default_permission_mode` (kimi only) */
  defaultPermissionMode?: string
  /** `permissionMode` (mcode only) */
  permissionMode?: string
  /** mcode only: persisted default variant */
  defaultModelVariant?: string
}

export interface AgentConfigPayload {
  agent: AgentId
  /** False when no config file was found for this agent */
  installed: boolean
  /** Absolute path of the file the payload was read from */
  configPath: string | null
  /** Opaque token to send back with a write (CAS); empty when not installed */
  revision: string
  globals: AgentGlobals
  providers: AgentProvider[]
  /** CLI entry points detected on disk — enables validate/test affordances */
  cliAvailable: boolean
  /** Human-readable note about a degraded read (missing file, parse failure) */
  note?: string
}

/** Result of a write attempt, shaped for direct display in the UI */
export interface AgentWriteResult {
  ok: boolean
  /** Backup file created before the overwrite */
  backupPath?: string
  /** Machine-readable failure kind */
  reason?: 'conflict' | 'missing' | 'invalid' | 'failed'
  /** Human-readable detail (never contains a secret) */
  message?: string
}

/** Reveal response: the plaintext credential for exactly one provider */
export interface AgentKeyReveal {
  ok: boolean
  key?: string
  message?: string
}

/** Result of asking a provider which models it serves */
export interface AgentModelListResult {
  ok: boolean
  /** Model ids, de-duplicated and sorted; present when ok */
  models?: string[]
  /** The endpoint that produced the result, so the UI can show what was queried */
  usedUrl?: string
  /** Human-readable failure, never containing the credential */
  message?: string
}

/**
 * Result of sending one minimal request through a configured model.
 *
 * This is a live call, not a configuration check: it costs a handful of tokens
 * and is only ever issued on an explicit click.
 */
export interface AgentModelTestResult {
  ok: boolean
  /** Round-trip time in milliseconds */
  ms?: number
  /** HTTP status when the request completed at all */
  status?: number
  /** Reason on failure, or the endpoint that answered on success */
  message?: string
}

/** Provider payload accepted by a create/update write */
export interface AgentProviderInput {
  /** Existing provider id when editing; undefined when creating */
  originalId?: string
  id: string
  name: string
  protocol: string
  baseUrl?: string
  /**
   * Credential semantics, mirroring kimicode's REST contract:
   *   undefined = keep the stored value, '' = clear it, other = replace it.
   */
  apiKey?: string
  enabled?: boolean
  /** Model ids to keep/create; the order is preserved in the file */
  models: AgentModelInput[]
}

export interface AgentModelInput {
  id: string
  /**
   * Display name to write. Omit unless the user actually changed it: the read
   * path falls back to the wire name for rendering, and sending that fallback
   * back would add a `display_name` the record never had. An empty string
   * clears the stored one.
   */
  displayName?: string
  /**
   * The id this model is stored under today, present only when the user renamed
   * it. A model id is the record's key in the config file, so renaming is a
   * move — the old key is removed, the record is written under the new one, and
   * every pointer into it is rewritten. Without this the write path could only
   * see "an id it did not recognise" and would have to guess whether that meant
   * rename or delete.
   */
  originalId?: string
  model?: string
  contextLimit?: number
  outputLimit?: number
  /** Behavioural flags; undefined leaves the stored set untouched */
  capabilities?: string[]
  /** Input modalities including `text`; undefined leaves the stored set untouched */
  inputModalities?: string[]
  supportEfforts?: string[]
  defaultEffort?: string
  offEffort?: string
  reasoningKey?: string
}

/**
 * True when two lists hold the same members, ignoring order.
 *
 * The write path uses this to leave an array alone when an edit did not really
 * change it: rewriting an identical set would reorder the file for no reason.
 * It is deliberately not used for effort ladders, whose order is meaningful —
 * those are compared with {@link sameSequence} against the canonical order.
 */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((value) => set.has(value))
}

/** True when two lists hold the same items in the same order */
export function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Mask a credential for display: first 4 + last 4, middle elided */export function maskKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 12) return trimmed.length > 0 ? `${trimmed.slice(0, 2)}****` : ''
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`
}

/** Runtime narrowing helpers — IPC payloads are untrusted input by policy */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Like {@link optionalString}, but an empty string is kept.
 *
 * Used for the fields whose write contract is "undefined = keep, '' = clear":
 * collapsing '' to undefined would turn a deliberate clear into a no-op.
 */
function optionalEffort(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseModel(raw: unknown): AgentModel | null {
  if (!isRecord(raw)) return null
  const id = optionalString(raw.id)
  if (!id) return null
  return {
    id,
    alias: optionalString(raw.alias) ?? id,
    model: optionalString(raw.model) ?? id,
    displayName: optionalString(raw.displayName) ?? id,
    displayNameExplicit: raw.displayNameExplicit === true,
    providerId: optionalString(raw.providerId) ?? '',
    contextLimit: optionalNumber(raw.contextLimit),
    inputLimit: optionalNumber(raw.inputLimit),
    outputLimit: optionalNumber(raw.outputLimit),
    capabilities: isStringArray(raw.capabilities) ? raw.capabilities : [],
    inputModalities: isStringArray(raw.inputModalities) ? raw.inputModalities : ['text'],
    supportEfforts: isStringArray(raw.supportEfforts) ? raw.supportEfforts : [],
    defaultEffort: optionalString(raw.defaultEffort),
    offEffort: optionalString(raw.offEffort),
    reasoningKey: optionalString(raw.reasoningKey),
    thinkingMode: (optionalString(raw.thinkingMode) as ThinkingMode | undefined) ?? 'unknown',
  }
}

function parseProvider(raw: unknown): AgentProvider | null {
  if (!isRecord(raw)) return null
  const id = optionalString(raw.id)
  if (!id) return null
  const models = Array.isArray(raw.models)
    ? raw.models.map(parseModel).filter((m): m is AgentModel => m !== null)
    : []
  return {
    id,
    name: optionalString(raw.name) ?? id,
    protocol: optionalString(raw.protocol) ?? '',
    baseUrl: optionalString(raw.baseUrl),
    hasKey: raw.hasKey === true,
    maskedKey: optionalString(raw.maskedKey),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    readOnly: raw.readOnly === true,
    readOnlyReason: optionalString(raw.readOnlyReason),
    models,
  }
}

/**
 * Validate an `agentConfig:read` result.
 *
 * The renderer never trusts the bridge blindly: a malformed payload degrades to
 * an empty, clearly-not-installed state rather than crashing the page.
 */
export function parseAgentConfigPayload(agent: AgentId, raw: unknown): AgentConfigPayload {
  const empty: AgentConfigPayload = {
    agent,
    installed: false,
    configPath: null,
    revision: '',
    globals: {},
    providers: [],
    cliAvailable: false,
    note: 'invalid-payload',
  }
  if (!isRecord(raw)) return empty

  const providers = Array.isArray(raw.providers)
    ? raw.providers.map(parseProvider).filter((p): p is AgentProvider => p !== null)
    : []
  const globalsRaw = isRecord(raw.globals) ? raw.globals : {}

  return {
    agent,
    installed: raw.installed === true,
    configPath: optionalString(raw.configPath) ?? null,
    revision: optionalString(raw.revision) ?? '',
    globals: {
      defaultModel: optionalString(globalsRaw.defaultModel),
      defaultProvider: optionalString(globalsRaw.defaultProvider),
      defaultPermissionMode: optionalString(globalsRaw.defaultPermissionMode),
      permissionMode: optionalString(globalsRaw.permissionMode),
      defaultModelVariant: optionalString(globalsRaw.defaultModelVariant),
    },
    providers,
    cliAvailable: raw.cliAvailable === true,
    note: optionalString(raw.note),
  }
}

/**
 * Validate an `agentConfig:save` payload before it reaches the file layer.
 *
 * IPC input is untrusted even when it comes from our own renderer: a stale
 * build, a rogue extension or a future refactor can all send a shape the main
 * process must not act on. Returns null rather than throwing so the caller can
 * answer with a normal failure result.
 */
export function parseProviderInput(raw: unknown): AgentProviderInput | null {
  if (!isRecord(raw)) return null
  const id = optionalString(raw.id)
  const name = optionalString(raw.name)
  if (!id || !name) return null

  const models: AgentModelInput[] = []
  if (Array.isArray(raw.models)) {
    for (const entry of raw.models) {
      if (!isRecord(entry)) continue
      const modelId = optionalString(entry.id)
      if (!modelId) continue
      models.push({
        id: modelId,
        originalId: optionalString(entry.originalId),
        displayName: optionalString(entry.displayName),
        model: optionalString(entry.model),
        contextLimit: optionalNumber(entry.contextLimit),
        outputLimit: optionalNumber(entry.outputLimit),
        capabilities: isStringArray(entry.capabilities) ? entry.capabilities : undefined,
        inputModalities: isStringArray(entry.inputModalities) ? entry.inputModalities : undefined,
        supportEfforts: isStringArray(entry.supportEfforts) ? entry.supportEfforts : undefined,
        // '' is a real instruction here ("remove the stored default"), so it
        // must survive validation — optionalString would turn it into undefined,
        // which every adapter reads as "keep the stored value".
        defaultEffort: optionalEffort(entry.defaultEffort),
        offEffort: optionalEffort(entry.offEffort),
        reasoningKey: optionalString(entry.reasoningKey),
      })
    }
  }

  return {
    originalId: optionalString(raw.originalId),
    id,
    name,
    protocol: optionalString(raw.protocol) ?? '',
    baseUrl: optionalString(raw.baseUrl),
    // Only a real string is accepted: `undefined` means "keep the stored
    // credential" and must never be synthesised from a masked preview.
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    models,
  }
}

/** Total model count across providers — used by the collapsed summary line */export function countModels(providers: AgentProvider[]): number {
  return providers.reduce((sum, p) => sum + p.models.length, 0)
}

/** Filter providers and their models by a free-text query (id, name, base url, model id) */
export function filterProviders(providers: AgentProvider[], query: string): AgentProvider[] {
  const q = query.trim().toLowerCase()
  if (!q) return providers
  const out: AgentProvider[] = []
  for (const provider of providers) {
    const providerHit =
      provider.id.toLowerCase().includes(q) ||
      provider.name.toLowerCase().includes(q) ||
      (provider.baseUrl ?? '').toLowerCase().includes(q)
    const models = provider.models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.alias.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q),
    )
    if (providerHit) out.push(provider)
    else if (models.length > 0) out.push({ ...provider, models })
  }
  return out
}
