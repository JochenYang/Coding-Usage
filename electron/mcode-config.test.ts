import { describe, expect, it } from 'vitest'
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

/**
 * mcode's config.yaml holds two provider trees with different rules: the
 * built-in `provider.*` tree is read-only for this feature (mcode rebuilds it
 * from presets), and `custom_provider.*` is the editable BYOK surface. The
 * tests pin that split, the round-trip fidelity of the untouched sections, and
 * the surgical removal contract: deleting one custom provider must clear its
 * `defaultModel` / `nexus` pointers without touching anything else.
 */

const FIXTURE = `region: cn
region_key_fingerprint: fp-abc123
defaultModel: custom_provider:my-relay/k2
defaultModelVariant: high
permissionMode: default
minimax_api:
  endpoint: https://api.minimax.io/v1
nexus:
  model:
    providerID: custom_provider:my-relay
    modelID: k2
migrations:
  m1:
    providers:
      old-relay: my-relay
provider:
  minimax:
    api: openai-completions
    enabled: true
    options:
      baseURL: https://api.minimax.io/v1
      apiKey: mm-builtin-000111
    models:
      abab-6:
        name: ABAB 6
        tool_call: true
custom_provider:
  my-relay:
    api: openai-responses
    kind: custom
    enabled: true
    options:
      authMode: api-key
      baseURL: https://relay.example.com/v1
      apiKey: sk-relay-0001112222
      runtime: '@ai-sdk/anthropic'
    models:
      k2:
        name: K2
        tool_call: true
        reasoning: true
        limit:
          context: 256000
          output: 32000
        modalities:
          input: [text, image]
          output: [text]
        thinking_config:
          mode: switchable
        thinking:
          effortOptions: [high, none, low]
          defaultEffort: low
      m2:
        name: M2
  second-relay:
    api: anthropic-messages
    options:
      baseURL: https://second.example.com
      apiKey: sk-second-3333
    models:
      s1:
        name: S1
`

describe('mcode parse/serialize round trip', () => {
  it('is lossless and byte-stable over a full document', () => {
    const doc = parseMcodeDocument(FIXTURE)
    const once = serializeMcodeDocument(doc)
    const twice = serializeMcodeDocument(parseMcodeDocument(once))
    expect(twice).toBe(once)
    expect(parseMcodeDocument(once)).toEqual(doc)
  })

  it('keeps mcode-style single quoting for strings the parser must quote', () => {
    // Without `singleQuote`, the file's `'@ai-sdk/anthropic'` spelling would
    // be rewritten to double quotes on every write.
    const once = serializeMcodeDocument(parseMcodeDocument(FIXTURE))
    expect(once).toContain("runtime: '@ai-sdk/anthropic'")
  })

  it('carries the untouched top-level sections through', () => {
    const once = serializeMcodeDocument(parseMcodeDocument(FIXTURE))
    expect(once).toContain('region: cn')
    expect(once).toContain('region_key_fingerprint: fp-abc123')
    expect(once).toContain('minimax_api:')
    expect(once).toContain('permissionMode: default')
  })
})

describe('readMcodePayload', () => {
  const payload = readMcodePayload(FIXTURE, '/tmp/config.yaml', true)

  it('surfaces the built-in provider tree as read-only', () => {
    const builtIn = payload.providers.find((p) => p.id === 'minimax')
    expect(builtIn?.readOnly).toBe(true)
    expect(builtIn?.readOnlyReason).toContain('内置托管')
    expect(builtIn?.hasKey).toBe(true)
    expect(builtIn?.maskedKey).toBe('mm-b****0111')
  })

  it('marks custom providers migrated from the built-in tree', () => {
    const migrated = payload.providers.find((p) => p.id === 'my-relay')
    expect(migrated?.readOnly).toBe(false)
    expect(migrated?.readOnlyReason).toContain('migrations')
    const plain = payload.providers.find((p) => p.id === 'second-relay')
    expect(plain?.readOnlyReason).toBeUndefined()
  })

  it('projects the mcode model record onto the shared shape', () => {
    const provider = payload.providers.find((p) => p.id === 'my-relay')
    const model = provider?.models[0]
    expect(model?.id).toBe('k2')
    expect(model?.displayName).toBe('K2')
    expect(model?.displayNameExplicit).toBe(true)
    expect(model?.capabilities).toEqual(['tool_use', 'thinking'])
    expect(model?.inputModalities).toEqual(['text', 'image'])
    expect(model?.supportEfforts).toEqual(['none', 'low', 'high'])
    expect(model?.defaultEffort).toBe('low')
    expect(model?.contextLimit).toBe(256000)
    expect(model?.outputLimit).toBe(32000)
    expect(model?.thinkingMode).toBe('switchable')
  })

  it('defaults input modalities to text when none are declared', () => {
    const second = payload.providers.find((p) => p.id === 'second-relay')
    expect(second?.models[0]?.inputModalities).toEqual(['text'])
  })

  it('reads the default-model globals', () => {
    expect(payload.globals.defaultModel).toBe('custom_provider:my-relay/k2')
    expect(payload.globals.permissionMode).toBe('default')
    expect(payload.globals.defaultModelVariant).toBe('high')
  })
})

