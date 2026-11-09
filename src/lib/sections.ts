import type { ProviderConfig, ProviderDef, Settings } from '../types'
import { getProviderEntries } from './storage'
import { PROVIDERS } from '../providers/registry'

/**
 * One account of one provider: what the fetch and the alert rules work on.
 *
 * Kept apart from data-context.tsx so the pure grouping logic does not live in a
 * React module; both the visible app and the hidden background cycle window
 * mount the same data layer.
 */
export interface Card {
  def: ProviderDef
  cfg: ProviderConfig
  index: number
  key: string
}

export interface Section {
  def: ProviderDef
  cards: Card[]
}

/** Group enabled, keyed accounts by provider in registry order */
export function buildSections(settings: Settings): Section[] {
  const out: Section[] = []
  for (const def of PROVIDERS) {
    const entries = getProviderEntries(settings, def.id)
    const cards: Card[] = []
    entries.forEach((cfg, i) => {
      if (!cfg.enabled || !cfg.apiKey) return
      cards.push({ def, cfg, index: i, key: `${def.id}-${i}` })
    })
    if (cards.length === 0) continue
    out.push({ def, cards })
  }
  return out
}
