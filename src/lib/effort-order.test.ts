import { describe, expect, it } from 'vitest'
import { applyKimiProviderEdit, parseKimiDocument, serializeKimiDocument } from '../../electron/kimi-config'
import { applyMcodeProviderEdit, parseMcodeDocument, serializeMcodeDocument } from '../../electron/mcode-config'
import {
  applyOpencodeProviderEdit,
  parseOpencodeDocument,
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
    expect(Object.keys(variants ?? {})).toEqual(['none', 'low', 'max'])
    expect(variants?.max).toEqual({ body: { reasoning_effort: 'max' } })
  })

  it('drops variants when the ladder is emptied', () => {
    expect(JSON.parse(write({ supportEfforts: [] })).provider.gw.models.m1.variants).toBeUndefined()
  })

  it('does not rewrite a ladder that is already canonical', () => {
    // The unedited round trip this project protects: a save that changes
    // nothing must not touch a correctly ordered ladder.
    const source = JSON.stringify({
      provider: { gw: { models: { m1: { variants: { none: { body: {} }, low: { body: {} }, high: { body: {} } } } } } },
    })
    const doc = parseOpencodeDocument(source)
    applyOpencodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: '',
      models: [{ id: 'm1', supportEfforts: ['none', 'low', 'high'] }],
    })
    // Scoped to the ladder: the save also completes unrelated record fields
    // (name, options), which is separate behaviour.
    const after = JSON.parse(serializeOpencodeDocument(doc)).provider.gw.models.m1
    expect(Object.keys(after.variants)).toEqual(['none', 'low', 'high'])
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
    // Compared against the serialiser's own round trip rather than the source
    // text: smol-toml normalises quoting, which is unrelated to this fix.
    const untouched = serializeKimiDocument(parseKimiDocument(orderedSource))
    expect(write(orderedSource, CANONICAL)).toBe(untouched)
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
    applyMcodeProviderEdit(doc, {
      id: 'gw',
      name: 'gw',
      protocol: 'openai-completions',
      models: [{ id: 'm1', supportEfforts: CANONICAL }],
    })
    // Scoped to the ladder: the save also completes unrelated record fields.
    const after = parseMcodeDocument(serializeMcodeDocument(doc))
    expect(after.custom_provider?.gw?.models?.m1?.thinking?.effortOptions).toEqual(CANONICAL)
  })
})
