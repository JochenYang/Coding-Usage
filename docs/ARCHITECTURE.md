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
| 渲染层 | `src/**` | 页面、视图模型、状态、i18n | 不直接持有明文密钥（仅按需经 IPC 取）；设置导出剥离凭据字段，备份 JSON 不含明文密钥 |
| 桥接层 | `electron/preload.ts` + `src/globals.d.ts` | 暴露 `window.desktopBridge` | 只暴露显式方法；类型在 `globals.d.ts` 维护 |
| 主进程 | `electron/**` | 网络请求、本地登录探针、文件读写、窗口/托盘/更新、无窗口时的后台刷新与告警推送 | 明文凭据只在此层使用，不写日志 |
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
  factory-quota.ts / devin-quota.ts / amp-quota.ts
                          # Factory Droid / Devin / Amp 套餐额度探针（本地凭据或官方 CLI →
                          # 官方接口；Amp 走官方 `amp usage` 子命令、不读凭据文件，
                          # Windows 经 cmd.exe 解析 npm 全局的 .cmd shim）
  codex-reset-credits.ts  # Codex 攒的重置券增强读（codex:quota 并发附带，失败静默
                          # 缺席，不影响主数字）
  opendesign-quota.ts     # OpenDesign Go 套餐额度（5h/7d 窗口）：主路线是官方 device-code
                          # 授权（卡片发起 → 浏览器批准 → 轮询存下 vela_ctrl_ 控制面密钥），
                          # 手动回退为卡片上粘贴 Cloud 控制台 Cookie；凭据经 safeStorage
                          # 加密落盘、只在主进程解密使用，解密结果不回传渲染层。推理
                          # API Key 读不了额度；端点为 amr-api.open-design.ai 的
                          # workspaces/current → billing/preflight（或 coding-plan-usage）
                          # → wallet/balance，字段按名称解析且自校验算术，漂移即 fail-closed
  local-plan-quota.ts     # Cursor / GitHub Copilot 本地登录探针（Cursor 的 sealed token
                          # 走 safe-storage.ts 解开；额度读 Cursor 当前的 GetCurrentPeriodUsage，
                          # 不提供 token 级用量，因此不计入本地用量）
  cline-quota.ts          # Cline Pass：只读 `cline auth` 的 providers.json，请求官方套餐窗口
  jetbrains-quota.ts      # JetBrains AI：只读 IDE 的额度 XML，较新的 idea.log 记录可替换它
  windsurf-quota.ts       # Windsurf：只读 state.vscdb 的 cachedPlanInfo，不读浏览器会话
  kiro-quota.ts           # Kiro：只读 kiro-cli 的 data.sqlite3，请求 GetUsageLimits，不启动聊天
  kilo-quota.ts           # Kilo：读 CLI auth.json 或 KILO_API_KEY，请求 app.kilo.ai 的额度
  aliyun-quota.ts         # 阿里云 Coding Plan / 千问 Cloud / Token Plan：走控制台网关；
                          # Cookie 来自应用内控制台会话（见 alibaba-connect.ts），
                          # 解不开的 v20 浏览器 Cookie 报 cookie-app-bound，不猜额度
  alibaba-connect.ts      # 阿里云控制台内嵌登录窗：用户登录一次，主进程用
                          # session.cookies.get 读自己的 jar（含 HttpOnly），不碰 Chrome 的 v20
  pasted-requests.ts      # 手动粘贴的控制台请求（Copy as cURL）：加密落盘、重放；
                          # 重建请求会被网关判未登录，只有控制台自己的请求可用
  safe-storage.ts         # 读另一个 Electron 应用的 safeStorage 密钥（Windows DPAPI → Chromium
                          # `v10` AES-256-GCM）；qoder / cursor 两个探针共用
  browser-cookies.ts      # 只读 Chrome / Edge Cookie：必须带域名白名单，只解 `v10`；
                          # `v20` 应用绑定加密不解、不猜。值不出主进程，没有对应的 IPC
  trae-usage.ts / trae-local-usage.ts
                          # Trae CN：登录解密探针 / SQLCipher 本地用量
  codebuddy-usage.ts / qoder-usage.ts / cindy-usage.ts / dsh-usage.ts / workbuddy-aliases.ts
                          # tokscale 覆盖不到或读不可靠的本地用量来源（qoder / cindy 各自分国内、国际两行；
                          # dsh 自己读多帧 zstd 转录 + DSH 应用自己的用量插件存储：tokscale 的 dsh 读者
                          # 遇到一个坏事件会丢弃整份会话，而转录只覆盖仍在磁盘的会话）
  minimax-code-usage.ts / antigravity-usage.ts
                          # tokscale 读不到的 agent 自有会话库：mcode 客户端只支持 headless 捕获，
                          # IDE 版 antigravity 的 conversations/*.db 在 tokscale 的 CLI 路径之外；
                          # 两者读库后产出与 `tokscale graph` 同形的 payload 供合并
  model-id-sanitize.ts    # 扫描前把第三方 agent 转录里的非 ASCII model/provider id 原地 percent-encode
                          #（tokscale 4.14.0 的字节切片 bug 会让一个非 ASCII 别名令整个 client 消失）；
                          # 状态记在 userData/model-id-sanitize.json，活跃文件（90s 内有写入）跳过
  tokscale-merge.ts / provider-reconcile.ts
                          # 纯函数：整体扫描因单 client 崩溃（exit 101）失败时逐 client 重试并合并健康结果；
                          # provider-reconcile 按模型别名的路由前缀修正 tokscale 硬编码的 provider 归属
  qoder-quota.ts          # Qoder 国际版额度：解 IDE 本地登录（DPAPI 密钥 + safe-storage.ts）→ 官方 credits 接口
  quota-store.ts          # 套餐额度上次成功结果（`quota-cache.json`）：卡片首屏直接显示并标注时间，
                          # 只存归一化额度字段与计划名，不存凭据与账号标识（登录邮箱等）；
                          # 失败不覆盖上次成功
  usage-store.ts          # 本地用量日归档（SQLite，userData/usage-history.db）：每轮扫描按日合并入库，
                          # 会话文件被删除/轮转后历史仍在（tokscale 只反映当前磁盘上的文件）
  model-pricing.ts / model-pricing-core.ts / builtin-pricing.ts
                          # 模型价格投影（models.dev 官方价优先，OpenRouter 兜底）
  agent-config-paths.ts / agent-config-io.ts / agent-config-service.ts
                          # Agent 配置：路径探测 / 备份+CAS 写 / 编排
  agent-model-list.ts / agent-model-test.ts / kimi-config.ts / mcode-config.ts / opencode-config.ts
                          # 各 Agent 的模型拉取、连通性测试与配置解析
  island-window.ts        # 桌面灵动岛覆盖窗口
  background.ts           # 无窗口时定时开一个隐藏窗口跑一轮刷新/告警/推送，跑完销毁
  weixin-ilink.ts / weixin-session.ts
                          # 微信 iLink 机器人协议客户端（无公开文档，2026-09 逆向）：登录二维码、
                          # 激活长轮询与发送；session 保活镜像 ZCode 的 getupdates 常驻约定，
                          # 修复发送报 {ret:-2, prepare failed}
  webhook-send.ts / webhook-channels.ts
                          # 告警 webhook 发送，webhook:send 通道用；channels 是各平台 payload 的
                          # 纯函数适配层（平台成功判定也在此），IPC 只暴露「按通道发送」而不是
                          # 开放 POST 代理
