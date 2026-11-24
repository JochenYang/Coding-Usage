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
    overview/             # KPI、趋势、本地用量、分布、近期活动、账号使用情况与各订阅额度卡
    account/              # AccountDrawer（单账号编辑）
    agent-config/         # Agent 配置台（AgentConfigSection / ProviderCard / ProviderDrawer / ModelEditor）
    beui/                 # 自建交互组件（drawer / switch / select / popover / confirm-dialog）
    ProviderLogo.tsx      # 品牌图标（@lobehub/icons 离线打包 + 字母兜底）
    ThemeProvider.tsx     # 明暗主题
    LocaleSwitcher.tsx    # 语言切换
  providers/              # Provider 适配器（registry.ts 汇总 19 家；双站账号独立的每站一个）
  lib/                    # 视图模型、存储、查询、告警、趋势、价格、快照等纯逻辑
  i18n/                   # zh-CN / en-US 词典 + LocaleProvider + useT
```

### 2.2 主进程结构

```text
electron/
  main.ts                 # 窗口、托盘、IPC 注册、自动更新
  preload.ts              # contextBridge → window.desktopBridge
  kimi-usage.ts / grok-usage.ts / subscription-quotas.ts
                          # 订阅额度探针（本地登录 → 官方接口）
  antigravity-quota.ts    # Antigravity IDE / App / CLI 三张额度卡共用的探针：同一个账号的额度是一个池，三端
                          # 都走 Cloud Code 接口，区别只在登录从哪读——IDE 读自己的 state.vscdb（旧版本另有
                          # 回环服务兜底），App 与 CLI 读系统 keyring 里两者共用的一条（经平台自带工具读取：
                          # Windows 的 CredReadW、macOS 的 security、Linux 的 secret-tool，不引入原生依赖）；
                          # 刷新用的 OAuth client 运行时从已安装的程序文件里读取，不写入仓库；额度响应在
                          # 回传与落盘前收窄到卡片解析的字段；同时判定客户端
                          # 是否仍在安装（Windows 另查卸载注册表，以覆盖自定义安装目录），只有查得实才报「未安装」
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
  settings-mirror.ts      # 设置镜像 settings-backup.json 的唯一读写口：排队执行、整体替换、
                          # 被其他进程占用时重试；启动恢复与后台刷新间隔都经它读
  weixin-ilink.ts / weixin-session.ts
                          # 微信 iLink 机器人协议客户端（无公开文档，2026-09 逆向）：登录二维码、
                          # 激活长轮询与发送；session 保活镜像 ZCode 的 getupdates 常驻约定，
                          # 修复发送报 {ret:-2, prepare failed}
  webhook-send.ts / webhook-channels.ts
                          # 告警 webhook 发送，webhook:send 通道用；channels 是各平台 payload 的
                          # 纯函数适配层（平台成功判定也在此），IPC 只暴露「按通道发送」而不是
                          # 开放 POST 代理。通道：wecom / feishu（可选签名校验）/ dingtalk（可选
                          # 加签）/ discord / slack / bark / ntfy / telegram / weixin；
                          # 钉钉与飞书签名在主进程用 node:crypto 计算，secret 不落日志
```

## 3. 数据流

1. **Provider 用量/余额**：`src/lib/query.ts#fetchUsage` → `ProviderDef.buildRequest/parseResponse`
   → 桌面经 `net:fetch` IPC、浏览器直连（失败回退 corsproxy）。结果写入 `results` 与启动缓存。
   GraphQL 型适配器（Warp）经桥的可选 POST 通道（`ParseContext.fetch` 第三参，主进程只接受
   显式 POST + 字符串 body，其余仍为 GET）。
