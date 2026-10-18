import { describe, expect, it } from 'vitest'
import { applyKimiProviderEdit, parseKimiDocument, serializeKimiDocument } from '../../electron/kimi-config'
import { applyMcodeProviderEdit, parseMcodeDocument, serializeMcodeDocument } from '../../electron/mcode-config'
import {
  applyOpencodeProviderEdit,
  parseOpencodeDocument,
  readOpencodePayload,
  serializeOpencodeDocument,
} from '../../electron/opencode-config'

/**
 * Regression: a reasoning ladder is a displayed sequence, not a set.
 *
 * Every agent renders the levels in the order its config stores them, and the
 * editor used to send whatever order the checkboxes were clicked in. Saving a
 * provider therefore rewrote a correctly ordered ladder into a disordered one —
 * opencode then showed Default / low / high / medium / none.
 */
const SHUFFLED = ['high', 'none', 'max', 'low']
const CANONICAL = ['none', 'low', 'high', 'max']

describe('opencode variants', () => {
  const fixture = (variants: Record<string, unknown>): string =>
    JSON.stringify({ provider: { gw: { npm: '@ai-sdk/openai-compatible', models: { m1: { variants } } } } })

  const shuffleFixture = (): string =>
    fixture({ high: { body: {} }, none: { body: {} }, max: { body: {} }, low: { body: {} } })

  const write = (overrides: { supportEfforts?: string[] }): string => {
    const doc = parseOpencodeDocument(shuffleFixture())
    applyOpencodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: '',
      models: [{ id: 'm1', supportEfforts: overrides.supportEfforts ?? SHUFFLED }],
    })
    return serializeOpencodeDocument(doc)
  }

  it('writes a shuffled ladder in strength order', () => {
    const variants = JSON.parse(write({})).provider.gw.models.m1.variants
    expect(Object.keys(variants)).toEqual(CANONICAL)
  })

  it('preserves each variant body while reordering the keys', () => {
    const variants = JSON.parse(write({})).provider.gw.models.m1.variants
    expect(variants.high).toEqual({ body: {} })
  })

  it('creates a missing level with the reasoning_effort patch', () => {
    const doc = parseOpencodeDocument(fixture({ none: { body: {} } }))
    applyOpencodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: '',
      models: [{ id: 'm1', supportEfforts: ['max', 'none', 'low'] }],
    })
    const variants = parseOpencodeDocument(serializeOpencodeDocument(doc)).provider?.gw?.models?.m1?.variants
    const map = variants as Record<string, unknown>
    expect(Object.keys(map)).toEqual(['none', 'low', 'max'])
    expect(map.max).toEqual({ body: { reasoning_effort: 'max' } })
  })

  it('drops variants when the ladder is emptied', () => {
    expect(JSON.parse(write({ supportEfforts: [] })).provider.gw.models.m1.variants).toBeUndefined()
  })

  it('reads and preserves the v2 array spelling', () => {
    // The v2 native shape is an array of `{id, …}` entries. Reading only the map
    // made such a record look like a model with no levels, and saving then
    // deleted the whole field — every variant body with it.
    const source = JSON.stringify({
      providers: {
        gw: {
          package: '@ai-sdk/openai-compatible',
          models: {
            m1: {
              variants: [
                { id: 'high', body: { reasoning_effort: 'high', extra: 'keep-me' } },
                { id: 'none', body: { reasoning_effort: 'none' } },
              ],
            },
          },
        },
      },
    })
    const payload = readOpencodePayload(source, 'x', false)
    expect(payload.providers[0].models[0].supportEfforts).toEqual(['none', 'high'])

    const doc = parseOpencodeDocument(source)
    applyOpencodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: '@ai-sdk/openai-compatible',
      models: [{ id: 'm1', supportEfforts: ['none', 'high'] }],
    })
    const out = JSON.parse(serializeOpencodeDocument(doc)).providers.gw.models.m1.variants
    expect(Array.isArray(out)).toBe(true)
    expect(out.map((v: { id: string }) => v.id)).toEqual(['none', 'high'])
    // The entry's own fields survive the reorder.
    expect(out[1]).toEqual({ id: 'high', body: { reasoning_effort: 'high', extra: 'keep-me' } })
  })

  it('does not rewrite a ladder that is already canonical', () => {
    // The unedited round trip this project protects: a save that changes
    // nothing must not touch a correctly ordered ladder.
    const source = JSON.stringify({
      provider: { gw: { models: { m1: { variants: { none: { body: {} }, low: { body: {} }, high: { body: {} } } } } } },
    })
    const doc = parseOpencodeDocument(source)
    // The reference is the observable: asserting only the resulting key order
    // cannot tell a rewrite from a no-op, because both produce the same order.
    const before = doc.provider?.gw?.models?.m1?.variants
    applyOpencodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: '',
      models: [{ id: 'm1', supportEfforts: ['none', 'low', 'high'] }],
    })
    expect(doc.provider?.gw?.models?.m1?.variants).toBe(before)
  })
})

