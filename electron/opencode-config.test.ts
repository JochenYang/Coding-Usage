import { describe, expect, it } from 'vitest'
import {
  applyOpencodeProviderEdit,
  parseOpencodeDocument,
  readOpencodePayload,
  readOpencodeProviderEndpoint,
  removeOpencodeProvider,
  revealOpencodeKey,
  serializeOpencodeDocument,
} from './opencode-config'

/**
 * opencode's config.json has two generations in the wild (v1 `provider.<id>.npm
 * + options`, v2 `providers.<id>.package + settings`) and two model-record
 * spellings (`modalities.input` vs `capabilities.input`, variant map vs array).
 * The module writes back whichever shape a record already used — the tests pin
 * that, plus the JSON round-trip fidelity and surgical removal.
 */

const FIXTURE = JSON.stringify(
  {
    $schema: 'https://opencode.ai/config.json',
    model: 'acme/gpt-5',
    provider: {
      acme: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Acme',
        options: {
          baseURL: 'https://api.acme.dev/v1',
          apiKey: '{env:OPENCODE_TEST_ACME_KEY}',
        },
        models: {
          'gpt-5': {
            name: 'GPT 5',
            limit: { context: 400000, output: 32000 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            tool_call: true,
            variants: {
              low: { body: { reasoning_effort: 'low' } },
              high: { body: { reasoning_effort: 'high' } },
            },
          },
          'vision-x': {
            capabilities: { input: ['text', 'audio'] },
            reasoning: true,
            variants: [
              { id: 'high', body: { x: 1 } },
              { id: 'low', body: {} },
            ],
          },
        },
      },
      second: {
        package: '@ai-sdk/anthropic',
        name: 'Second',
        settings: { apiKey: 'sk-second-0001112222' },
        models: {},
      },
      envonly: {
        npm: '@ai-sdk/openai-compatible',
        name: 'EnvOnly',
        options: { baseURL: 'https://env.example.com' },
        env: ['OPENCODE_TEST_MISSING_A', 'OPENCODE_TEST_MISSING_B'],
        models: {},
      },
    },
  },
  null,
  2,
) + '\n'

describe('opencode parse/serialize round trip', () => {
  it('is lossless, byte-stable and ends with a newline', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    const once = serializeOpencodeDocument(doc)
    const twice = serializeOpencodeDocument(parseOpencodeDocument(once))
    expect(twice).toBe(once)
    expect(parseOpencodeDocument(once)).toEqual(doc)
    expect(once.endsWith('\n')).toBe(true)
  })

  it('carries untouched top-level keys through', () => {
    const once = serializeOpencodeDocument(parseOpencodeDocument(FIXTURE))
    expect(once).toContain('"$schema": "https://opencode.ai/config.json"')
  })
})

describe('readOpencodePayload', () => {
  const payload = readOpencodePayload(FIXTURE, '/tmp/opencode.json', false)

  it('reads both config generations from one document', () => {
    const acme = payload.providers.find((p) => p.id === 'acme')
    expect(acme?.protocol).toBe('@ai-sdk/openai-compatible')
    expect(acme?.baseUrl).toBe('https://api.acme.dev/v1')
    const second = payload.providers.find((p) => p.id === 'second')
    expect(second?.protocol).toBe('@ai-sdk/anthropic')
    expect(second?.baseUrl).toBeUndefined()
  })

  it('treats an {env:NAME} credential reference as present without exposing it', () => {
    const acme = payload.providers.find((p) => p.id === 'acme')
    expect(acme?.hasKey).toBe(true)
    expect(acme?.maskedKey).toBe('env:OPENCODE_TEST_ACME_KEY')
  })

  it('shows the provider-level env list, resolved first candidate winning', () => {
    const envonly = payload.providers.find((p) => p.id === 'envonly')
    // Neither variable is set in the test environment: the first candidate is
    // shown so the provider is still visibly env-backed.
    expect(envonly?.hasKey).toBe(false)
    expect(envonly?.maskedKey).toBe('env:OPENCODE_TEST_MISSING_A')
  })

  it('reads the variant map and the variant array as the same ladder concept', () => {
    const acme = payload.providers.find((p) => p.id === 'acme')
    const gpt5 = acme?.models.find((m) => m.id === 'gpt-5')
    expect(gpt5?.supportEfforts).toEqual(['low', 'high'])
    expect(gpt5?.thinkingMode).toBe('switchable')
    // Array-shaped variants also imply a ladder…
    const vision = acme?.models.find((m) => m.id === 'vision-x')
    expect(vision?.supportEfforts).toEqual(['low', 'high'])
    // …and the newer `capabilities.input` spelling is read too.
    expect(vision?.inputModalities).toEqual(['text', 'audio'])
  })

  it('reads the top-level default model global', () => {
    expect(payload.globals.defaultModel).toBe('acme/gpt-5')
  })
})

