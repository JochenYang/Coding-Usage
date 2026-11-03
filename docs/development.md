# 开发与操作（development）

> 本文件是**开发操作事实的唯一来源**：环境、命令、测试与验证、发布、新增 Provider、代码约定。
> 架构事实见 [ARCHITECTURE.md](./ARCHITECTURE.md)；视觉规范见 [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)。
>
> 状态：current · 更新触发：命令、验证流程、发布方式或工程约定变化时。

## 环境

- Node.js 22+（`package.json` engines 与 CI 一致）。
- 无第三方状态库；React 19 + Vite 7 + TypeScript 5 strict。

## 命令

```bash
npm install
npm run dev        # electron-vite dev（Electron 应用，HMR）
npm run dev:web    # vite dev server，http://localhost:5173（仅渲染层，桌面能力降级）
npm run build      # electron-vite build → dist-electron/（main+preload CJS）+ dist/（渲染层）
npm run build:web  # vite build → dist/（纯浏览器产物）
npm run preview    # 预览 web dist/
npm run dist:win   # electron-vite build && electron-builder --win（NSIS + portable）
npx tsc --noEmit   # 类型检查（合并前必须零错误）
npm test           # vitest 单元测试
```

> `npm run build` 与 `npm run build:web` **共用 `dist/`**。先 `build:web` 再 `build` 才能得到
> 可在 Electron `file://` 下加载的产物；验证桌面端前请重跑 `npm run build`。

## 测试与验证

- **类型 / 编译**：`npx tsc --noEmit` 零错误；不得使用 `// @ts-ignore`。
- **单元测试**：`npm test`（vitest）。视图模型、解析器、存储与告警逻辑都应有纯函数测试。
- **UI 改动**：用 `playwright-cli` 截图（空态 / 单卡 / 抽屉 / 暗色 / 375px），随改动一并交付。
- **API 改动**：用真实 Key 写入 `localStorage`（桌面 `coding-usage.settings.v3`、浏览器 v2）
  端到端跑 `fetchUsage`，覆盖两种传输（bridge fetch 与直连）的 ok / error。
- **回归**：改动 `src/lib/storage.ts` 或 `src/lib/query.ts` 时，额外验证 v1→v2→v3 迁移：
  加密 v3 读取与回填、safeStorage 不可用时的明文回退、旧 v2 的校验后删除。
- **样式**：改 `@theme` token 时确认浅色 / 深色 / 跟随系统三态一致；用 DevTools 看计算值，
  不要只看类名。

## 发布

1. 更新 `CHANGELOG.md` 的 `[Unreleased]`（双语条目一一对应），改为 `[vX.Y.Z]`。
2. `npm version X.Y.Z --no-git-tag-version`（只改 `package.json` 与 `package-lock.json`）。
3. 提交 `chore(release): vX.Y.Z` → 打附注 tag `git tag -a vX.Y.Z -m vX.Y.Z` → 推送分支与 tag。
4. 等待 release workflow：构建三平台 → 从 `CHANGELOG.md` 生成双语 release notes 写入 draft。
5. 核对 draft 的双语 notes 与安装包，然后 `gh release edit vX.Y.Z --draft=false` 发布为 Latest。
   不得把发布留在 draft 等人工处理。

本地预览 notes：`node scripts/gen-release-notes.mjs vX.Y.Z`。

版本号规则见 [AGENTS.md](../AGENTS.md#version-numbering)（三段式、patch 单数字进位）。

## 新增 Provider

1. 在 `src/providers/` 新建 `<id>.ts`（或 `.tsx`），实现 `ProviderDef`（`src/types.ts`）：
   `buildRequest(key, regionId?)` + `async parseResponse(json, ctx?)`。
2. 在 `src/providers/registry.ts` 的 `PROVIDERS` 数组注册。多区域时在适配器声明 `regions`，
   用 `regionId` 选择 baseUrl。
3. CORS 在 Electron 下不是问题（主进程 fetch）；浏览器由 `src/lib/query.ts` 自动回退
   corsproxy.io。不要接入其它第三方代理。
4. 品牌图标优先用 `lobehub` slug；白底不可见时在 `types.ts` 设 `logoDarkInvert: true`；
   内联 SVG 放 `src/components/logos/`。
5. UI 文案（名称 / tagline / 区域标签）走 `src/i18n/dict.*.ts` 的 provider 段，不在适配器里
   硬编码中英文。
6. `npx tsc --noEmit` 通过后，用真实 Key 写入 `localStorage` 端到端验证再提交。

## 代码约定

- TypeScript strict，避免 `any`；外部数据（JSON / localStorage / fetch）必须运行时校验或收窄。
- React 函数组件 + hooks；无 class 组件，不引入状态库。
- 命名：组件 PascalCase、hooks `useXxx`、工具 camelCase、类型 PascalCase、常量 UPPER_SNAKE。
- 注释一律英文（JSDoc 与 `//`），解释设计意图、约束与非显然例外，不复述代码。
- 缩进 2 空格；两种 JSX 引号风格并存（多数用 `'`，beui 组件用 `"`），跟随所在文件。
- import 顺序不强制，建议：第三方 → `@/...` → 相对 → `import type`。

## 国际化

- 所有用户文案走 `src/i18n/dict.*.ts`，由 `useT()`（`src/i18n/useT.ts`）消费。
- `zh-CN` 与 `en-US` 键结构必须完全一致（`Dict` 类型强制），`zh-CN` 为唯一事实源。
- 不要在组件里用 `dict[locale][key] ?? '中文兜底'`。
- 例外：`<input placeholder>` 可硬编码，但需注释说明原因。

## 协作边界

- `src/components/ThemeProvider.tsx`：主题实现，改动前确认影响面。
- `src/i18n/**` 与 `src/components/LocaleSwitcher.tsx`：词典与语言切换。
- 并行编辑出现 `old_string not found` 时，先重读文件确认当前内容再重试。
