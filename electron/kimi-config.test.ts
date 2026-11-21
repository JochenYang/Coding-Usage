import { describe, expect, it } from 'vitest'
import {
  applyKimiProviderEdit,
  parseKimiDocument,
  readKimiPayload,
  readKimiProviderEndpoint,
  removeKimiProvider,
  revealKimiKey,
  serializeKimiDocument,
} from './kimi-config'

/**
 * kimicode's config.toml is user-owned data, and the whole document is parsed
 * and re-serialised on every edit — so the first contract is fidelity: sections
 * this feature does not understand must survive untouched, and a no-op edit
 * must not drift the file. The second contract is surgical removal: deleting a
 * provider clears only what pointed at it, never another provider's sections.
 */

const FIXTURE = `default_model = "acme/gpt-5.6"
default_provider = "acme"
default_permission_mode = "ask"

[providers.acme]
type = "openai_responses"
base_url = "https://api.acme.dev/v1"
api_key = "sk-live-acme-key-000111"

[providers.local]
type = "openai"
api_key_env = "KIMI_TEST_LOCAL_KEY"

[models."acme/gpt-5.6"]
model = "gpt-5.6-2026"
display_name = "GPT 5.6"
provider = "acme"
max_context_size = 400000
max_output_size = 32000
capabilities = ["image_in", "tool_use", "always_thinking"]
support_efforts = ["high", "none", "medium"]
default_effort = "medium"

[models."acme/prefix-orphan"]
model = "gpt-5.6-2026"

[models."local/claude-opus"]
model = "claude-opus-4"
provider = "local"

[models."router/aliased"]
model = "gpt-5.6-2026"
provider = "acme"

[models."weird/owned-by-acme"]
model = "gpt-5.6-2026"
provider = "acme"

[models."x/points-to-ghost"]
model = "x"
provider = "ghost"

[experimental]
dangerously_skip_permissions = true

[[hooks]]
event = "SessionStart"
command = "echo hi"

[thinking]
mode = "high"
`

describe('kimi parse/serialize round trip', () => {
  it('is lossless and byte-stable over a full document', () => {
    const doc = parseKimiDocument(FIXTURE)
    const once = serializeKimiDocument(doc)
    const twice = serializeKimiDocument(parseKimiDocument(once))
    // A second pass must not drift, and no value may change shape or order.
    expect(twice).toBe(once)
    expect(parseKimiDocument(once)).toEqual(doc)
  })

  it('carries the sections this feature does not touch through untouched', () => {
    const once = serializeKimiDocument(parseKimiDocument(FIXTURE))
    expect(once).toContain('[experimental]')
    expect(once).toContain('dangerously_skip_permissions = true')
    expect(once).toContain('[[hooks]]')
    expect(once).toContain('[thinking]')
    expect(once).toContain('mode = "high"')
    expect(once).toContain('default_permission_mode = "ask"')
  })

  it('keeps quoted table headers and unicode values as they were', () => {
    const text = `default_model = "acme/新模型"\n\n[providers."Little Jochen"]\ntype = "anthropic"\n`
    const once = serializeKimiDocument(parseKimiDocument(text))
    expect(once).toContain('[providers."Little Jochen"]')
    expect(parseKimiDocument(once).default_model).toBe('acme/新模型')
  })
})

describe('readKimiPayload', () => {
  const payload = readKimiPayload(FIXTURE, '/tmp/config.toml', false)

  it('groups models by the record provider field, not the alias prefix', () => {
    const acme = payload.providers.find((p) => p.id === 'acme')
    expect(acme).toBeDefined()
    // `router/aliased` and `weird/owned-by-acme` both declare provider = acme.
    expect(acme?.models.map((m) => m.alias)).toContain('router/aliased')
    expect(acme?.models.map((m) => m.alias)).toContain('weird/owned-by-acme')
    expect(payload.providers.some((p) => p.id === 'router')).toBe(false)
  })

  it('puts aliases whose declared provider has no section into a read-only bucket', () => {
    const orphan = payload.providers.find((p) => p.id === '__unlinked__')
    expect(orphan?.readOnly).toBe(true)
    expect(orphan?.models.map((m) => m.alias)).toEqual(['x/points-to-ghost'])
  })

  it('groups a bare alias by its key prefix when no provider field exists', () => {
    const acme = payload.providers.find((p) => p.id === 'acme')
    expect(acme?.models.map((m) => m.alias)).toContain('acme/prefix-orphan')
  })

  it('splits only the first slash of an alias into provider and model id', () => {
    const doc = parseKimiDocument(
      `[providers.acme]\ntype = "openai"\n\n[models."command-goat/deepseek/x-flash"]\nprovider = "acme"\n`,
    )
    const payload = readKimiPayload(serializeKimiDocument(doc), '/tmp/c.toml', true)
    const acme = payload.providers.find((p) => p.id === 'acme')
    expect(acme?.models[0]?.id).toBe('deepseek/x-flash')
    expect(acme?.models[0]?.alias).toBe('command-goat/deepseek/x-flash')
  })

  it('reports an env-declared credential as absent while the variable is unset', () => {
    const provider = payload.providers.find((p) => p.id === 'local')
    expect(provider?.hasKey).toBe(false)
    expect(provider?.maskedKey).toBe('env:KIMI_TEST_LOCAL_KEY')
    expect(provider?.models.length).toBe(1)
  })

  it('sorts providers by name', () => {
    const ids = payload.providers.filter((p) => p.id !== '__unlinked__').map((p) => p.id)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
  })
})

