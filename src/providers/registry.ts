import type { ProviderDef } from '../types'
import { opencode } from './opencode'
import { deepseek } from './deepseek'
import { kimi } from './kimi'
import { zhipu } from './zhipu'
import { siliconflow } from './siliconflow'
import { openrouter } from './openrouter'
import { minimax } from './minimax'
import { volcengine } from './volcengine'

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
]

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}
