import type { ProviderDef } from '../types'
import { opencode } from './opencode'
import { deepseek } from './deepseek'
import { kimi } from './kimi'
import { zhipu } from './zhipu'
import { siliconflow } from './siliconflow'
import { openrouter } from './openrouter'
import { minimax } from './minimax'
import { volcengine } from './volcengine'
import { stepfun } from './stepfun'
import { novita } from './novita'
import { commandcode } from './commandcode'
import { ollamaCloud } from './ollama-cloud'

/** Add a new provider: write an adapter file and register it below */
export const PROVIDERS: ProviderDef[] = [
  opencode,
  zhipu,
  kimi,
  deepseek,
  siliconflow,
  openrouter,
  minimax,
  volcengine,
  stepfun,
  novita,
  commandcode,
  ollamaCloud,
]

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/**
 * Providers sorted by display name for pickers and grids. Registry order is
 * chronological (new adapters append at the end), which reads as arbitrary
 * once the list grows; sorting by the name the user actually scans keeps the
 * add-account menu, the providers grid and the accounts page in one order.
 */
export function providersByName(): ProviderDef[] {
  return [...PROVIDERS].sort((a, b) => a.name.localeCompare(b.name))
}
