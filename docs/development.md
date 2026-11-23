# 开发与操作（development）

> 本文件是**开发操作事实的唯一来源**：环境、命令、测试与验证、发布、新增 Provider、代码约定。
> 架构事实见 [ARCHITECTURE.md](./ARCHITECTURE.md)；视觉规范见 [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)。
>
> 状态：current · 更新触发：命令、验证流程、发布方式或工程约定变化时。

## 环境

- Node.js 22+（release workflow 的 `setup-node` 固定 22；`package.json` 未声明 `engines`）。
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

> 两个 dev server 都**不监听** `.tmp/`、`.devflow/`、`.playwright-cli/`（`server.watch.ignored`，
> `vite.config.ts` 与 `electron.vite.config.ts` 各写一份、保持一致）。这些目录放本地临时文件，
> 可能正被别的进程锁着（比如验证用的无头浏览器配置目录）；Windows 上 Vite 监听到被锁的文件会以
> `EBUSY` 直接让 dev server 崩溃。`.tmp/` 下的预览页照常能访问，只是不参与热更新。

## 测试与验证

- **类型 / 编译**：`npx tsc --noEmit` 零错误；不得使用 `// @ts-ignore`。
- **单元测试**：`npm test`（vitest）。视图模型、解析器、存储与告警逻辑都应有纯函数测试。
- **UI 改动**：用 `playwright-cli` 截图（空态 / 单卡 / 抽屉 / 暗色 / 375px），随改动一并交付。
- **API 改动**：用真实 Key 写入 `localStorage`（桌面 `coding-usage.settings.v3`、浏览器 v2）
  端到端跑 `fetchUsage`，覆盖两种传输（bridge fetch 与直连）的 ok / error。
- **回归**：改动 `src/lib/storage.ts` 或 `src/lib/query.ts` 时，额外验证 v1→v2→v3 迁移：
  加密 v3 读取与回填、safeStorage 不可用时的明文回退、旧 v2 的校验后删除；以及双站 provider 拆分的
  账号迁移（`normalizeProviders`：带 `regionId` 的旧账号按国内 / 国际归位，读数缓存清理、快照与
  告警按旧键→新键重命名，每台机器只执行一次；启动加载与设置备份导入共用这一入口；用例在
  `src/lib/storage.test.ts` 与 `src/providers/split-sites.test.ts`）。
- **启动恢复**：改动 `src/lib/data-context.tsx` 的启动编排（保存 / 恢复 / 解密 / 首次刷新）或
  `electron/settings-mirror.ts` 时，验证「localStorage 被清空、只剩镜像文件」这条路径：镜像读回
  之前不得有任何保存或镜像写入，恢复出的账号要被解密并触发首次刷新；镜像缺失、损坏、为空或读取出错时
  按全新状态正常启动且不卡住，并且在用户改动设置之前既不写本地存储也不写镜像；本地存储完好的常规启动
  行为不变。可复现的做法（内置浏览器）：`npx vite --port 4198` 起开发服务器，清空 localStorage，
  挂一个 `LocaleProvider` + `DataProvider`，注入记录调用顺序的假桌面桥（`settingsBackupRead` 返回由
  测试**手动放行**的 promise；`on*` 方法要返回取消订阅函数），放行前后各取一次调用序列——不要用定时器
  模拟跨进程延迟，内置浏览器会节流定时器，结果不可信。要覆盖的情形：镜像完好、没有镜像文件、镜像内容
  损坏、镜像为空文件、镜像带 UTF-8 BOM、读取出错、镜像完好但写回 localStorage 失败（包一层
  `Storage.prototype.setItem` 让它对 v3 键抛错）、恢复失败后用户改了一项设置、恢复失败后的第二次启动
  （要重新读镜像且不覆盖）、localStorage 的 v3 键在但内容不是文档（要触发恢复）、v2 键在但内容不是文档
  且镜像损坏（不得触发 v2 迁移保存，否则下次启动会跳过恢复）、v3 完好的常规启动（不读镜像）、v2 完好的
  常规启动（照常迁移到 v3）。文件层的行为（整体替换、排队、占用重试、绕过队列的直读看不到空文件或残缺文件）由
  `electron/settings-mirror.test.ts` 覆盖。机制说明见 `ARCHITECTURE.md`「设置镜像与启动恢复」。
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
2. 在 `src/providers/registry.ts` 的 `PROVIDERS` 数组注册。一个服务商有国内 / 国际两站时，两站是
   独立账号、独立订阅的，拆成两个 provider、各自固定主机（智谱、Kimi、SiliconFlow、MiniMax 都是
   这样）——合并成一条只能靠添加账号时「选区域」区分，列表里看不出是哪一站，换站必须改区域而
   不能并存两个账号。`ProviderDef.regions` / `regionId` 仅为读取旧数据保留，目前没有适配器使用。
   拆开后 `buildRequest(key)` 必须无视 `regionId`：一个带旧区域的账号若留在错误的 provider 下，key
   就会发到另一站。以后再拆开一个带 `regions` 的旧 provider 时，在 `src/lib/storage.ts` 的
   `SPLIT_SITE_PROVIDERS` 登记「国内 id → 国际 id」——`normalizeProviders` 会据此迁移存量账号
   （启动加载与设置备份导入共用这一入口），并清理受影响的读数缓存、把快照与告警改到新账号键下。
3. CORS 在 Electron 下不是问题（主进程 fetch）；浏览器由 `src/lib/query.ts` 自动回退
   corsproxy.io。不要接入其它第三方代理。
4. 品牌图标优先用 `lobehub` slug；白底不可见时在 `types.ts` 设 `logoDarkInvert: true`；
   内联 SVG 放 `src/components/logos/`。
5. UI 文案（tagline / 套餐筛选名）走 `src/i18n/dict.*.ts` 的 provider 段，不在适配器里硬编码
   中英文；显示在下拉与卡片上的品牌名 `name` 不翻译，直接写在适配器里。词典的 `providers` 段
   按 provider id 一一对应，新 provider 两份词典都要加。
6. `npx tsc --noEmit` 通过后，用真实 Key 写入 `localStorage` 端到端验证再提交。

### 已评估不接入的供应商

外部调研（多份第三方用量目录与官方文档交叉核对）已排除以下候选，记录于此避免下轮重复侦察；
每行一个供应商、一条理由。接入条件消失（如官方补齐端点）时可重新评估。

- **Qwen CLI OAuth 免费层**：无云端额度端点，免费层额度只在 IDE 内展示；本地会话扫描已覆盖其用量。
- **Zed**：无任何额度 API，额度数据由 Orb 嵌在 dashboard 页面内，无法可靠解析。
- **iFlow 心流**：三份第三方用量目录均未收录，公开搜索未找到可核实的额度端点。
- **小米 MiMo（Token Plan）**：额度路由只认小米账号 Web SSO 的 HttpOnly cookie，API key 没有额度面。
- **ForgeCode / Roo Code Cloud / Sourcegraph Cody**：官网与公开渠道均无可核实的套餐额度端点。
- **Augment**：无套餐余量官方端点；官方 Analytics API 是组织级用量分析，不提供个人套餐余量。

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