describe('opencode credentials and endpoints', () => {
  it('never reveals an {env:NAME} reference', () => {
    expect(revealOpencodeKey(FIXTURE, 'acme')).toBeNull()
    expect(revealOpencodeKey(FIXTURE, 'second')).toBe('sk-second-0001112222')
    expect(revealOpencodeKey(FIXTURE, 'missing')).toBeNull()
  })

  it('resolves the env reference for the endpoint request and names the variable', () => {
    process.env.OPENCODE_TEST_ACME_KEY = 'resolved-value'
    try {
      const endpoint = readOpencodeProviderEndpoint(FIXTURE, 'acme')
      expect(endpoint?.apiKey).toBe('resolved-value')
      expect(endpoint?.credentialEnv).toEqual(['OPENCODE_TEST_ACME_KEY'])
      // The package name decides the protocol: openai-compatible → openai.
      expect(endpoint?.protocol).toBe('openai')
    } finally {
      delete process.env.OPENCODE_TEST_ACME_KEY
    }
  })

  it('tries the provider env list in order when no direct credential exists', () => {
    process.env.OPENCODE_TEST_MISSING_B = 'from-env-list'
    try {
      const endpoint = readOpencodeProviderEndpoint(FIXTURE, 'envonly')
      expect(endpoint?.apiKey).toBe('from-env-list')
      expect(endpoint?.credentialEnv).toEqual(['OPENCODE_TEST_MISSING_A', 'OPENCODE_TEST_MISSING_B'])
    } finally {
      delete process.env.OPENCODE_TEST_MISSING_B
    }
  })

  it('maps an anthropic package to the anthropic protocol', () => {
    const endpoint = readOpencodeProviderEndpoint(FIXTURE, 'second')
    expect(endpoint?.protocol).toBe('anthropic')
    expect(endpoint?.apiKey).toBe('sk-second-0001112222')
  })
})