describe('mcode credentials and endpoints', () => {
  it('reveals the custom provider key and nothing from the built-in tree', () => {
    expect(revealMcodeKey(FIXTURE, 'my-relay')).toBe('sk-relay-0001112222')
    expect(revealMcodeKey(FIXTURE, 'minimax')).toBeNull()
    expect(revealMcodeKey(FIXTURE, 'missing')).toBeNull()
  })

  it('reads endpoint and credential from custom_provider options only', () => {
    const endpoint = readMcodeProviderEndpoint(FIXTURE, 'my-relay')
    expect(endpoint?.baseUrl).toBe('https://relay.example.com/v1')
    expect(endpoint?.protocol).toBe('openai-responses')
    expect(endpoint?.apiKey).toBe('sk-relay-0001112222')
    expect(readMcodeProviderEndpoint(FIXTURE, 'minimax')).toBeNull()
  })
})

describe('deriveProviderKey', () => {
  it('kebab-cases an ASCII display name', () => {
    expect(deriveProviderKey('My Relay!', new Set())).toBe('my-relay')
  })

  it('falls back to a random provider-<hex> key for non-ASCII names', () => {
    expect(deriveProviderKey('小红书', new Set())).toMatch(/^provider-[0-9a-f]{6}$/)
  })

  it('avoids reserved keys', () => {
    expect(deriveProviderKey('minimax', new Set())).toBe('minimax-2')
    expect(deriveProviderKey('openai-codex', new Set())).toBe('openai-codex-2')
  })

  it('suffixes a key that is already taken', () => {
    expect(deriveProviderKey('My Relay', new Set(['my-relay']))).toBe('my-relay-2')
  })
})