```

## 3. 数据流

1. **Provider 用量/余额**：`src/lib/query.ts#fetchUsage` → `ProviderDef.buildRequest/parseResponse`
   → 桌面经 `net:fetch` IPC、浏览器直连（失败回退 corsproxy）。结果写入 `results` 与启动缓存。
   GraphQL 型适配器（Warp）经桥的可选 POST 通道（`ParseContext.fetch` 第三参，主进程只接受
   显式 POST + 字符串 body，其余仍为 GET）。
2. **订阅额度（Codex / Claude / Gemini / Grok / Kimi / Antigravity / Trae / Trae 国际版 / Cursor / Copilot / Qoder 国际版 / Cline Pass / JetBrains AI / Windsurf / Kiro / Kilo / Factory Droid / Devin / Amp / OpenDesign / 阿里云 Coding Plan / 千问 Cloud / 阿里云 Token Plan）**：
   主进程读本地登录或本地额度文件（Amp 走官方 `amp usage` CLI；OpenDesign 走卡片发起的
   官方 device-code 授权拿控制面密钥，Cookie 粘贴为手动回退）→ 需要时调官方接口 →
   **只把归一化的额度字段与计划名**回传渲染层；凭据不出主进程。
   JetBrains 与 Windsurf 不联网：前者读 IDE 配置，后者读 IDE 本地缓存（打开 Windsurf 后才会更新）。
   CodeBuddy / Cindy / DSH / WorkBuddy 目前只有本地用量行、没有额度卡：截至 2026-11 尚未盘点过
   这四家的厂商额度面（区别于 JetBrains / Windsurf 的「有意纯本地」取舍），下轮接入调研从这四家起步。
