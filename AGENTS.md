# AGENTS.md

> Project-level guidance for `coding-usage`. Inherits priority and conventions from the user-level AGENTS.md. This file only adds project-specific hard constraints and collaboration details. In case of conflict, higher-priority directives take precedence.

## Project Overview

A pure static React 19 + Vite 7 + TypeScript strict usage dashboard. Tech stack:

- **Styling**: Tailwind CSS v4 (`@theme` token driven)
- **Animation / Interaction**: `motion/react` + self-built `src/components/beui/*` (Switch / Loader / Drawer / Select / Popover)
- **Icons**: `lucide-react` (unified linear) + `lobehub icons` CDN (Provider brands) + inline SVG (SiliconFlow)
- **State**: React 19 hooks + `localStorage`, no third-party state library
- **Build**: Vite 7 + TypeScript 5 strict
- **Runtime**: Browser (`dist/` via `vite build`) or desktop (`electron-vite` + Electron). Under Electron, provider APIs are fetched from the main process via `net:fetch` IPC (no CORS restrictions, no third-party proxy); in the browser they are called directly with a corsproxy.io fallback.

Supported Providers: OpenCode Zen Go, Zhipu GLM (Z.ai), Kimi / Moonshot, DeepSeek, SiliconFlow, OpenRouter, MiniMax Token Plan. Each provider supports multiple accounts. API keys live in `localStorage`: under Electron they are safeStorage-encrypted into `coding-usage.settings.v3` (keys prefixed `enc:v3:` in the store, decrypted in memory after mount); without a bridge they stay plain text under v2. Automatic v1→v2 and v2→v3 migration.

## Directory Structure

```
electron/
  main.ts                # Electron main: windows, tray, IPC (net:fetch / safe:* / app:set-login-item / tokscale:scan), auto-update
  preload.ts             # contextBridge exposing window.desktopBridge (typed in src/globals.d.ts)
src/
  App.tsx                # Shell host: view router (hash) + account editor session
  main.tsx               # ReactDOM entry
  types.ts               # Shared type definitions
  components/
    layout/              # AppShell / Sidebar (nav + status card) / TopBar (agent filter / auto-refresh / bell / settings)
    common/              # ProgressBar / StatusDot / Badge / SearchInput / PageHeader / StatCard / EmptyState / Tooltip
    charts/              # Self-built SVG: LineChart (trend) / DonutChart (distribution)
    overview/            # KpiRow / TrendCard / DistributionCard / AttentionList / AlertsPanel / PlanCardsRow / LocalUsageCard
    account/             # AccountDrawer (single-account editor: alias / key / region / enable / test)
    beui/                # Self-built components: drawer / loader / switch / select / popover / confirm-dialog
    ProviderLogo.tsx     # Brand logo via bundled @lobehub/icons (offline) + letter fallback
    GitHubIcon.tsx       # GitHub mark inline SVG (lucide-react dropped brand icons)
    ResetCountdown.tsx   # Relative reset countdown
    LocaleSwitcher.tsx   # Language switcher
  pages/                 # OverviewPage + 11 management/analysis pages (see router.ts VIEWS)
  providers/             # Provider adapters (implementing ProviderDef)
    registry.ts          # PROVIDERS list + getProvider
    opencode / zhipu / kimi / deepseek / siliconflow / openrouter / minimax
  lib/
    cn.ts                # clsx + tailwind-merge
    format.ts            # Countdown / amount / currency symbol / relative time
    metric-helpers.ts    # UNLIMITED_KEY shared constant
    ease.ts                # Single motion authority: EASE_* / SPRING_*
    query.ts             # fetchUsage + transportFetch (main-process bridge under Electron, plain fetch in browser)
    storage.ts           # loadSettings / persistSettings (v3 encrypt+verify) / v1→v2→v3 migration
    router.ts            # View union + hash sync (no router library)
    data-context.tsx     # App-wide state: settings / results / alerts / agent usage / refresh scheduler
    overview.ts          # Overview view-model builders (pure, testable)
    snapshots.ts         # Local time-series store (trends / today consumption)
    alerts.ts            # Alert derivation engine (window reset / high usage / low balance)
    rates.ts             # Static FX rates for cross-currency totals
    agent-usage.ts       # Local AI agent scanner: validates + aggregates tokscale output
  i18n/                  # Locale dictionaries (zh-CN, en-US) + LocaleProvider + useT
```

## Local agent usage (tokscale)