2. **订阅额度（Codex / Claude / Gemini / Grok / Kimi / Antigravity IDE / Antigravity App /
   Antigravity CLI / Trae / Trae 国际版 / Cursor / Copilot / Qoder 国际版 / Cline Pass / JetBrains AI / Windsurf / Kiro / Kilo / Factory Droid / Devin / Amp / OpenDesign / 阿里云 Coding Plan / 千问 Cloud / 阿里云 Token Plan）**：
   主进程读本地登录或本地额度文件（Amp 走官方 `amp usage` CLI；OpenDesign 走卡片发起的
   官方 device-code 授权拿控制面密钥，Cookie 粘贴为手动回退）→ 需要时调官方接口 →
   **只把归一化的额度字段与计划名**回传渲染层；凭据不出主进程。
   JetBrains 与 Windsurf 不联网：前者读 IDE 配置，后者读 IDE 本地缓存（打开 Windsurf 后才会更新）。
   Antigravity 的三张卡是两份登录、一个池：额度按账号计，不按客户端分，同一账号下三张卡数字相同；
   IDE 读自己的登录，App 与 CLI 共用系统 keyring 里的一条，两张卡同时请求时共享一次读取与一次请求。
   三张卡都带一项安装状态
   （`installed`），只有主进程查得实（目前仅 Windows）才报 `false`，卡片据此标注「未安装」——额度照常
   读取卸载后残留的登录。
   CodeBuddy / Cindy / DSH / WorkBuddy 目前只有本地用量行、没有额度卡：截至 2026-11 尚未盘点过
   这四家的厂商额度面（区别于 JetBrains / Windsurf 的「有意纯本地」取舍），下轮接入调研从这四家起步。
3. **本地 Agent 用量**：主进程 `tokscale:scan` 扫描本地会话日志，另按 `electron/main.ts` 的
   `reads` 数组直读 8 路本地存储后合并：DSH（原生转录，mergeAlways——`dsh` 不在
   TOKSCALE_CLIENTS 里）、CodeBuddy CN IDE、Cindy、Trae CN（mergeAlways，与 tokscale 的来源
   不相交）、MiniMax Code、Antigravity、Qoder CN、Qoder global（这四路在 tokscale 已覆盖该
   client 时跳过），聚合在 `src/lib/agent-usage.ts`。
   **趋势页口径**（`src/lib/trend-analysis.ts`，全部是纯函数）：数据源按 扫描日序列 → localStorage 日归档 →
   服务商快照 依次取用、互不拼接；只有扫描序列带按模型拆分（归档与快照只有总量，所以命中率在那两种来源下
   显示不可用）。快照回退取快照存储的全部保留期（90 天，`buildTrendPoints` 透传每个点的日期），再由范围
   选择器截取；一段时间的消耗记在后一次读数那天（与上一次读数比较，而不是只与前一天比较，空档日的用量不丢）。日序列先补成连续日历网格并**延伸到今天**——最后一条记录之后的空档日也计 0，「最近 N 天」
   是截至今天的 N 个日历日；列宽只由跨度决定（30 天内按天，更长按 7 / 14 / 30… 天，最多 30 列），含今天的
   末列标「部分周期」。用量口径（含缓存读取 / 仅输入+输出）贯穿 KPI、堆叠柱、模型筛选与模型对比：按模型行
   保存 `input` 与 `cacheRead` 两条日序列（写入不单独存，`cacheWrite = total − input − output − cacheRead`），
   筛选因此保留拆分和命中率；旧缓存缺这两条数组时由加载器按余量回填。缓存写入画进缓存读取段、在悬浮提示
   里单列，底栏四项之和等于总量。加权输出速度 = 输出 ÷ 会话活跃时长。活跃时长是会话跨度的合计，并行会话
   会叠加：24 小时以内按原值计入；超过 24 小时的只在调用足够密集时计入（平均每次调用不超过 5 分钟会话
   时长），否则视为上游把跨天会话的跨度记到当天，不参与计算。会话时长只到天级、没有按模型的拆分，所以
   **筛选后**每个模型按当天调用占比分摊时长：KPI 速度、聚合图速度线与模型对比的估算行因此是同一个数，
   KPI 卡上注明「按当日调用次数占比估算」。速度线在没有可用时长的列断开而不画 0，孤立的速度点画成圆点。
   模型对比列出所选范围内有 token 或有调用的模型（按 credits 计费、没有 token 的模型也能在这里点选）。
   颜色槽位按未筛选的输出前 8 名分配、不随筛选重排；筛选集合内部撞色时，累计排名靠后的模型换到集合内没人用的槽位
   （取二取舍见 `docs/DESIGN_SYSTEM.md` §12）。所选范围内没有用量时图表区说明这一点（不再是「正在累积
   数据」）。credits 是独立单位，不并入 token、不按模型拆分。