3. **本地 Agent 用量**：主进程 `tokscale:scan` 扫描本地会话日志，另按 `electron/main.ts` 的
   `reads` 数组直读 8 路本地存储后合并：DSH（原生转录，mergeAlways——`dsh` 不在
   TOKSCALE_CLIENTS 里）、CodeBuddy CN IDE、Cindy、Trae CN（mergeAlways，与 tokscale 的来源
   不相交）、MiniMax Code、Antigravity、Qoder CN、Qoder global（这四路在 tokscale 已覆盖该
   client 时跳过），聚合在 `src/lib/agent-usage.ts`。
4. **模型价格**：`electron/model-pricing.ts` 按 models.dev 官方厂商价为主、OpenRouter 兜底，
   内置快照 `builtin-pricing.ts`（生成脚本 `scripts/gen-builtin-pricing.ts`）标注生成日期。
5. **持久化**：`settings`（v1→v2→v3 迁移，v3 为 safeStorage 加密）、`snapshots`（本地时序）、
   `results`（启动缓存，读取时做字段归一化）、`quota-cache.json`（上次成功的套餐额度，按 provider
   存、不含凭据或凭据指纹、30 天过期；卡片先显它再静默刷新）、`pasted-requests.json`
   （手动粘贴的控制台请求，safeStorage 加密；无 keystore 时拒绝保存而不是写明文）、
   `opendesign-cookie.json`（OpenDesign 卡的凭据槽：device 授权拿到的 vela_ctrl 控制面密钥
   或粘贴的 Cloud Cookie，safeStorage 加密、读取时重新校验；无 keystore 时拒绝保存）、
   `usage-history.db`（本地用量的日归档 SQLite：每轮扫描按日合并入库，删除/轮转的会话文件
   不再抹掉历史；`electron/usage-store.ts`，主进程启动时初始化）。
6. **订阅卡可见性**：`settings.enabledSubscriptions` 决定渲染哪些卡；未列出的不渲染。
   老配置缺该字段时回填「非实验性全部」，新安装从空开始由用户添加。
7. **窗口与后台**：关闭到托盘会**销毁**窗口及其渲染进程（空闲时常驻内存因此少约 110 MB），
   而不是隐藏；托盘、`second-instance`、灵动岛点击都会重建窗口并恢复上次的位置
   （如果保存的矩形已不在任何显示器上，则丢弃并居中）。无窗口期间，主进程按
   `autoRefreshMin` 定时开一个**隐藏窗口**（`#/background`）跑一轮完整的刷新、告警推导、
   推送与快照，页面回报 `background:done` 后立即销毁，超时 90 秒兜底。这样所有状态
   （已读、推送冷却、推送日志、趋势快照、日归档）仍在渲染层那一份 localStorage 里，
   主进程不重复实现数据层，也不会出现「同一告警窗口重开后重推」或「趋势断档」。

## 4. 安全边界

- 明文凭据只存在于**主进程内存**；渲染层默认只见掩码，点「小眼睛」才经独立 IPC 取该条明文。
  设置导出同样剥离 apiKey/token 等凭据字段，备份 JSON 不含明文密钥。
- 桌面端 `localStorage` 中的密钥为 `enc:v3:` 密文（safeStorage），无桥接时退回 v2 明文。
- 探针只读本地登录文件，不修改、不上传；写入类操作（Agent 配置）先备份再 CAS 写入。
- 浏览器 Cookie 读取只在主进程、只针对调用方给出的域名。空名单直接拒绝。解不开的 `v20` 值不回传。
- 阿里云控制台会在应用内窗口登录：窗口没有 preload、无 Node 权限、开启 sandbox，不读页面内容、
  不注入脚本、不代填凭据；只从应用自己的 cookie jar 读会话，且只发给对应控制台域名。
  窗口会拒绝服务端重定向到非控制台域名（`will-navigate` 不管 3xx），并拒绝一切权限请求。
  这个 jar 由 Chromium 自己写入，Windows 下经 OSCrypt（DPAPI）加密，不是明文。
- 禁止把渲染层流量引到第三方代理（唯一例外是浏览器模式的 corsproxy.io 兜底）。主进程有两处
  GitHub 资源镜像例外：模型价格目录（raw.githubusercontent.com 直连失败时经 gh-proxy.com 预置
  缓存）与自动更新 feed（GitHub 直连失败后改走 gh-proxy.com）——均只限 GitHub 资源，
  provider 数据请求不经过任何代理。
- Warp 是唯一的「可计费 key」适配器：key 与其他粘贴 key 一样以 `enc:v3` 落盘、在渲染层内存中
  解密使用（渲染层可信前提不变），但同一凭据可发起计费 agent run——设置页粘贴处与供应商卡片
  均明示「用专用短效 key，勿用主 key」。若未来要根除该暴露面，需把 key 移入主进程
  （专用 IPC 一次性传入）。

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