describe('kimi credentials and endpoints', () => {
  it('reveals only the inline api_key, never an env reference', () => {
    expect(revealKimiKey(FIXTURE, 'acme')).toBe('sk-live-acme-key-000111')
    expect(revealKimiKey(FIXTURE, 'local')).toBeNull()
    expect(revealKimiKey(FIXTURE, 'missing')).toBeNull()
  })

  it('resolves an env-named credential for the endpoint request', () => {
    process.env.KIMI_TEST_LOCAL_KEY = 'env-value'
    try {
      const endpoint = readKimiProviderEndpoint(FIXTURE, 'local')
      expect(endpoint?.apiKey).toBe('env-value')
      expect(endpoint?.credentialEnv).toEqual(['KIMI_TEST_LOCAL_KEY'])
    } finally {
      delete process.env.KIMI_TEST_LOCAL_KEY
    }
  })

  it('names the looked-for variable when the credential is missing', () => {
    const endpoint = readKimiProviderEndpoint(FIXTURE, 'local')
    expect(endpoint?.apiKey).toBeUndefined()
    expect(endpoint?.credentialEnv).toEqual(['KIMI_TEST_LOCAL_KEY'])
    expect(endpoint?.protocol).toBe('openai')
  })
})

describe('applyKimiProviderEdit', () => {
  it('creates a provider section and its model alias keys', () => {
    const doc = parseKimiDocument(FIXTURE)
    applyKimiProviderEdit(doc, {
      id: 'new-relay',
      name: 'New Relay',
      protocol: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-new-relay-1234',
      models: [{ id: 'm1', displayName: 'M1' }],
    })
    const once = serializeKimiDocument(doc)
    expect(once).toContain('[providers.new-relay]')
    expect(once).toContain('[models."new-relay/m1"]')
    const record = parseKimiDocument(once).models?.['new-relay/m1']
    expect(record?.model).toBe('m1')
    expect(record?.provider).toBe('new-relay')
    expect(record?.display_name).toBe('M1')
  })

  it('keeps stored credential on undefined, clears on empty string, replaces on a value', () => {
    const doc = parseKimiDocument(FIXTURE)
    applyKimiProviderEdit(doc, { id: 'acme', name: 'acme', protocol: '', models: [] })
    expect(doc.providers?.acme?.api_key).toBe('sk-live-acme-key-000111')

    applyKimiProviderEdit(doc, { id: 'acme', name: 'acme', protocol: '', apiKey: '', models: [] })
    expect(doc.providers?.acme?.api_key).toBeUndefined()
    expect(doc.providers?.acme?.api_key_env).toBeUndefined()

    applyKimiProviderEdit(doc, { id: 'acme', name: 'acme', protocol: '', apiKey: 'sk-2', models: [] })
    expect(doc.providers?.acme?.api_key).toBe('sk-2')
  })

  it('removes unlisted models owned by the provider and keeps everyone else', () => {
    const doc = parseKimiDocument(FIXTURE)
    applyKimiProviderEdit(doc, { id: 'acme', name: 'acme', protocol: '', models: [{ id: 'gpt-5.6' }] })
    const models = doc.models ?? {}
    expect(models['acme/gpt-5.6']).toBeDefined()
    expect(models['router/aliased']).toBeUndefined()
    expect(models['weird/owned-by-acme']).toBeUndefined()
    expect(models['local/claude-opus']).toBeDefined()
    // A bare alias with no `provider` field is shown under the provider by the
    // read path (prefix fallback) but the edit path only reconciles records
    // that declare the provider — it stays on disk. Locked as current
    // behaviour; see notes on the read/write inconsistency.
    expect(models['acme/prefix-orphan']).toBeDefined()
  })

  it('moves a renamed model key and rewrites the default-model pointer with it', () => {
    // A record whose wire name equals its id follows the rename; the fixture's
    // `model` field differs from its id, so a bare record is built here.
    const doc = parseKimiDocument(
      `default_model = "acme/gpt-5.6"\n\n[providers.acme]\ntype = "openai"\n\n[models."acme/gpt-5.6"]\nmodel = "gpt-5.6"\nprovider = "acme"\n`,
    )
    applyKimiProviderEdit(doc, {
      id: 'acme',
      name: 'acme',
      protocol: '',
      models: [{ id: 'gpt-5.6-renamed', originalId: 'gpt-5.6' }],
    })
    const models = doc.models ?? {}
    expect(models['acme/gpt-5.6']).toBeUndefined()
    expect(models['acme/gpt-5.6-renamed']).toBeDefined()
    // The wire name simply followed the id.
    expect(models['acme/gpt-5.6-renamed']?.model).toBe('gpt-5.6-renamed')
    expect(doc.default_model).toBe('acme/gpt-5.6-renamed')
  })

  it('leaves a record pointing at a different upstream name when it is renamed', () => {
    const doc = parseKimiDocument(FIXTURE)
    applyKimiProviderEdit(doc, {
      id: 'acme',
      name: 'acme',
      protocol: '',
      models: [{ id: 'renamed', originalId: 'gpt-5.6', model: 'gpt-5.6-2026' }],
    })
    expect(doc.models?.['acme/renamed']?.model).toBe('gpt-5.6-2026')
  })

  it('rewrites a shuffled effort ladder into canonical order but leaves an unchanged set alone', () => {
    const doc = parseKimiDocument(FIXTURE)
    // Stored: ["high", "none", "medium"] — an edit declaring the same set in
    // canonical order must produce the canonical sequence on disk.
    applyKimiProviderEdit(doc, {
      id: 'acme',
      name: 'acme',
      protocol: '',
      models: [{ id: 'gpt-5.6', supportEfforts: ['none', 'medium', 'high'] }],
    })
    expect(doc.models?.['acme/gpt-5.6']?.support_efforts).toEqual(['none', 'medium', 'high'])

    // An unchanged capability set is not recombined into a reordered array.
    const before = [...((doc.models?.['acme/gpt-5.6']?.capabilities as string[]) ?? [])]
    expect(before).toEqual(['image_in', 'tool_use', 'always_thinking'])
    applyKimiProviderEdit(doc, {
      id: 'acme',
      name: 'acme',
      protocol: '',
      models: [
        {
          id: 'gpt-5.6',
          capabilities: ['tool_use', 'always_thinking'],
          inputModalities: ['text', 'image'],
        },
      ],
    })
    expect(doc.models?.['acme/gpt-5.6']?.capabilities).toEqual(before)
  })
})

