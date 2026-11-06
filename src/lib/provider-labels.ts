/**
 * Human-readable names for provider/router prefixes that tokscale emits in
 * `providerId`. The main process reconciles hardcoded parser defaults (e.g.
 * `moonshot` for every Kimi Code session) to the real router prefix from the
 * model id; this table turns those raw prefixes into display labels. Unknown
 * prefixes are shown in readable form (kebab/snake slugs become words) so a
 * provider id nothing here has learned yet still looks like a name instead of a
 * config key — extend the map when a router needs a name the slug cannot spell.
 */

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  moonshot: 'Moonshot',
  // Vendor-prefixed spelling some model ids carry (`moonshotai/…`); the local
  // readers normalize it away, but a raw id reaching the provider list should
  // still read as the vendor's name
  moonshotai: 'Moonshot',
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
  'z-ai': 'Z.ai',
  minimax: 'MiniMax',
  // MiniMax Code's internal routing channels; the mcode reader collapses them
  // onto `minimax`, so these only catch the same ids arriving from other clients
  minimax_api: 'MiniMax API',
  'minimax-legacy': 'MiniMax (legacy)',
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
  tencent: 'Tencent',
  qoder: 'Qoder',
  // Cindy's own gateway channel (models with no vendor prefix)
  cindy: 'Cindy',
  'eve-internal': 'EVE (internal)',
}

/**
 * Readable form of a slug id the table does not know.
 *
 * Provider ids arrive as config keys: kebab or snake case (`little-jochen`,
 * `some_vendor`), or all-lowercase runs when the vendor picked one
 * (`tokenrouter`). A slug with separators is turned into words — that is how a
 * gateway vendor's own name reads (`Little Jochen`), without this table having
 * to learn every vendor a gateway will ever add. An id with nothing to split on
 * is left alone rather than guessed at, so a name is never invented.
 */
function titleCaseSlug(id: string): string {
  if (!/[-_]/.test(id)) return id
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Display label for a tokscale provider id: the mapped name, else the id in
 * readable form. Nothing is dropped either way — an id this table has not
 * learned yet still reaches the provider distribution, just formatted.
 */
export function displayProviderName(providerId: string): string {
  return PROVIDER_DISPLAY_NAMES[providerId] ?? titleCaseSlug(providerId)
}
