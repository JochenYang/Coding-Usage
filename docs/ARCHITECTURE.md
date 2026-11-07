# 架构事实（ARCHITECTURE）

> 本文件是**当前架构事实的唯一来源**：分层、模块边界、数据流、安全与打包约束。
> 命令、测试、发布与排障见 [development.md](./development.md)；视觉与组件规范见
> [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)；文档索引见 [README.md](./README.md)。
>
> 状态：current · 更新触发：模块边界、数据流、安全模型或打包方式变化时。

## 1. 项目形态与边界

- **是什么**：多供应商 AI 用量与套餐额度的本地监控面板（个人开发者桌面场景）。
- **不是**：不上传任何数据、不代理请求、不做多用户/团队协作、不托管密钥。
- **两种运行形态**：
  - 浏览器：`vite build` 产出静态 `dist/`，provider 请求直连，跨域时回退 `corsproxy.io`。
  - 桌面：Electron（`electron-vite`）。provider 请求由主进程 `net:fetch` 发出，无 CORS 限制，
    也不允许经第三方代理。

## 2. 分层与模块边界

| 层 | 位置 | 职责 | 约束 |
|---|---|---|---|
| 渲染层 | `src/**` | 页面、视图模型、状态、i18n | 不直接持有明文密钥（仅按需经 IPC 取） |
| 桥接层 | `electron/preload.ts` + `src/globals.d.ts` | 暴露 `window.desktopBridge` | 只暴露显式方法；类型在 `globals.d.ts` 维护 |
| 主进程 | `electron/**` | 网络请求、本地登录探针、文件读写、窗口/托盘/更新 | 明文凭据只在此层使用，不写日志 |
| 静态资源 | `dist/`（渲染层）、`dist-electron/`（main + preload CJS） | 打包产物 | 两者构建命令不同，见 §6 |

### 2.1 渲染层结构

```text
src/
  App.tsx                 # 壳：hash 路由 + 账号编辑器会话
  main.tsx                # ReactDOM 入口
  types.ts                # 共享类型（ProviderDef / Settings / UsageMetric ...）
  pages/                  # 11 个页面：Overview / Providers / Accounts / Plans / Agents / UsageStats
                          #   / CostAnalysis / Trends / Alerts / Integrations / Settings
  components/
    layout/               # AppShell / Sidebar / TopBar
    common/               # ProgressBar / Badge / PageHeader / EmptyState / SortableGrid ...
    charts/               # 自绘 SVG 图表（Line / Donut / StackedBarLine / MultiSeries ...）
    overview/             # KPI、趋势、分布、告警与各订阅额度卡
    account/              # AccountDrawer（单账号编辑）
    agent-config/         # Agent 配置台（AgentConfigSection / ProviderCard / ProviderDrawer / ModelEditor）
    beui/                 # 自建交互组件（drawer / switch / select / popover / confirm-dialog）
    ProviderLogo.tsx      # 品牌图标（@lobehub/icons 离线打包 + 字母兜底）
    ThemeProvider.tsx     # 明暗主题
    LocaleSwitcher.tsx    # 语言切换
  providers/              # Provider 适配器（registry.ts 汇总 14 家）
  lib/                    # 视图模型、存储、查询、告警、趋势、价格、快照等纯逻辑
  i18n/                   # zh-CN / en-US 词典 + LocaleProvider + useT
```

### 2.2 主进程结构

