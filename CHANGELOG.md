# Changelog

Coding Usage 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更，
与 GitHub Release 的 release notes 保持一致。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.0]`），打 `v*` tag 推送后
release workflow 会自动构建 Windows 安装包并用本文件生成双语 release notes
（`node scripts/gen-release-notes.mjs v0.1.0` 可本地预览）。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，
新条目加在列表顶部。

## [v0.4.6] - 2026-09-09

### 中文
- 微信成功判定收紧：无 message_id 的 HTTP 200 视为静默失败（`weixin-noack`），不再误报发送成功
- 失败退避：自动推送失败后该通道休息 30 分钟再试，避免把平台限流越拖越长；手动测试不受影响
- ret -2 显示专项指引（给机器人发消息＋暂停发送），不再只提示重新扫码

### English
- Stricter WeChat ack: HTTP 200 without message_id counts as a silent failure (`weixin-noack`), no more false "sent" reports
- Failure backoff: a failed channel rests 30 minutes before auto-push retries, so platform throttles can decay; manual tests unaffected
- Dedicated ret -2 guidance (message the bot + pause sending) instead of only suggesting re-login

## [v0.4.5] - 2026-09-08

### 中文
- 已解决的告警标记「已恢复」：条件消失后不再参与推送、「待处理」与灵动岛，已读逻辑不变；同条件再次触发视为新事件正常提醒

### English
- Resolved alerts are tagged and excluded from push, attention list and island popups; re-firing conditions alert as new events normally

## [v0.4.4] - 2026-09-08

### 中文
- 修复持续性告警（低余额、长期高用量）从不自动推送：调用方透传全部未读告警，每通道 4 小时冷却到期后自动重推（此前仅全新 id 推送，冷却逻辑实际从未生效）

### English
- Fix persistent alerts (low balance, long high usage) never auto-pushing: callers pass all unread alerts and each channel re-pushes after its 4h cooldown (previously only brand-new ids pushed, leaving the cooldown dead code)

## [v0.4.3] - 2026-09-08

### 中文
- 概览「待处理」卡片（原「需要注意」）重排：未读告警在前、异常账号在后，按账号去重，上限 6 条；健康账号不再在概览重复
- 余额 KPI 品牌 chips 按「服务商 × 币种」聚合、余额多者在前（≤2 个 logo 直显，更多悬停看完整明细）——本轮梳理确认无需改动

### English
- Overview "Action center" card (formerly "Needs attention") reordered: unread alerts first, error accounts after, deduped per account, capped at 6; healthy accounts no longer repeat on the dashboard
- Balance KPI brand chips aggregate by provider × currency, richest first (≤2 logos shown inline, more via the hover breakdown) — reviewed this round, no change needed

## [v0.4.2] - 2026-09-08

### 中文
- webhook 发送传输层失败自动重试一次，超时 10s→15s（iLink 端点偶发黑洞请求，下一次立即应答）；平台业务码失败不重试避免重复发送
- 告警行与概览「需要注意」行移除悬停高亮（点击仅标记已读，不该有可点的视觉暗示）；微信区块新增「验证连接」按钮，区分令牌失效与载荷被拒
- 修复告警规则卡吸底：有告警列表时规则卡不再贴上去，空/非空两种状态均保持 48px 底边距
- 已解决（条件消失）的告警保留 48 小时历史后自动清除，不再瞬间消失
- 概览页改版：KPI + 用量趋势 + 本地 Agent 用量 +「需要注意」列表 + 服务商分布；账户全量表格与套餐卡片回归各自专页
- 告警阈值可配置（窗口重置提前分钟 / 用量百分比 / 四币种余额下限），与套餐 attention 徽标联动
- 全仓原生 confirm / tooltip 替换为主题组件；账号抽屉测试按钮与保存对齐
- 成本分析按模型全量展示并标「未定价」；趋势图悬停明细与末日期修复
- 设置关于页新增 GitHub 仓库入口；更新可用时顶栏齿轮全局提示，Toast 支持稍后/立即安装

### English
- One automatic retry on transport-level webhook failures; timeout 10s→15s (the iLink endpoint occasionally black-holes a request while the next answers instantly); platform business-code rejections return immediately to avoid duplicate sends
- Drop hover highlight on alert rows and overview attention rows (clicking only marks read); WeChat block gains a "Verify connection" button separating token death from payload rejection
- Fix the rules-card pinning: with a populated alert list the card no longer floats up; 48px bottom gap holds in both empty and non-empty states
- Resolved alerts stay visible for 48 hours before auto-clearing instead of vanishing instantly
- Overview revamp: KPIs + trend + local agent usage + a "Needs attention" list + provider distribution; the full account table and plan cards return to their own pages
- Editable alert thresholds (reset lead minutes / usage percent / four-currency floors), synced with plan attention badges
- Native confirm/tooltip replaced with themed components app-wide; account-drawer test button aligned with save
- Cost analysis lists every model with an "Unpriced" tag; trend tooltip detail and last-date clipping fixed
- Settings About gains a repo shortcut; available updates badge the top-bar gear globally, with a later-or-install toast

## [v0.4.1] - 2026-09-08

### 中文
- 修复告警 IM 自动推送链路：集成管理推送卡新增健康状态行（草稿未保存、总开关、可用通道数、未读数、上次结果），测试与自动推送共用同一记录
- 余额单位兼容：小写与符号写法（¥ / $ 等）同样命中低余额阈值

### English
- Fix alert IM auto-push chain: push card gains a health status line (unsaved drafts, master switch, usable channels, unread count, last outcome); tests and auto pushes share one log
- Balance-unit tolerance: lowercase and symbol forms (¥ / $ etc.) hit the low-balance floor too

## [v0.4.0] - 2026-09-08

### 中文
- 微信推送排障：HTTP 200 业务失败不再吞掉平台错误详情（主进程同时落日志），成功判定兼容字符串型 code 与 data / result 包裹层
- 告警推送可观测：集成管理新增最近推送记录（支持折叠与清理），启动时存量未读告警补推一次（仍受 4 小时冷却约束）
- 成本分析记全账：无官方定价的中转模型照常列出用量并标「未定价」，按模型区改回按金额排序且全量展示
- 趋势图体验：悬停标签锚定数据点、当日 Top5 模型明细、末日期不再被裁剪
- 扫描韧性：逐客户端失败自动重试一次，跳过原因悬停可见（多为扫描时会话正被写入）
- 主题确认框替换全部原生 confirm；全仓原生 tooltip 换主题样式；账号抽屉测试按钮与保存对齐
- 告警阈值可在告警中心调整（重置提前分钟、用量百分比、四币种余额下限），套餐 attention 徽标联动
- 概览页瘦身：账户全量表格与套餐卡片移出，改为「需要注意」列表（异常账号直达编辑，未读告警直达告警中心）
- 设置关于页新增 GitHub 仓库入口；有可用更新时顶栏设置图标全局提示，下载完成后右下角 Toast 可选稍后或立即安装
- 告警中心规则卡吸底，空态居中

### English
- WeChat push diagnostics: HTTP 200 business failures no longer swallow the platform error detail (also logged in main), success checks accept string codes and data / result envelopes
- Observable alert pushes: integrations page gains a recent-push log (collapsible, clearable); pre-existing unread alerts get one backfill push at startup (still under the 4-hour cooldown)
- Complete cost ledger: models without catalog pricing (mostly relays) list usage with an "Unpriced" tag; the per-model section sorts by cost again with no cutoff
- Trend chart polish: hover tooltip anchors to the data point, per-day top-5 model breakdown, last date label no longer clipped
- Scan resilience: per-client scans retry once on failure; skip reasons visible on hover (usually a session file being written mid-scan)
- Themed confirm dialog replaces every native confirm; app-wide native tooltips replaced with themed ones; account-drawer test button aligned with save
- Alert thresholds editable in the alerts center (reset lead minutes, usage percent, four-currency balance floors); plan attention badges follow
- Slimmer overview: full account table and plan cards moved out, replaced by a "Needs attention" list (error accounts jump to the editor, unread alerts to the center)
- Settings About gains a GitHub repository shortcut; available updates badge the top-bar gear globally, with a bottom-right toast for later-or-install once downloaded
- Alerts-center rules card pins to the bottom with a centered empty state

## [v0.3.0] - 2026-09-05

### 中文
- 告警推送集成管理上线：支持企业微信群机器人、微信 iLink 机器人（应用内扫码登录，走微信官方接口）、飞书 / Lark 与 Telegram 四个通道；Webhook 地址与令牌像 API Key 一样加密存储，同一告警每通道 4 小时内只推一次，通道间独立失败互不影响
- 灵动岛告警提醒：应用内顶部弹出 iOS 风格灵动岛（快弹慢收、从胶囊绽放、多告警合并显示「还有 N 条」）；桌面端新增「桌面灵动岛」开关，开启后新告警直接弹出在屏幕顶部正中（所有应用之上），点击直达告警中心
- 本地 Agent 用量新增 ZCode：直读 `~/.zcode/cli/db/db.sqlite`（与 ZCode 内置用量统计同源），随扫描管线、命名与图标完整接入
- 告警引擎修复：额度窗口重置时间已过的高用量告警自动失效，不再连续多日悬挂（如失效订阅持续上报的 100% 旧值）
- tokscale 扫描加固：所有扫描统一禁用 spinner（消除 stderr 乱码与中文渠道名下的间歇性崩溃），错误信息优先显示 panic 行便于定位
- 移除团队管理占位页；修复纯浏览器构建（dev:web / build:web）缺少版本常量导致的白屏

### English
- Alert-push integrations: four channels — WeCom group robot, WeChat iLink bot (in-app QR login over WeChat's official API), Feishu / Lark and Telegram; webhook URLs and tokens are encrypted at rest like API keys, the same alert is pushed at most once every 4 hours per channel, and channels fail independently
- Dynamic-island alert surface: an iOS-style island pops inside the app (fast bouncy expand, damped collapse, bloom-from-pill entrance, merged "+N" counts); a "Desktop island" toggle makes new alerts pop centered at the top of the screen above every app, clicking through to the alerts page
- Local agent usage adds ZCode: reads `~/.zcode/cli/db/db.sqlite` directly (the same source as ZCode's built-in stats), wired through the scan pipeline, labels and icon
- Alert engine fix: high-usage alerts whose window reset time already passed go stale instead of lingering for days (e.g. a dead subscription still reporting an old 100%)
- tokscale hardening: every scan disables the spinner (removes stderr garbling and intermittent panics around CJK channel names) and error messages surface the panic line first
- Removed the team management placeholder page; fixed the blank-screen crash in browser builds (dev:web / build:web) caused by a missing version constant

## [v0.2.0] - 2026-09-02

### 中文
- 概览「服务商分布」卡片重构：改为展示本月实际用量占比并按成本分析页同源排布（按成本排序、降低折叠阈值展示更多真实服务商），中心标注改为「本月用量」并显示「数据截至 HH:MM」扫描时间戳，不再误标为「总额度」
- 本地 Agent 扫描增加三层弹性：预置 LiteLLM 定价缓存（走加速镜像，中国大陆网络不再因超时降级）；整批扫描失败时自动降级为逐客户端扫描并合并健康客户端数据；被跳过的客户端在「本地 Agent 用量」卡片显示橙色提示
- 修复服务商虚假归属：tokscale 对 Kimi Code 会话硬编码 provider 为 moonshot，即使实际使用第三方路由（DeepSeek / GLM / SenseNova 等）也被归到 Moonshot；现在按模型 id 的路由前缀重新归因（如 `opencode/deepseek-…` → OpenCode Go），未知前缀保留原文，并提供友好显示名映射表
- 本地 Agent 扫描失败时保留上次成功数据并显示部分结果提示，而不是整卡清空

### English
- Overview "Provider distribution" card reworked: shows the actual month usage share ordered like the cost-analysis page (sorted by cost, lower fold threshold to reveal more real providers), the center label now reads "This month usage" with an "As of HH:MM" scan timestamp instead of the misleading "Total quota"
- Local-agent scan gained three resilience layers: pre-seeded LiteLLM pricing cache via the regional mirror (no more timeout degradation on mainland China networks); automatic per-client fallback that merges healthy clients when the combined scan dies; skipped clients are shown with an amber notice on the "Local agent usage" card
- Fixed false provider attribution: tokscale hardcodes `moonshot` as the provider for every Kimi Code session even when a third-party router (DeepSeek / GLM / SenseNova …) actually served the traffic; provider is now re-attributed from the model id's router prefix (e.g. `opencode/deepseek-…` → OpenCode Go), unknown prefixes stay raw, plus a friendly display-name map
- When the local-agent scan fails, last-known-good data is kept and a partial-result notice is shown instead of blanking the whole card

## [v0.1.3] - 2026-08-30

### 中文
- 显示币种换算升级为实时汇率：每日后台从公开汇率源刷新（166 种货币全表），落盘缓存，断网时自动回落静态参考表；成本分析与用量统计的金额随显示币种实时换算（实测 USD→CNY 静态值 7.16 已漂移至 6.75，误差约 6%）
- 官方订阅额度新增 Grok 卡：读取本地 `grok login` 凭据（~/.grok/auth.json），经官方 billing 接口显示 SuperGrok 用量百分比与重置时间，套餐名（SuperGrok / SuperGrok Heavy）随卡片展示；凭据不出主进程，令牌过期会提示重新 `grok login`
- 本地 Agent 用量新增 WorkBuddy（tokscale 直接读取 `~/.workbuddy` 会话，实测接入即出数据）；Trae 改为扫描前自动同步账号用量（`tokscale trae sync`，已认证即生效——国内版 Trae SOLO 的 API 当前不返回用量记录，国际版用户自动可用）
- 系统设置新增「软件更新」区块：手动检查、发现新版本、下载进度、一键重启安装
- 更新下载双通道：默认走 GitHub 直连，检测失败自动切换加速镜像重试（主要面向中国大陆网络），本次会话内记住选择
- macOS / Linux 同步获得以上全部能力

### English
- Display-currency conversion now uses live FX rates: refreshed daily in the background from a public rates source (166 currencies), cached to disk, falling back to the static reference table offline; cost analysis and usage-stat figures convert in the selected currency (the stale static USD→CNY 7.16 had drifted ~6% from the live 6.75)
- Subscription quota adds a Grok card: reads the local `grok login` credentials (~/.grok/auth.json), queries the official billing endpoint for SuperGrok usage percentage and reset time, with the plan name on the card; credentials never leave the main process and an expired token points to `grok login`
- Local agent usage adds WorkBuddy (tokscale reads `~/.workbuddy` sessions directly — data appears on first scan); Trae now syncs account usage automatically before each scan (`tokscale trae sync`, effective once authenticated — the China Trae SOLO API currently returns no usage records, international editions work out of the box)
- Settings gains a "Software updates" section: manual check, new-version discovery, download progress and one-click restart-and-install
- Update downloads fail over: GitHub direct by default, automatically switching to a regional mirror when unreachable (mainland China networks); the choice sticks for the session
- macOS / Linux builds ship with all of the above

## [v0.1.2] - 2026-08-29

### 中文
- 修复部分用户机器上本地 Agent 用量整体为空的问题：tokscale 在定价目录拉取失败时可能以非零码退出（exit 101），导致整次扫描被丢弃。现在非零退出但输出为完整 JSON 时直接采用输出，扫描失败自动重试一次，错误信息保留 1200 字符以便定位真实原因
- 成本改为按官方模型定价计算：内置 OpenRouter 全量目录（396 个模型，含缓存读/写单价），应用内每日后台刷新并落盘缓存，断网时离线可用；扫描结果中每个模型的成本按官方单价重算，`-free` 免费变体计为 $0，未收录模型保留 tokscale 原值
- macOS 未签名构建的 Gatekeeper 绕过说明与 Linux AppImage 使用方式已写入 README

### English
- Fixed empty local agent usage on some machines: tokscale could exit non-zero (exit 101) when its pricing catalog fetch failed, discarding the whole scan. Complete-JSON output is now accepted on non-zero exits, scans retry once, and error text keeps 1200 chars so the real cause is visible
- Costs now follow official per-model pricing: the full OpenRouter catalog (396 models, including cache read/write rates) ships as an offline seed, refreshes daily in the background, and every matched model's cost is recomputed; `-free` variants price at $0 and unknown models keep tokscale's value

## [v0.1.1] - 2026-08-29

### 中文
- 修复打包版本地 Agent 用量扫描报错（`spawn ...app.asar\...\tokscale.exe ENOENT`）：二进制解析到了 asar 包内虚拟路径，而真实文件在 `app.asar.unpacked`；现在 spawn 前把路径段替换为解包目录。Windows / macOS / Linux 打包版同时受影响，本版全部修复
- v0.1.0 已安装用户会通过应用内自动更新收到本版

### English
- Fixed the packaged build's local agent scan failing with `spawn ...app.asar\...\tokscale.exe ENOENT`: the binary resolved to the virtual in-asar path while the real file lives in `app.asar.unpacked`; the path segment is now swapped before spawn. All three packaged platforms were affected, all fixed in this release
- v0.1.0 installs receive this fix through the in-app auto-updater

## [v0.1.0] - 2026-08-29

### 中文
- Linux 版本首发（x64 AppImage，`chmod +x` 后直接运行，无需安装与签名）
- macOS 版本首发（Apple Silicon 与 Intel 双架构，dmg 安装 + zip 自动更新包）：当前为未签名构建，首次打开需右键 App 选「打开」，或执行 `xattr -cr` 移除隔离属性（见 README）；Windows 保持 NSIS 安装版 + 便携版
- 桌面端首发：Electron 44 外壳（托盘常驻、自绘窗口三键、关窗「最小化到托盘/退出」确认弹窗、开机自启开关、Chromium 沙箱 + 严格 CSP），支持 Windows NSIS 安装版与便携版
- 多服务商套餐与余额面板：OpenCode Zen Go、智谱 GLM（国内/国际）、Kimi/Moonshot、DeepSeek、SiliconFlow、OpenRouter、MiniMax Token Plan、火山方舟（AK/SK 签名）、StepFun、Novita，共 10 家、每家可配多账号；密钥经 safeStorage 加密存储（`enc:v3:`），带文件级备份镜像与 v1→v2→v3 迁移
- 官方订阅额度卡：Codex（ChatGPT 登录）、Claude Code、Gemini CLI 均只读本机登录态（凭据不出主进程），展示 5 小时/每周/逐模型配额窗口与重置倒计时，无登录时显示诚实空态
- 本地 Agent 真实用量：经 tokscale 扫描 20 种主流编码工具（Codex、Claude Code、Kimi Code、OpenCode、Gemini CLI、Cursor、GitHub Copilot、Qwen、Trae、Cline、Roo Code 等），只显示检测到数据的行；今日/本月/累计三栏 + 数据截至时间标注；缓存读取口径可在设置中切换
- 12 个页面：概览（KPI、趋势、账户概览、服务商分布、本地用量、套餐概览）、智能体/服务商/账户/套餐管理、用量统计、成本分析、趋势分析、告警中心、集成、团队、系统设置
- 启动提速：上次查询结果与扫描摘要本地缓存回放，首屏即时出数；加密密钥场景合并为单次请求周期
- 告警体系：窗口即将重置、用量 ≥90%、低余额三类告警；顶栏铃铛悬停预览（打开即视为已读）与告警中心全量管理
- 自动更新：electron-updater 检查 GitHub Releases，下载完成后右下角弹出「立即重启安装」提示；预留 Authenticode 签名接入点
- 界面：深浅色主题（跟随系统）、中英双语、自绘 SVG 图表（趋势线/环形图）、motion 动效并尊重系统「减少动态效果」

### English
- First Linux release (x64 AppImage — `chmod +x` and run, no install or signing required)
- First macOS release (dual-arch Apple Silicon + Intel, dmg installer + zip auto-update bundle): currently unsigned — right-click the App and choose Open on first launch, or run `xattr -cr` to drop the quarantine flag (see README); Windows keeps NSIS installer + portable builds
- First desktop release: Electron 44 shell (tray-resident, custom caption buttons, close dialog with minimize-to-tray or quit, launch-on-login toggle, Chromium sandbox + strict CSP), shipping Windows NSIS installer and portable builds
- Multi-provider plan & balance dashboard: OpenCode Zen Go, Zhipu GLM (CN/Intl), Kimi/Moonshot, DeepSeek, SiliconFlow, OpenRouter, MiniMax Token Plan, Volcengine Ark (AK/SK signing), StepFun and Novita — 10 providers, multiple accounts each; keys are safeStorage-encrypted (`enc:v3:`) with a file backup mirror and v1→v2→v3 migration
- Official subscription quota cards: Codex (ChatGPT login), Claude Code and Gemini CLI read only the local login state (credentials never leave the main process), showing 5-hour/weekly/per-model windows with reset countdowns and honest empty states
- Real local agent usage: tokscale scans 20 mainstream coding tools (Codex, Claude Code, Kimi Code, OpenCode, Gemini CLI, Cursor, GitHub Copilot, Qwen, Trae, Cline, Roo Code, …); only clients with data are listed; today/month/all-time columns with an "as of" timestamp; cache-read accounting is switchable in settings
- 12 pages: overview (KPIs, trend, accounts table, provider distribution, local usage, plan cards), agent/provider/account/plan management, usage stats, cost analysis, trends, alerts center, integrations, team, settings
- Faster startup: last fetch results and scan summary are cached locally and replayed on launch; encrypted-key launches run a single request cycle
- Alerts: window-reset, high-usage (≥90%) and low-balance rules; bell hover preview in the top bar (opening marks them read) plus a full alerts center
- Auto-update: electron-updater watches GitHub Releases and offers a "restart & install" toast once downloaded; Authenticode signing hookup is prepared but optional
- UI: light/dark/system themes, zh-CN/en-US locales, hand-rolled SVG charts (trend line, donut), motion animations honoring the system "reduce motion" preference