4. **模型价格**：`electron/model-pricing.ts` 按 models.dev 官方厂商价为主、OpenRouter 兜底，
   内置快照 `builtin-pricing.ts`（生成脚本 `scripts/gen-builtin-pricing.ts`）标注生成日期。
5. **持久化**：`settings`（v1→v2→v3 迁移，v3 为 safeStorage 加密；智谱 / Kimi / SiliconFlow / MiniMax
   各拆成国内、国际两个 provider 后，带 `regionId` 的旧账号在读取与备份导入时经 `normalizeProviders`
   自动归位——启动加载与导入共用这一入口，国际站账号的 key 不会因此被发往国内站）、
   `snapshots`（本地时序）、`results`（启动缓存，读取时做字段归一化）。后两者与告警都按账号键
   `providerId-序号` 归档：账号迁移改变序号时，受影响 provider 的读数缓存被丢弃，快照与告警则按
   「旧键→新键」改到新账号下（历史不丢也不归错账号），该整理每台机器只执行一次。订阅卡的键名
   整理同理但标记不同：Antigravity 卡拆成 IDE / App / CLI 后，旧文档里的 `antigravity` 指 IDE 卡、
   新文档里指 App 卡，两个键都合法，所以是否改名由文档自带的 `subscriptionKeysVersion` 决定
   （缺失即旧文档，加载与备份导入共用这一判定）；标记随文档一起保存，改名与回写同成同败。
   其余：
   `quota-cache.json`（上次成功的套餐额度，按 provider
   存、不含凭据或凭据指纹、30 天过期；卡片先显它再静默刷新。格式版本 2 起 IDE 的槽位是
   `antigravity-ide`，加载旧版本文件时把原 `antigravity` 槽位的读数挪过去并立即回写）、`pasted-requests.json`
   （手动粘贴的控制台请求，safeStorage 加密；无 keystore 时拒绝保存而不是写明文）、
   `opendesign-cookie.json`（OpenDesign 卡的凭据槽：device 授权拿到的 vela_ctrl 控制面密钥
   或粘贴的 Cloud Cookie，safeStorage 加密、读取时重新校验；无 keystore 时拒绝保存）、
   `usage-history.db`（本地用量的日归档 SQLite：每轮扫描按日合并入库，删除/轮转的会话文件
   不再抹掉历史；`electron/usage-store.ts`，主进程启动时初始化）。
   **设置镜像与启动恢复**：前台窗口每次保存设置（启动挂载时与每次改动后；隐藏的后台窗口从不保存）
   都把加密 v3 文档另存一份到 userData 的 `settings-backup.json`（加密不可用、回退到明文 v2 时没有 v3
   可另存，不写镜像），读写都只经 `electron/settings-mirror.ts`：新内容先写进暂存文件并落盘，再一步
   改名替换旧文件；读写排队依次执行，文件被别的进程占用时有限重试（写入约 200 毫秒后放弃、下次启动
   重写；读取等到约 900 毫秒，因为放弃意味着本次启动没有账号）。启动时若 localStorage 里一份能解析的
   设置文档都没有（键不存在，或键在但内容不是 JSON 对象），渲染层先把镜像读回来，**读回之前不保存、
   不解密、不做首次
   刷新**——否则内存里的空设置会抢在恢复之前写出去，覆盖掉这唯一一份账号备份。镜像内容先校验是
   设置文档才放回 localStorage，随后与常规启动走同一条路径：账号归位、解密、首次刷新。加载路径
   （`loadSettingsDetailed` 按 v3 → v2 → v1 逐个尝试）与「是否需要恢复」的判定用同一条规则：不是设置
   文档的键视同不存在、跳到下一个键——两处不一致时，加载出的空设置会在判定认为「无需恢复」的前提下
   被保存并覆盖镜像。本地存储
   完好的常规启动不读镜像。恢复没成功时（镜像读不出、内容损坏或为空、或写不回 localStorage）应用
   照常启动，原因写进控制台，界面上没有提示，并且**在用户做出改动之前不保存设置**——既不写本地
   存储也不写镜像，那份备份可能仍然完好，之后每次启动都会再读一遍。用户一旦改动设置，改动照常
   保存（账号列表是空的），镜像随之更新，原备份不再保留。「没有镜像文件」（全新安装）与「有镜像但
   读不出」在读取接口上是两种结果（`null` 与出错），后者绝不能被当成「无可恢复」。排队只管住应用
   自己的读写：应用外的进程恰好在改名那一刻读这个文件，仍可能让一次镜像写入重试后失败——这次
   写入被放弃并记录，旧的一份保持原样，下次启动保存设置时重写。
