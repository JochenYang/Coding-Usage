# Changelog

Coding Usage 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更，
与 GitHub Release 的 release notes 保持一致。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.0]`），打 `v*` tag 推送后
release workflow 会自动构建 Windows 安装包并用本文件生成双语 release notes
（`node scripts/gen-release-notes.mjs v0.1.0` 可本地预览）。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，
新条目加在列表顶部。

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