describe('removeKimiProvider', () => {
  it('deletes the target section, its owned models and its pointers, and nothing else', () => {
    const doc = parseKimiDocument(FIXTURE)
    removeKimiProvider(doc, 'acme')

    expect(doc.providers?.acme).toBeUndefined()
    expect(doc.providers?.local).toBeDefined()
    const models = doc.models ?? {}
    expect(models['acme/gpt-5.6']).toBeUndefined()
    expect(models['router/aliased']).toBeUndefined()
    expect(models['weird/owned-by-acme']).toBeUndefined()
    expect(models['acme/prefix-orphan']).toBeUndefined()
    expect(models['local/claude-opus']).toBeDefined()
    expect(doc.default_provider).toBeUndefined()
    expect(doc.default_model).toBeUndefined()
    expect(doc.default_permission_mode).toBe('ask')
    expect(doc.experimental).toBeDefined()
    expect(doc.hooks).toBeDefined()
    expect(doc.thinking).toBeDefined()
  })

  it('keeps another provider section and its default pointers when the target differs', () => {
    const doc = parseKimiDocument(FIXTURE)
    removeKimiProvider(doc, 'local')

    expect(doc.providers?.acme).toBeDefined()
    expect(doc.default_provider).toBe('acme')
    expect(doc.default_model).toBe('acme/gpt-5.6')
    expect(doc.models?.['acme/gpt-5.6']).toBeDefined()
  })

  it('survives a document without providers or models tables', () => {
    const doc = parseKimiDocument(`default_model = "acme/only"\n`)
    expect(() => removeKimiProvider(doc, 'acme')).not.toThrow()
    expect(doc.default_model).toBeUndefined()
  })
})
