import { describe, expect, it } from 'vitest'
import { BUILTIN_PRICING, BUILTIN_PRICING_META } from './builtin-pricing'
import {
  buildModelsFromModelsDev,
  buildModelsFromOpenRouter,
  normalizeModelId,
  priceTokens,
  type PricingTable,
} from './model-pricing-core'

function table(models: Map<string, import('./model-pricing-core').PricingEntry>): PricingTable {
  return { models, source: 'models.dev', fetchedAt: 0, modelCount: models.size }
}

describe('builtin snapshot', () => {
  it('is generated from the official catalogue and carries its date', () => {
    expect(BUILTIN_PRICING_META.source).toBe('models.dev')
    expect(BUILTIN_PRICING_META.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(BUILTIN_PRICING.length).toBe(BUILTIN_PRICING_META.modelCount)
  })

  it('spot-checks official rates rather than reseller listings', () => {
    const byKey = new Map(BUILTIN_PRICING.map((entry) => [entry.k, entry]))
    expect(byKey.get('glm53')).toMatchObject({ i: 1.4 / 1e6, o: 4.4 / 1e6 })
    expect(byKey.get('gpt55')).toMatchObject({ i: 5 / 1e6, o: 30 / 1e6 })
    expect(byKey.get('deepseekv4pro')).toMatchObject({ i: 0.66 / 1e6, o: 1.98 / 1e6 })
  })
})

describe('model pricing projection', () => {
  it('normalizes vendor prefixes and punctuation', () => {
    expect(normalizeModelId('anthropic/claude-opus-4.6')).toBe('claudeopus46')
    expect(normalizeModelId('jochencode/gpt-5.5')).toBe('gpt55')
  })

  it('keeps official store prices and ignores coding-plan zero entries', () => {
    const models = buildModelsFromModelsDev({
      anthropic: { models: { 'claude-opus-4-6': { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } } },
      zai: { models: { 'glm-5.3': { cost: { input: 1.4, output: 4.4, cache_read: 0.26 } } } },
      'zai-coding-plan': { models: { 'glm-5.3': { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
      deepseek: { models: { 'deepseek-v4-pro': { cost: { input: 0.66, output: 1.98, cache_read: 0.022 } } } },
      'alibaba-cn': { models: { 'deepseek-v4-pro': { cost: { input: 99, output: 99 } } } },
    })
    expect(models.get('glm53')).toMatchObject({ i: 1.4 / 1e6, o: 4.4 / 1e6 })
    expect(models.get('deepseekv4pro')).toMatchObject({ i: 0.66 / 1e6, o: 1.98 / 1e6 })
  })

  it('fills missing cache prices from the input rate', () => {
    const models = buildModelsFromModelsDev({
      openai: { models: { 'gpt-5.4': { cost: { input: 2.5, output: 15 } } } },
    })
    expect(models.get('gpt54')).toMatchObject({
      i: 2.5 / 1e6,
      o: 15 / 1e6,
      r: 0.25 / 1e6,
      w: 3.125 / 1e6,
    })
  })

  it('parses context tiers and applies them to the whole request', () => {
    const models = buildModelsFromModelsDev({
      openai: {
        models: {
          'gpt-5.5': {
            cost: {
              input: 5,
              output: 30,
              cache_read: 0.5,
              cache_write: 6.25,
              tiers: [{ tier: { type: 'context', size: 272000 }, input: 10, output: 45, cache_read: 1, cache_write: 12.5 }],
            },
          },
        },
      },
    })
    const t = table(models)
    expect(priceTokens(t, 'gpt-5.5', { input: 272_000, output: 1_000 }, 1)).toBe(
      272_000 * (5 / 1e6) + 1_000 * (30 / 1e6),
    )
    expect(priceTokens(t, 'gpt-5.5', { input: 272_001, output: 1_000 }, 1)).toBe(
      272_001 * (10 / 1e6) + 1_000 * (45 / 1e6),
    )
    // A day aggregate of many requests is not one long context: keep base rates.
    expect(priceTokens(t, 'gpt-5.5', { input: 272_001, output: 1_000 }, 10)).toBe(
      272_001 * (5 / 1e6) + 1_000 * (30 / 1e6),
    )
  })

  it('matches dated snapshot ids from an undated log name', () => {
    const models = buildModelsFromModelsDev({
      anthropic: {
        models: { 'claude-sonnet-4-5-20250929': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } },
      },
    })
    expect(models.has('claudesonnet45')).toBe(true)
    expect(priceTokens(table(models), 'claude-sonnet-4-5', { input: 1_000_000, output: 0 })).toBe(3)
  })

  it('matches router-prefixed ids to the official model', () => {
    const models = buildModelsFromModelsDev({
      deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
    })
    const t = table(models)
    expect(priceTokens(t, 'group/auto-deepseek-v4-flash', { input: 1_000_000 })).toBe(0.15)
    expect(priceTokens(t, 'littlejochen/cn:deepseek-v4-flash', { input: 1_000_000 })).toBe(0.15)
  })

  it('builds the OpenRouter fallback with the same cache defaults', () => {
    const models = buildModelsFromOpenRouter({
      data: [{ id: 'z-ai/glm-5.3', pricing: { prompt: '0.00000008', completion: '0.0000036' } }],
    })
    expect(models.get('glm53')).toMatchObject({
      i: 8e-8,
      o: 3.6e-6,
      r: 8e-9,
      w: 1e-7,
    })
  })

  it('applies known fast-mode multipliers and leaves unknown ones unpriced', () => {
    const models = buildModelsFromModelsDev({
      openai: { models: { 'gpt-5.5': { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } } } },
    })
    const t = table(models)
    expect(priceTokens(t, 'gpt-5.5-fast', { input: 1_000_000 }, 1)).toBe(12.5)
    expect(priceTokens(t, 'gpt-5.5-flex', { input: 1_000_000 }, 1)).toBe(2.5)
    expect(priceTokens(t, 'gpt-5.6-fast', { input: 1_000_000 }, 1)).toBeNull()
  })

  it('carries OpenRouter context overrides as tiers', () => {
    const models = buildModelsFromOpenRouter({
      data: [
        {
          id: 'openai/gpt-6.1-terra',
          pricing: {
            prompt: '0.000001',
            completion: '0.000005',
            overrides: [{ min_prompt_tokens: 272000, prompt: '0.000002', completion: '0.0000075' }],
          },
        },
      ],
    })
    expect(models.get('gpt61terra')?.tiers?.[0]).toMatchObject({
      threshold: 272000,
      i: 0.000002,
      o: 0.0000075,
    })
  })
})
