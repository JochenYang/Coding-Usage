/**
 * Human-readable names for provider/router prefixes that tokscale emits in
 * `providerId`. The main process reconciles hardcoded parser defaults (e.g.
 * `moonshot` for every Kimi Code session) to the real router prefix from the
 * model id; this table turns those raw prefixes into display labels. Unknown
 * prefixes keep their raw id so nothing is silently dropped — extend the map
 * here when a new router shows up in the provider distribution.
 */

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  moonshot: 'Moonshot',
  deepseek: 'DeepSeek',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  sensenova: 'SenseNova',
  tokenrouter: 'TokenRouter',
  workbuddy: 'WorkBuddy',
  amdradeoncloud: 'AMD Radeon Cloud',
  grok: 'Grok',
  grokapi2: 'Grok (api2)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  zhipu: 'Z.ai',
  minimax: 'MiniMax',
  siliconflow: 'SiliconFlow',
  novita: 'Novita',
  volcengine: 'Volcengine Ark',
  stepfun: 'StepFun',
  ollama: 'Ollama',
  // Client ids can double as provider ids in router labels; keep them familiar
  kimi: 'Kimi Code',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  trae: 'Trae',
  cline: 'Cline',
  roocode: 'Roo Code',
  kilocode: 'Kilo Code',
  goose: 'Goose',
  zed: 'Zed',
  kiro: 'Kiro',
  augment: 'Augment',
  droid: 'Droid',
  amp: 'Amp',
  dsh: 'DSH',
  zcode: 'ZCode',
  xiaomi: 'Xiaomi MiMo',
}

/** Display label for a tokscale provider id (raw id when unmapped) */
export function displayProviderName(providerId: string): string {
  return PROVIDER_DISPLAY_NAMES[providerId] ?? providerId
}