6. **订阅卡可见性**：`settings.enabledSubscriptions` 决定渲染哪些卡；未列出的不渲染。
   老配置缺该字段时回填「非实验性全部」，新安装从空开始由用户添加。已有该字段的安装升级后，
   原来启用的 `antigravity` 卡自动成为 `antigravity-ide`；新拆出的 App 与 CLI 两张不自动启用。
7. **窗口与后台**：关闭到托盘会**销毁**窗口及其渲染进程（空闲时常驻内存因此少约 110 MB），
   而不是隐藏；托盘、`second-instance`、灵动岛点击都会重建窗口并恢复上次的位置
   （如果保存的矩形已不在任何显示器上，则丢弃并居中）。托盘菜单的文案跟随界面语言、
   原生深浅色跟随应用主题：渲染层在 locale/theme 变化时经 `prefs:tray-sync` 推送
   （`electron/tray-prefs.ts` 校验与双语词条），主进程据此重建菜单并设置
   `nativeTheme.themeSource`；首次推送到达前用系统 locale 猜测、按深色兜底。无窗口期间，主进程按
   `autoRefreshMin` 定时开一个**隐藏窗口**（`#/background`）跑一轮完整的刷新、告警推导、
   推送与快照，页面回报 `background:done` 后立即销毁，超时 90 秒兜底。这样所有状态
   （已读、推送冷却、推送日志、趋势快照、日归档）仍在渲染层那一份 localStorage 里，
   主进程不重复实现数据层，也不会出现「同一告警窗口重开后重推」或「趋势断档」。

## 4. 安全边界

- 明文凭据只存在于**主进程内存**；渲染层默认只见掩码，点「小眼睛」才经独立 IPC 取该条明文。
  设置导出同样剥离 apiKey/token 等凭据字段，备份 JSON 不含明文密钥。
- 桌面端 `localStorage` 中的密钥为 `enc:v3:` 密文（safeStorage），无桥接时退回 v2 明文。
- 探针只读本地登录文件，不修改、不上传；写入类操作（Agent 配置）先备份再 CAS 写入。
- Antigravity App / CLI 的登录在系统 keyring 里（go-keyring 的 `gemini` / `antigravity`），探针经平台
  自带工具只读取出、只在主进程内存里使用，不写回、不落盘、不记日志；刷新后的 access token 同样只在
  内存里。额度响应在回传与落盘之前收窄到卡片解析的字段，服务端包在外层的内容（信封、账号标识等）
  不出主进程。该 keyring 条目只有 Windows 一侧对照过真实安装：macOS 上 go-keyring 写入的值带
  `go-keyring-base64:`（旧版 `go-keyring-encoded:`）前缀，读取时解包，但首次读取可能触发系统钥匙串的
  授权提示；Linux 上 `secret-tool` 的退出码 1 分不清「没有条目」和「钥匙串被锁」，后者会被当成
  「未登录」来提示。这两处都未实测。
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
