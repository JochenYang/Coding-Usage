# AGENTS.md

> Project-level guidance for `coding-usage`. Inherits priority and conventions from the user-level AGENTS.md. This file only adds project-specific hard constraints and collaboration details. In case of conflict, higher-priority directives take precedence.

## Project at a glance

- **Goal**: monitor AI provider usage, balances and plan quotas locally. No uploads, no proxying, no key custody.
- **Stack**: React 19 + Vite 7 + TypeScript 5 strict; Tailwind CSS v4 (`@theme` tokens);
  `motion/react` + self-built `src/components/beui/*`; Electron (electron-vite); vitest.
- **Entry points**: `src/main.tsx` (renderer) → `src/App.tsx` (hash router); `electron/main.ts`
  (windows / tray / IPC); `electron/preload.ts` (`window.desktopBridge`).
- **Do not modify**: historical entries in `CHANGELOG.md` (append only); `.devflow/` (work records,
  git-ignored); `dist/` and `dist-electron/` (build output).

## Reading order

1. Project overview: [README.md](./README.md) (English: [README.en-US.md](./README.en-US.md))
2. Architecture facts: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — read before changing a module
3. Development and operations: [docs/development.md](./docs/development.md) — commands, tests, release, adding a provider
4. UI / component spec: [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) — read before touching UI
5. Documentation index: [docs/README.md](./docs/README.md)
6. Current plans: [docs/plans/](./docs/plans/) (no plan in progress right now)

## Hard rules

- **Credentials**: never hardcode or print keys, tokens or cookies. Plaintext lives only in the main
  process; never logged, never written to disk in plaintext. The renderer sees a mask by default and
  fetches one plaintext value over a dedicated IPC only on request.
- **Network**: renderer traffic must not go through a third-party proxy; the only exception is the
  browser-mode corsproxy.io fallback. Under Electron every provider request goes through the
  `net:fetch` IPC bridge.
- **Dependencies**: do not copy third-party npm packages into `src/`; use `package.json`.
- **Deletion**: `Grep` for references first; never delete code that is still in use.
- **Types**: `npx tsc --noEmit` must be clean before merge; never use `// @ts-ignore`.
- **Design**: do not use the user's screenshots as style references; adjust UI against the current
  code and the `src/index.css` tokens.
- **i18n**: all user-facing copy goes through `src/i18n/dict.*.ts`; `zh-CN` and `en-US` must keep
  identical key structures (details in [development.md](./docs/development.md#国际化)).
- **Docs**: one fact, one place; any change to behaviour, commands, interfaces or architecture
  boundaries must update the matching document — code-only changes do not count as done. Adding or
  moving a document means updating this reading order and [docs/README.md](./docs/README.md).
- **Never** overwrite this file with an empty one: it is the collaboration entry point, not a placeholder.

### Commits and releases

- Commit format: `<type>(<scope>): <subject>`; subject in English imperative, lowercase, no period, ideally ≤ 50 characters.
- One purpose per commit; split unrelated refactors into separate commits.
- **Without explicit authorization: do not commit, push, tag, release, or rewrite history.**
- Once a release IS authorized, own it end to end: bump the version + finalize the CHANGELOG →
  `chore(release): vX.Y.Z` → tag and push → wait for the workflow → verify the draft's bilingual
  notes and installers → publish as Latest. Details in [development.md](./docs/development.md#发布).

### Version numbering

- Exactly three parts, `vX.Y.Z`, and the patch steps by one — a feature, a fix and a refactor all take
  the same step. While the major version is 0 there is no "a feature bumps the minor" rule.
- The patch is a single digit (0–9): `v0.8.9` is followed by `v0.9.0`, never `v0.8.10`; the carry
  repeats one position up (`v0.9.9` → `v1.0.0`).
- History: `v0.5.10` predates the single-digit rule, and `v0.7.1` → `v0.8.0` came from misreading
  SemVer's minor clause. Neither is reversible; the sequence continues from `v0.8.0`.

## Command index

| Purpose | Command |
|---|---|
| Install | `npm install` |
| Desktop dev (HMR) | `npm run dev` |
| Renderer only | `npm run dev:web` |
| Full build | `npm run build` |
| Browser-only build | `npm run build:web` |
| Type check | `npx tsc --noEmit` |
| Unit tests | `npm test` |
| Windows packaging | `npm run dist:win` |

Command side effects, build-output relationships and the verification flow are in
[development.md](./docs/development.md#命令).

## Definition of done

- Code, tests and docs agree; `npx tsc --noEmit` and `npm test` pass.
- No link points at a document that does not exist; every document touched by the change is updated.
- Plans, reviews and work logs stay out of the current-fact documents; no empty checklist documents
  created just to match a template.