describe('applyMcodeProviderEdit', () => {
  it('creates a custom provider with mcode defaults filled in', () => {
    const doc = parseMcodeDocument(FIXTURE)
    applyMcodeProviderEdit(doc, {
      id: 'new-relay',
      name: 'New Relay',
      protocol: 'openai-responses',
      baseUrl: 'https://n.example.com/v1',
      apiKey: 'sk-new-1',
      models: [{ id: 'm1' }],
    })
    const created = doc.custom_provider?.['new-relay']
    expect(created?.enabled).toBe(true)
    expect(created?.kind).toBe('custom')
    expect(created?.api).toBe('openai-responses')
    const options = created?.options as Record<string, unknown>
    expect(options.authMode).toBe('api-key')
    expect(options.apiKey).toBe('sk-new-1')
    expect((created?.models?.m1 as Record<string, unknown>)?.name).toBe('m1')
  })

  it('does not disturb the built-in provider tree', () => {
    const doc = parseMcodeDocument(FIXTURE)
    applyMcodeProviderEdit(doc, {
      id: 'new-relay',
      name: 'New Relay',
      protocol: 'openai-responses',
      models: [],
    })
    expect(doc.provider?.minimax).toBeDefined()
    expect(doc.minimax_api).toBeDefined()
  })

  it('follows the credential contract: undefined keeps, empty clears, value replaces', () => {
    const doc = parseMcodeDocument(FIXTURE)
    // Updates of an existing provider carry originalId — that is how the
    // service tells an edit apart from a create (whose key is derived).
    const edit = (apiKey?: string) =>
      applyMcodeProviderEdit(doc, {
        originalId: 'my-relay',
        id: 'my-relay',
        name: 'my-relay',
        protocol: '',
        models: [],
        apiKey,
      })
    const apiKeyOf = (): unknown => doc.custom_provider?.['my-relay']?.options?.apiKey

    edit()
    expect(apiKeyOf()).toBe('sk-relay-0001112222')
    edit('')
    expect(apiKeyOf()).toBeUndefined()
    edit('sk-3')
    expect(apiKeyOf()).toBe('sk-3')
  })

  it('clears baseURL when the edit carries no baseUrl', () => {
    const doc = parseMcodeDocument(FIXTURE)
    applyMcodeProviderEdit(doc, {
      originalId: 'my-relay',
      id: 'my-relay',
      name: 'my-relay',
      protocol: '',
      models: [],
    })
    expect(doc.custom_provider?.['my-relay']?.options?.baseURL).toBeUndefined()
  })

  it('moves a renamed provider key and rewrites the defaultModel pointer with it', () => {
    const doc = parseMcodeDocument(FIXTURE)
    applyMcodeProviderEdit(doc, {
      originalId: 'my-relay',
      id: 'renamed-relay',
      name: 'Renamed Relay',
      protocol: '',
      models: [{ id: 'k2' }],
    })
    expect(doc.custom_provider?.['my-relay']).toBeUndefined()
    expect(doc.custom_provider?.['renamed-relay']).toBeDefined()
    expect(doc.defaultModel).toBe('custom_provider:renamed-relay/k2')
    expect(doc.nexus).toEqual({
      model: { providerID: 'custom_provider:my-relay', modelID: 'k2' },
    })
  })

  it('rewrites the defaultModel pointer when a model id is renamed', () => {
    const doc = parseMcodeDocument(FIXTURE)
    applyMcodeProviderEdit(doc, {
      originalId: 'my-relay',
      id: 'my-relay',
      name: 'my-relay',
      protocol: '',
      models: [{ id: 'k3', originalId: 'k2' }],
    })
    expect(doc.defaultModel).toBe('custom_provider:my-relay/k3')
    expect(doc.custom_provider?.['my-relay']?.models?.k2).toBeUndefined()
    expect(doc.custom_provider?.['my-relay']?.models?.k3).toBeDefined()
  })

  it('removes unlisted models of the edited provider and keeps other providers', () => {
    const doc = parseMcodeDocument(FIXTURE)
    applyMcodeProviderEdit(doc, {
      originalId: 'my-relay',
      id: 'my-relay',
      name: 'my-relay',
      protocol: '',
      models: [{ id: 'k2' }],
    })
    expect(doc.custom_provider?.['my-relay']?.models?.k2).toBeDefined()
    expect(doc.custom_provider?.['my-relay']?.models?.m2).toBeUndefined()
    expect(doc.custom_provider?.['second-relay']?.models?.s1).toBeDefined()
  })

  it('fills thinking mode and attachment when capabilities are declared', () => {
    const doc = parseMcodeDocument(FIXTURE)
    applyMcodeProviderEdit(doc, {
      originalId: 'second-relay',
      id: 'second-relay',
      name: 'second-relay',
      protocol: '',
      models: [
        {
          id: 's1',
          capabilities: ['tool_use', 'always_thinking'],
          inputModalities: ['text', 'image'],
        },
      ],
    })
    const model = doc.custom_provider?.['second-relay']?.models?.s1
    expect(model?.tool_call).toBe(true)
    expect(model?.reasoning).toBe(true)
    expect((model?.thinking_config as Record<string, unknown>)?.mode).toBe('forced_on')
    expect(model?.attachment).toBe(true)
  })
})

describe('removeMcodeProvider', () => {
  it('deletes the target custom provider, its defaultModel pointer and the nexus pointer', () => {
    const doc = parseMcodeDocument(FIXTURE)
    removeMcodeProvider(doc, 'my-relay')

    expect(doc.custom_provider?.['my-relay']).toBeUndefined()
    expect(doc.custom_provider?.['second-relay']).toBeDefined()
    expect(doc.defaultModel).toBeUndefined()
    // `nexus` is not a declared field on the document interface — the module
    // clears the pointer through the index signature.
    const nexusModel = (doc.nexus as Record<string, unknown> | undefined)?.model as
      | Record<string, unknown>
      | undefined
    expect(nexusModel?.providerID).toBeUndefined()
    expect(nexusModel?.modelID).toBeUndefined()
  })

  it('keeps another provider and its pointers when the target differs', () => {
    const doc = parseMcodeDocument(FIXTURE)
    removeMcodeProvider(doc, 'second-relay')

    expect(doc.custom_provider?.['my-relay']).toBeDefined()
    expect(doc.defaultModel).toBe('custom_provider:my-relay/k2')
    expect(doc.nexus).toEqual({ model: { providerID: 'custom_provider:my-relay', modelID: 'k2' } })
  })

  it('never deletes from the built-in provider tree', () => {
    const doc = parseMcodeDocument(FIXTURE)
    removeMcodeProvider(doc, 'minimax')
    expect(doc.provider?.minimax).toBeDefined()
  })

  it('survives a document without custom_provider or nexus', () => {
    const doc = parseMcodeDocument(`defaultModel: custom_provider:gone/x\n`)
    expect(() => removeMcodeProvider(doc, 'gone')).not.toThrow()
    expect(doc.defaultModel).toBeUndefined()
  })
})
