# Changelog

Coding Usage 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更，
与 GitHub Release 的 release notes 保持一致。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.0]`），打 `v*` tag 推送后
release workflow 会自动构建 Windows 安装包并用本文件生成双语 release notes
（`node scripts/gen-release-notes.mjs v0.1.0` 可本地预览）。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，
新条目加在列表顶部。

## [Unreleased]

### 中文
- （暂无）

### English
- (nothing yet)

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