describe('kimicode support_efforts', () => {
  const orderedSource = [
    '[providers.gw]',
    "type = 'openai'",
    '',
    '[models."gw/m1"]',
    'support_efforts = [ "none", "low", "high", "max" ]',
    '',
  ].join('\n')

  const shuffledSource = orderedSource.replace(
    'support_efforts = [ "none", "low", "high", "max" ]',
    'support_efforts = [ "high", "none", "max", "low" ]',
  )

  const write = (source: string, efforts: string[]): string => {
    const doc = parseKimiDocument(source)
    applyKimiProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: 'openai',
      models: [{ id: 'm1', supportEfforts: efforts }],
    })
    return serializeKimiDocument(doc)
  }

  it('rewrites a stored shuffled ladder into strength order', () => {
    const record = parseKimiDocument(write(shuffledSource, SHUFFLED)).models?.['gw/m1'] as Record<string, unknown>
    expect(record.support_efforts).toEqual(CANONICAL)
  })

  it('leaves an already ordered ladder untouched', () => {
    // Reference identity, not the serialised text: writing the same array back
    // produces identical TOML, so only the reference proves no rewrite happened.
    const doc = parseKimiDocument(orderedSource)
    const before = (doc.models?.['gw/m1'] as Record<string, unknown> | undefined)?.support_efforts
    applyKimiProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: 'openai',
      models: [{ id: 'm1', supportEfforts: CANONICAL }],
    })
    const after = (doc.models?.['gw/m1'] as Record<string, unknown> | undefined)?.support_efforts
    expect(after).toBe(before)
  })

  it('clears a default effort that is no longer in the ladder', () => {
    // '' means "delete", undefined means "keep" — the editor sends '' when the
    // user clears the field, so the write path must honour it. Otherwise the
    // record keeps a default pointing at a level it no longer declares.
    const withDefault = orderedSource.replace(
      'support_efforts = [ "none", "low", "high", "max" ]',
      'support_efforts = [ "none", "low", "high", "max" ]\ndefault_effort = "max"',
    )
    const doc = parseKimiDocument(withDefault)
    applyKimiProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: 'openai',
      models: [{ id: 'm1', supportEfforts: ['none', 'low'], defaultEffort: '' }],
    })
    const record = parseKimiDocument(serializeKimiDocument(doc)).models?.['gw/m1'] as Record<string, unknown>
    expect(record.default_effort).toBeUndefined()
    expect(record.support_efforts).toEqual(['none', 'low'])
  })
})

describe('mcode thinking.effortOptions', () => {
  const source = [
    'custom_provider:',
    '  gw:',
    '    name: gw',
    '    api: openai-completions',
    '    models:',
    '      m1:',
    '        thinking:',
    '          effortOptions:',
    '            - high',
    '            - none',
    '            - max',
    '            - low',
    '',
  ].join('\n')

  it('writes a shuffled ladder in strength order', () => {
    const doc = parseMcodeDocument(source)
    applyMcodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: 'openai-completions',
      models: [{ id: 'm1', supportEfforts: SHUFFLED }],
    })
    const out = parseMcodeDocument(serializeMcodeDocument(doc))
    expect(out.custom_provider?.gw?.models?.m1?.thinking?.effortOptions).toEqual(CANONICAL)
  })

  it('does not rewrite a ladder that is already canonical', () => {
    const canonicalSource = [
      'custom_provider:',
      '  gw:',
      '    name: gw',
      '    api: openai-completions',
      '    models:',
      '      m1:',
      '        thinking:',
      '          effortOptions:',
      '            - none',
      '            - low',
      '            - high',
      '            - max',
      '',
    ].join('\n')
    const doc = parseMcodeDocument(canonicalSource)
    // mcode rebuilds the enclosing `thinking` object on every save, and a
    // rewrite of an already-canonical ladder produces byte-identical output, so
    // no assertion on this adapter can distinguish the two. This pins the
    // behaviour that is observable: the ladder survives unchanged. The gating
    // itself is covered on the two adapters where it IS observable (opencode
    // and kimicode, both by reference identity).
    const before = [...((doc.custom_provider?.gw?.models?.m1?.thinking?.effortOptions ?? []) as string[])]
    applyMcodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: 'openai-completions',
      models: [{ id: 'm1', supportEfforts: CANONICAL }],
    })
    const after = doc.custom_provider?.gw?.models?.m1?.thinking?.effortOptions
    expect(after).toEqual(before)
  })
})