describe('applyOpencodeProviderEdit', () => {
  it('writes back the v2 spelling a record already used', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    applyOpencodeProviderEdit(doc, {
      id: 'second',
      name: 'Second',
      protocol: '@ai-sdk/google',
      baseUrl: 'https://g.example.com',
      apiKey: 'sk-new-2',
      models: [],
    })
    const record = doc.provider?.second
    expect(record?.package).toBe('@ai-sdk/google')
    expect(record?.npm).toBeUndefined()
    expect(record?.settings?.apiKey).toBe('sk-new-2')
    expect(record?.settings?.baseURL).toBe('https://g.example.com')
    expect(record?.options).toBeUndefined()
  })

  it('keeps the credential contract: undefined keeps, empty clears, value replaces', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    const edit = (apiKey?: string) =>
      applyOpencodeProviderEdit(doc, { id: 'second', name: 'second', protocol: '', models: [], apiKey })
    const keyOf = (): unknown => doc.provider?.second?.settings?.apiKey

    edit()
    expect(keyOf()).toBe('sk-second-0001112222')
    edit('')
    expect(keyOf()).toBeUndefined()
    edit('sk-3')
    expect(keyOf()).toBe('sk-3')
  })

  it('completes a context-only limit with the default output budget', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    applyOpencodeProviderEdit(doc, {
      id: 'second',
      name: 'second',
      protocol: '',
      models: [{ id: 'm1', contextLimit: 128000 }],
    })
    // opencode's own schema requires both limit keys — a half-filled limit
    // would drop the whole provider from its picker.
    const limit = doc.provider?.second?.models?.m1?.limit as Record<string, unknown>
    expect(limit.context).toBe(128000)
    expect(limit.output).toBe(16384)
  })

  it('drops a limit that has no context window and keeps an absent one absent', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    applyOpencodeProviderEdit(doc, {
      id: 'second',
      name: 'second',
      protocol: '',
      models: [{ id: 'no-limit' }, { id: 'output-only', outputLimit: 8000 }],
    })
    expect(doc.provider?.second?.models?.['no-limit']?.limit).toBeUndefined()
    expect(doc.provider?.second?.models?.['output-only']?.limit).toBeUndefined()
  })

  it('rewrites an out-of-order variant array in strength order, keeping each patch', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    applyOpencodeProviderEdit(doc, {
      id: 'acme',
      name: 'acme',
      protocol: '',
      models: [{ id: 'vision-x', supportEfforts: ['high', 'low'] }],
    })
    const variants = doc.provider?.acme?.models?.['vision-x']?.variants as Array<Record<string, unknown>>
    expect(variants.map((v) => v.id)).toEqual(['low', 'high'])
    // The `{id, body}` entry the file carried survives the reorder.
    expect(variants.find((v) => v.id === 'high')?.body).toEqual({ x: 1 })
  })

  it('keeps a map-shaped variants object untouched when the ladder is unchanged', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    applyOpencodeProviderEdit(doc, {
      id: 'acme',
      name: 'acme',
      protocol: '',
      models: [{ id: 'gpt-5', supportEfforts: ['low', 'high'] }],
    })
    expect(doc.provider?.acme?.models?.['gpt-5']?.variants).toEqual({
      low: { body: { reasoning_effort: 'low' } },
      high: { body: { reasoning_effort: 'high' } },
    })
  })

  it('moves a renamed model key and rewrites the default-model pointer with it', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    expect(doc.model).toBe('acme/gpt-5')
    applyOpencodeProviderEdit(doc, {
      id: 'acme',
      name: 'acme',
      protocol: '',
      models: [{ id: 'gpt-5.1', originalId: 'gpt-5', model: 'gpt-5.1' }],
    })
    const models = doc.provider?.acme?.models ?? {}
    expect(models['gpt-5']).toBeUndefined()
    expect(models['gpt-5.1']).toBeDefined()
    expect(doc.model).toBe('acme/gpt-5.1')
  })

  it('removes unlisted models of the edited provider and keeps others', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    applyOpencodeProviderEdit(doc, { id: 'acme', name: 'acme', protocol: '', models: [{ id: 'gpt-5' }] })
    const models = doc.provider?.acme?.models ?? {}
    expect(models['gpt-5']).toBeDefined()
    expect(models['vision-x']).toBeUndefined()
    expect(doc.provider?.second).toBeDefined()
  })
})

describe('removeOpencodeProvider', () => {
  it('deletes the target provider and its default-model pointer, keeps the rest', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    removeOpencodeProvider(doc, 'acme')

    expect(doc.provider?.acme).toBeUndefined()
    expect(doc.provider?.second).toBeDefined()
    expect(doc.model).toBeUndefined()
    expect(doc.$schema).toBe('https://opencode.ai/config.json')
  })

  it('keeps the default-model pointer when it names another provider', () => {
    const doc = parseOpencodeDocument(FIXTURE)
    removeOpencodeProvider(doc, 'second')
    expect(doc.provider?.second).toBeUndefined()
    expect(doc.model).toBe('acme/gpt-5')
  })

  it('works on the v2 `providers` spelling too', () => {
    const doc = parseOpencodeDocument(
      JSON.stringify({
        model: 'b2/m',
        providers: {
          b1: { package: '@ai-sdk/openai', settings: { apiKey: 'k1' }, models: {} },
          b2: { package: '@ai-sdk/openai', settings: { apiKey: 'k2' }, models: {} },
        },
      }),
    )
    removeOpencodeProvider(doc, 'b2')
    expect(doc.providers?.b2).toBeUndefined()
    expect(doc.providers?.b1).toBeDefined()
    expect(doc.model).toBeUndefined()
  })
})
