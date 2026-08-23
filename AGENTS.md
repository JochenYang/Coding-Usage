# AGENTS.md

> Project-level guidance for `coding-usage`. Inherits priority and conventions from the user-level AGENTS.md. This file only adds project-specific hard constraints and collaboration details. In case of conflict, higher-priority directives take precedence.

## Project Overview

A pure static React 19 + Vite 7 + TypeScript strict usage dashboard. Tech stack:

- **Styling**: Tailwind CSS v4 (`@theme` token driven)
- **Animation / Interaction**: `motion/react` + self-built `src/components/beui/*` (Switch / Loader / Drawer / Select / Popover)
- **Icons**: `lucide-react` (unified linear) + `lobehub icons` CDN (Provider brands) + inline SVG (SiliconFlow)
- **State**: React 19 hooks + `localStorage`, no third-party state library
- **Build**: Vite 7 + TypeScript 5 strict
- **Runtime**: Pure static `dist/`; all provider APIs are called directly from the browser (except OpenCode Zen which goes through the local proxy)

Supported Providers: OpenCode Zen Go, Zhipu GLM (Z.ai), Kimi / Moonshot, DeepSeek, SiliconFlow, OpenRouter, MiniMax Token Plan. Each provider supports multiple accounts. API keys are stored in plain text in `localStorage` (v2 key `coding-usage.settings.v2`, with automatic v1 migration).

## Directory Structure

```
src/
  App.tsx                # Main page + smart refresh scheduler
  main.tsx               # ReactDOM entry
  types.ts               # Shared type definitions
  components/
    Header.tsx           # Top bar (auto-refresh / refresh-all / settings / theme / locale / GitHub)
    SettingsPanel.tsx    # Settings drawer body (multi-account entry editing + testing)
    ProviderCard.tsx     # Single provider card
    MetricList.tsx       # Three metric renderers (percent / balance / expiry)
    ProviderLogo.tsx     # Brand logo (CDN + fallback letter)
    ResetCountdown.tsx   # Relative reset countdown
    LocaleSwitcher.tsx   # Language switcher
    beui/                # Self-built components: drawer / loader / switch / select / popover
    logos/               # Inline SVG brand logos (SiliconFlow)
  providers/             # Provider adapters (implementing ProviderDef)
    registry.ts          # PROVIDERS list + getProvider
    opencode / zhipu / kimi / deepseek / siliconflow / openrouter / minimax
  lib/
    cn.ts                # clsx + tailwind-merge
    format.ts            # Countdown / amount / relative time
    metric-helpers.ts    # UNLIMITED_KEY shared constant
    motion-presets.ts    # EASE_OUT / EASE_IN_OUT / SPRING_*
    query.ts             # fetchUsage + local proxy ping/fetch
    storage.ts           # loadSettings / saveSettings / v1→v2 migration
  i18n/                  # Locale dictionaries (zh-CN, en-US) + LocaleProvider + useT
```

## Development Commands

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b + vite build, output to dist/
npm run preview    # Preview dist/
npm run proxy      # OpenCode Zen local proxy (127.0.0.1:8787, whitelist forward to opencode.ai)
```

The proxy only listens on the loopback interface, forwards by domain whitelist, and never prints or persists API keys. The OpenCode card auto-detects whether the proxy is online.

## Adding a New Provider

1. Create `<id>.ts` (or `<id>.tsx`) in `src/providers/`, exporting an object implementing `ProviderDef` (`src/types.ts:46`): `buildRequest(key, regionId?)` + `async parseResponse(json, ctx?)`.
2. Append a line to the `PROVIDERS` array in `src/providers/registry.ts:11`. For multi-region support, declare `regions` in the adapter and use `regionId` to select the baseUrl in `buildRequest`.
3. If the API lacks CORS, add the target domain to the `proxy.mjs` whitelist and set `needsProxy: true` on the adapter.
4. For brand logos: prefer `lobehub` slug. For white-on-white logos, set `logoDarkInvert: true` in `types.ts:51`. Inline SVGs go in `src/components/logos/`.
5. UI copy (name / tagline / region labels) goes through `src/i18n/dict.*.ts` provider sections; do not hardcode Chinese/English strings in adapter files for frontend rendering.
6. Run `npx tsc --noEmit`, then test end-to-end with real keys written to `localStorage` before committing.

## Design Tokens

- All colors use `var(--color-*)` CSS variables, injected by Tailwind via `@theme`. Add new tokens in `src/index.css` first, then use utility classes.
- Theme switching is done via `:root.dark` (or `html.dark`) redefining the same CSS variables. Do not hardcode hex values in components with `dark:`.
- Provider brand gradients: keep the `accent: 'from-xxx to-xxx'` Tailwind class fragment; no need to parse into CSS variables.
- `cn()` (`src/lib/cn.ts:5`) merges classes and resolves conflicts. Use clsx syntax for conditional classes.

## Animation Conventions

- All animations use `motion/react`. Self-built components are in `src/components/beui/`.
- Drawer panel spring: `stiffness:220 / damping:26 / mass:0.9` (`src/components/beui/drawer.tsx:28`).
- Exit spring: `stiffness:260 / damping:30` (`src/components/beui/drawer.tsx:30`).
- Button press spring: `stiffness:600 / damping:28` (`src/lib/motion-presets.ts:9`).
- Easing curves: `EASE_OUT = [0.16, 1, 0.3, 1]` (panel transitions); `EASE_IN_OUT = [0.45, 0, 0.55, 1]` (Loader rhythm).
- Must support `useReducedMotion()`: degrades to opacity pulse when the user enables "reduce motion" in their system.

## Code Style

- TypeScript strict mode. Avoid `any`. External data (JSON / localStorage / fetch) must be validated or narrowed at runtime.
- React function components + hooks. No class components, no extra state libraries.
- Naming: components PascalCase, hooks camelCase (`useXxx`), utils camelCase, types PascalCase, constants UPPER_SNAKE.
- All comments must be in English (both JSDoc and `//`). Explain design intent, constraints, and non-obvious exceptions; do not paraphrase clear code.
- Chinese characters are allowed in user-facing copy (Provider name / tagline / region label / error messages), but only in i18n dicts or placeholder attributes. Never hardcode Chinese UI strings in component JSX.
- Indentation: 2 spaces. Two JSX quote styles co-exist (most use `'`, beui components use `"`); follow the surrounding file's style.
- Import order: not enforced, but suggested: third-party → `@/...` → relative → `import type`.