```text
electron/
  main.ts                 # 窗口、托盘、IPC 注册、自动更新
  preload.ts              # contextBridge → window.desktopBridge
  kimi-usage.ts / grok-usage.ts / antigravity-quota.ts / subscription-quotas.ts
                          # 订阅额度探针（本地登录 → 官方接口）
  local-plan-quota.ts     # Cursor / GitHub Copilot 本地登录探针
  trae-usage.ts / trae-local-usage.ts
                          # Trae CN：登录解密探针 / SQLCipher 本地用量
  codebuddy-usage.ts / qoder-usage.ts / cindy-usage.ts / dsh-usage.ts / workbuddy-aliases.ts
                          # tokscale 覆盖不到或读不可靠的本地用量来源（qoder / cindy 各自分国内、国际两行；
                          # dsh 自己读多帧 zstd 转录 + DSH 应用自己的用量插件存储：tokscale 的 dsh 读者
                          # 遇到一个坏事件会丢弃整份会话，而转录只覆盖仍在磁盘的会话）
  qoder-quota.ts          # Qoder 国际版额度：解 IDE 本地登录（Windows DPAPI）→ 官方 credits 接口
  model-pricing.ts / model-pricing-core.ts / builtin-pricing.ts
                          # 模型价格投影（models.dev 官方价优先，OpenRouter 兜底）
  agent-config-paths.ts / agent-config-io.ts / agent-config-service.ts
                          # Agent 配置：路径探测 / 备份+CAS 写 / 编排
  agent-model-list.ts / agent-model-test.ts / kimi-config.ts / mcode-config.ts / opencode-config.ts
                          # 各 Agent 的模型拉取、连通性测试与配置解析
  island-window.ts        # 桌面灵动岛覆盖窗口
```

## 3. 数据流

1. **Provider 用量/余额**：`src/lib/query.ts#fetchUsage` → `ProviderDef.buildRequest/parseResponse`
   → 桌面经 `net:fetch` IPC、浏览器直连（失败回退 corsproxy）。结果写入 `results` 与启动缓存。
2. **订阅额度（Codex / Claude / Gemini / Grok / Kimi / Antigravity / Trae / Cursor / Copilot / Qoder 国际版）**：
   主进程读本地登录 → 调官方接口 → **只把数值**回传渲染层；凭据不出主进程。
3. **本地 Agent 用量**：主进程 `tokscale:scan` 扫描本地会话日志，四类 tokscale 覆盖不到的
   存储由主进程直读后合并（CodeBuddy / Cindy / Qoder / Trae CN），聚合在 `src/lib/agent-usage.ts`。
4. **模型价格**：`electron/model-pricing.ts` 按 models.dev 官方厂商价为主、OpenRouter 兜底，
   内置快照 `builtin-pricing.ts`（生成脚本 `scripts/gen-builtin-pricing.ts`）标注生成日期。
5. **持久化**：`settings`（v1→v2→v3 迁移，v3 为 safeStorage 加密）、`snapshots`（本地时序）、
   `results`（启动缓存，读取时做字段归一化）。

## 4. 安全边界

- 明文凭据只存在于**主进程内存**；渲染层默认只见掩码，点「小眼睛」才经独立 IPC 取该条明文。
- 桌面端 `localStorage` 中的密钥为 `enc:v3:` 密文（safeStorage），无桥接时退回 v2 明文。
- 探针只读本地登录文件，不修改、不上传；写入类操作（Agent 配置）先备份再 CAS 写入。
- 禁止把渲染层流量引到第三方代理（唯一例外是浏览器模式的 corsproxy.io 兜底）。

## 5. 已知架构约束（易踩点）

- `startup-cache.ts` 每加字段都必须在**读取处**补默认值，否则旧缓存会让首屏白屏。
- `AgentPeriodVM` 的四个 token 档位（input/output/cacheRead/cacheWrite）必须恒等于 `tokens`；
  新增档位要同时改 `makePeriod` / `addPeriod` / `subtract` / `zero()`。
- `build` 与 `build:web` 共用 `dist/`：先跑 `build:web` 再跑 `build` 才能得到可在 Electron
  `file://` 下加载的产物；验证桌面端之前重跑 `npm run build`。
- 打包需要 `electron-builder.yml` 的 `asarUnpack` 条目（从 asar 内无法 spawn 外部二进制）。

## 6. 打包与构建

- 渲染层：Vite 7 → `dist/`；主进程与 preload：`electron-vite` → `dist-electron/`（CJS）。
- Electron 开发态由 dev server 提供渲染层（`ELECTRON_RENDERER_URL`），打包态加载 `dist/index.html`。
- 打包配置在 `electron-builder.yml`（appId、Windows NSIS + portable、electron-updater 的
  GitHub publish）。
- 发布流程见 [development.md](./development.md#发布)。