The overview "Local agent usage" card and the agents page read real consumption
from local session logs (Codex / Kimi Code / OpenCode) via the
[`tokscale`](https://github.com/junhoyeo/tokscale) CLI (`tokscale@^4.14.0`,
platform binary ships as optional dependency). The scan happens in the Electron
main process (`tokscale:scan` IPC — the `graph` subcommand over all configured
clients with `--since 2020-01-01 --no-spinner`, plus a best-effort `trae sync` —
with a 5-min in-process cache and one shared in-flight round-trip); aggregation
lives in `src/lib/agent-usage.ts`. Renderer scans ride the shared refresh cycle
(mount / manual buttons / auto-refresh tick, silent attempts throttled just past
the cache window) instead of a hidden timer. DSH's versioned `session.v3.*`
transcripts — invisible to tokscale's filename-based scanner — are hard-linked
to the canonical discovery names before every scan (`electron/dsh-aliases.ts`).
WorkBuddy AI's transcripts live under `~/.workbuddy-ai` — a home tokscale never
scans — and are hard-linked into the scanned `~/.workbuddy` before every scan
(`electron/workbuddy-aliases.ts`). Everything stays local — only aggregated
numbers are rendered, never message content. Packaging requires the
`asarUnpack` entries in `electron-builder.yml` (spawning from inside the asar
is impossible).

## Development Commands

```bash
npm install
npm run dev        # electron-vite dev (Electron app with HMR)
npm run dev:web    # vite dev server, http://localhost:5173 (browser path)
npm run build      # electron-vite build → dist-electron/ (main+preload CJS) + dist/ (renderer)
npm run build:web  # vite build → dist/ only (browser path, no regression)
npm run preview    # Preview web dist/
npm run dist:win   # electron-vite build && electron-builder --win (NSIS + portable)
```

Packaging config lives in `electron-builder.yml` (appId, win targets, GitHub publish for electron-updater). The renderer is served by the electron-vite dev server in Electron dev mode (`ELECTRON_RENDERER_URL`) and loaded from `dist/index.html` when packaged.

## Adding a New Provider

1. Create `<id>.ts` (or `<id>.tsx`) in `src/providers/`, exporting an object implementing `ProviderDef` (`src/types.ts:46`): `buildRequest(key, regionId?)` + `async parseResponse(json, ctx?)`.
2. Append a line to the `PROVIDERS` array in `src/providers/registry.ts:11`. For multi-region support, declare `regions` in the adapter and use `regionId` to select the baseUrl in `buildRequest`.
3. CORS is a non-issue under Electron (main-process fetch); in the browser `src/lib/query.ts` falls back to corsproxy.io automatically. Do not add any other third-party proxy.
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
- Single motion authority is `src/lib/ease.ts` (EASE_* / SPRING_*); components import from `@/lib/ease`, never define local duplicates.
- Drawer panel spring: `stiffness:220 / damping:26 / mass:0.9` (`src/components/beui/drawer.tsx:28`).
- Exit spring: `stiffness:260 / damping:30` (`src/components/beui/drawer.tsx:30`).
- Button press spring: `SPRING_PRESS` in `src/lib/ease.ts` (`stiffness:500 / damping:30 / mass:0.6`).
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

- Do not hardcode API keys, tokens, cookies, or any credentials. The main process must not log or persist keys beyond their safeStorage-encrypted form.
- Do not delete any code that is still in use. First `Grep` to confirm no references, or leave a commented-out version.
- Do not copy third-party npm dependencies into `src/`. Use `package.json`.
- Do not skip type checking. Every merge must pass `npx tsc --noEmit`.
- Do not use the user's screenshots as design references for style imitation. UI adjustments should be based on the current code and `index.css` tokens to avoid style drift.
- Do not route renderer traffic through third-party proxies other than the existing corsproxy.io browser fallback; under Electron all provider requests must go through the `net:fetch` IPC bridge.
- Do not overwrite this AGENTS.md with an empty file. It is a collaboration document, not a placeholder.

## Verification Workflow

- **UI changes**: Use `playwright-cli` to take screenshots (empty state / single card / settings drawer / Dark mode / mobile 375px); deliver screenshots alongside the visible UI changes.
- **API changes**: Use real keys written to `localStorage` (`coding-usage.settings.v3` under Electron, v2 in the browser) to run `fetchUsage` end-to-end, verifying ok / error statuses through both transports (bridge fetch and plain fetch).
- **Type / compile**: `npx tsc --noEmit` must pass with zero errors. Do not use `// @ts-ignore`.
- **Regression**: Changes touching `src/lib/storage.ts` or `src/lib/query.ts` must additionally verify the v1→v2→v3 migration paths: encrypted v3 load + hydration, plaintext fallback when safeStorage is unavailable, and verify-then-delete of the legacy v2 key.
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