## Internationalization (i18n)

- All user-facing copy must go through `src/i18n/dict.*.ts` dictionaries, consumed via `useT()` (`src/i18n/useT.ts`).
- Both `zh-CN` and `en-US` must have identical key structures. The `Dict` type enforces this to prevent missing/extra keys.
- `zh-CN` is the source of truth. `en-US` must be kept in sync by the dictionary maintainer. Do not use `dict[locale][key] ?? 'Chinese fallback'` in components.
- Exception: `<input placeholder>` text may be hardcoded (placeholder is not a critical i18n path), but add a comment explaining why.

## Prohibited

- Do not hardcode API keys, tokens, cookies, or any credentials. The local proxy must not print or persist any keys.
- Do not delete any code that is still in use. First `Grep` to confirm no references, or leave a commented-out version.
- Do not copy third-party npm dependencies into `src/`. Use `package.json`.
- Do not skip type checking. Every merge must pass `npx tsc --noEmit`.
- Do not use the user's screenshots as design references for style imitation. UI adjustments should be based on the current code and `index.css` tokens to avoid style drift.
- Do not modify domains outside the `proxy.mjs` whitelist. When adding a new provider that needs CORS, update the whitelist and note it in the PR description.
- Do not overwrite this AGENTS.md with an empty file. It is a collaboration document, not a placeholder.

## Verification Workflow

- **UI changes**: Use `playwright-cli` to take screenshots (empty state / single card / settings drawer / Dark mode / mobile 375px); deliver screenshots alongside the visible UI changes.
- **API changes**: Use real keys written to `localStorage` (`coding-usage.settings.v2`) to run `fetchUsage` end-to-end, verifying ok / error / needs-proxy statuses.
- **Type / compile**: `npx tsc --noEmit` must pass with zero errors. Do not use `// @ts-ignore`.
- **Regression**: Changes touching `src/lib/storage.ts` or `src/lib/query.ts` must additionally verify the v1→v2 migration path and both proxy online/offline states.
- **Styling**: When modifying `@theme` tokens, confirm visual consistency across light / dark / system modes. Prefer using browser DevTools to inspect computed values over relying on class names alone.

## Collaboration with Other Sub-agents

- **subagent-A**: Owns `src/components/ThemeProvider.tsx` (theme implementation). Excluded from this file's scope.
- **subagent-B**: Owns `src/i18n/**` and `src/components/LocaleSwitcher.tsx`. Excluded from this file's scope.
- **This agent (Builder)**: Owns doc comments in `src/**/*.ts(x)` and this AGENTS.md file. Does not touch the above three.
- When parallel editing and `old_string not found` occurs, re-read the file to confirm its current state before retrying.

## Git & Commits

- Commit format: `<type>(<scope>): <subject>`; subject in English imperative, lowercase, no period, ≤ 50 characters.
- Each commit should focus on a single purpose. Split unrelated refactoring into separate commits.
- Do not push, force-push, rebase, tag, or release without explicit authorization.