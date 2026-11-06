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
- 灵动岛浮层隐藏后不再常驻一个渲染进程：隐藏 30 秒后销毁窗口，下一条告警按需重建。实测释放 113 MB 工作集 / 38–55 MB 私有内存，重建到告警可见约 220 ms；该进程此前会一直挂在后台（JS 堆不足 10 MB，其余全是 Chromium 的单进程底座）
- 修复浮层的首条告警可能丢失：待发告警原来在页面加载完成时回放，此时渲染层还没订阅监听器；改为渲染层就绪（新增 `island:ready`）后再投递，重建出来的窗口也能收到第一条告警
- 三张按 20px 显示的 Agent 品牌图标改用 128px 源图（原为 512 / 1024px），资源体积 1,020 KB → 62 KB，显示效果不变
- 发布说明的页脚不再只写「Windows」：改为列出 Windows（NSIS / 便携版）、macOS（dmg / zip，含未签名的首次打开提示）与 Linux（AppImage）三平台；本地预览时的 CRLF 也会归一成 LF，与 workflow 生成的正文一致

### English
- The island overlay no longer keeps a renderer process alive after it hides: the window is destroyed 30 seconds after it goes away and recreated on the next alert. Measured: releases 113 MB of working set / 38–55 MB of private memory, with about 220 ms from recreate to a visible alert; the process used to sit in the background for the whole session (its JS heap is under 10 MB — the rest is Chromium's per-process baseline)
- Fixed the overlay dropping its first alert: pending batches were replayed when the page finished loading, before the renderer had subscribed; they are now delivered once the surface reports it is listening (new `island:ready`), so a freshly created window receives its first alert too
- The three agent brand icons drawn at 20px now ship 128px sources instead of 512 / 1024px ones: 1,020 KB → 62 KB of assets, identical on screen
- The release-notes footer no longer claims Windows only: it now lists all three platforms — Windows (NSIS / portable), macOS (dmg / zip, with the unsigned first-launch note) and Linux (AppImage) — and a local preview normalizes CRLF to LF so it matches the body the workflow generates

## [v0.8.9] - 2026-11-06

### 中文
- 本地 Agent 用量：Cindy 的读取器现在会找出机器上所有 Cindy 构建的 agent home（国内版 `%APPDATA%/Cindy`、国际版 `%APPDATA%/CindyGlobal`），并各自成为用量卡里的独立一行（`Cindy` / `Cindy Global`）。此前只认 `Cindy` 一个目录，换成国际版的用户那一行直接没有数据
- 目录名改为按 `Cindy` 前缀扫描，构建改名不会再让这一行静默消失；认不出的构建名归到国内版那一行，不会被丢掉。跨构建按 entry id 去重：国际版首次启动迁移过来的会话只算一次，并留在实际产生它的那一行
- 网关的 `auto/<模型>` 模型 id（国际版的路由写法）不再把 `auto` 当成厂商：前缀剥掉后归到实际提供服务的 provider，同一个模型在国内版和国际版里落到一行、同一份价格
- 供应商分布里表里没有的 provider id 改为可读写法：`-` / `_` 分隔的 slug 按词首字母大写显示（`little-jochen` → `Little Jochen`），没有分隔符的 id 保持原样，不凭空造名

### English
- Local agent usage: the Cindy reader now discovers every installed Cindy build's agent home (`%APPDATA%/Cindy` for the domestic build, `%APPDATA%/CindyGlobal` for the international one) and gives each its own row on the usage card (`Cindy` / `Cindy Global`). It used to know only `Cindy`, so a user who moved to the international build saw no data on that row at all
- Build userData directories are now found by the `Cindy` prefix instead of a hard-coded name, so a renamed build can no longer make the row vanish silently; a build name the table does not know feeds the domestic row instead of being dropped. Entry ids are deduplicated across builds, so a session migrated over on the international build's first run is counted once and stays on the row that produced it
- Gateway model ids of the form `auto/<model>` (the international build's routing spelling) no longer turn `auto` into a provider: the prefix is stripped and the generation is attributed to the provider that actually served it, so one model lands on one row and one price across both builds
- Provider ids the label table has not learned yet now read as words: a `-` / `_` slug is title-cased (`little-jochen` → `Little Jochen`), while an id with no separator is left exactly as it is — no name is invented

## [v0.8.8] - 2026-11-06

### 中文
- 修复 Antigravity 用量把历史会话算到「今天」的问题：本地会话库里缺少逐行时间戳的行，原先按数据库文件（含 -wal / -shm 附属文件）的修改时间归档；而 Antigravity 打开或关闭时会做 checkpoint，刷新这些时间，于是没在用它也每天显示新增用量。现在这类行改按会话文件的创建时间归档，完全不再参考附属文件；连创建时间都取不到的行直接跳过，不再落到 1970-01-01
- 补充回归测试：有逐行时间戳时按其日期归档；无时间戳时按创建时间归档且不受文件 mtime 影响；重复 response id 只计一次

### English
- Fixed Antigravity usage being credited to "today": rows in a local conversation database that carry no per-row timestamp were dated by the database file's mtime, including its `-wal` / `-shm` sidecars — and Antigravity rewrites those on every checkpoint when it opens or closes, so a dormant account showed fresh usage every day. Such rows are now dated to the conversation file's creation time and never consult the sidecars; a row with no usable date at all is skipped instead of landing on 1970-01-01
- Added regression tests: timestamped rows keep their own dates, timestamp-less rows use the creation date and ignore the file mtime, and a repeated response id is counted once

## [v0.8.7] - 2026-11-03

### 中文
- 套餐计划页的卡片可以拖动调整顺序，官方订阅额度那九张卡同样支持；顺序保存在本地设置里，重载、重启后保持，导入导出也一并带上。键盘也能排序：聚焦卡片后用方向键移动，屏幕阅读器会播报新位置
- 筛选状态下拖动只重排当前可见的卡片，被筛掉的卡片保持原位置；新增或删除账号不会打乱已排好的顺序
- 修复拖动时卡片不跟手、整体偏移的问题：换位会移动卡片的 DOM 节点并让浏览器释放指针捕获（改为在 window 上监听），悬停动画与拖拽共用同一个位移值互相覆盖（悬停改为阴影提示），位置基准用了不含滚动量的 offsetLeft/offsetTop（改为按视口矩形减去自身位移计算）
- 修复套餐计划页出现两条竖向滚动条：屏幕阅读器的播报区用了绝对定位且没有定位祖先，把文档撑高；改为 fixed，不再参与布局

### English
- Cards on the plans page can be dragged into your own order, including all nine official-subscription cards. The order is saved in local settings and survives reloads and restarts, and is carried by settings export/import. Reordering also works from the keyboard: focus a card and use the arrow keys, with the new position announced to screen readers
- While a filter is active, dragging reorders only the visible cards; filtered-out cards keep the slots they already occupied, and adding or removing an account does not disturb an arrangement you already made
- Fixed the dragged card drifting away from the pointer and landing offset: reordering moves the card's DOM node, which makes the browser release pointer capture (now listened for on window), the hover animation and the drag shared one offset value and overrode each other (hover now shifts a shadow instead), and the position baseline used offsetLeft/offsetTop, which ignore the ancestor's scroll (now the viewport rect minus the element's own transform)
- Fixed the plans page showing two vertical scrollbars: the screen-reader live region was absolutely positioned with no positioned ancestor, which pushed the document taller than the viewport; it is now fixed and takes no part in layout

## [v0.8.6] - 2026-11-02

### 中文
- Cursor 与 GitHub Copilot 的套餐额度改为自动读取本地登录，不用再手动粘贴 token：Copilot 读扩展写的 hosts.json（%LOCALAPPDATA%\github-copilot\hosts.json，macOS/Linux 为 ~/.config/github-copilot/hosts.json），Cursor 先读 cursor-agent 的 auth.json、再读 Cursor 的 state.vscdb（ItemTable 的 cursorAuth/accessToken，TEXT 与 UTF-16 BLOB 两种存储都处理）
- 两者的会话凭据全程只在主进程使用：Cursor 的 WorkosCursorSessionToken cookie 由 token 里的 JWT 现算，渲染进程只拿到用量数字。Cursor 新版若把 token 用系统钥匙串加密（cursor-safe-storage:v1: 前缀），卡片明确说明本应用读不到并指向服务商页的手动粘贴入口，而不是发一个注定失败的请求
- 套餐页新增这两张卡片，与 Codex / Claude / Gemini / Grok / Trae / Kimi / Antigravity 并列；未安装对应客户端时显示“未检测到登录”而不是空白
- 手动粘贴的入口仍然保留：读不到本地登录时（例如 Cursor 用钥匙串加密了 token，或想再加一个账号），可在服务商页添加 Cursor / GitHub Copilot 并粘贴 token 查询；两条路径互不冲突，填了账号就用账号的，没填就走本地登录

### English
- Cursor and GitHub Copilot plan quota is now read from the client's own login, so no token has to be pasted: Copilot comes from the extension's hosts.json (%LOCALAPPDATA%\github-copilot\hosts.json, or ~/.config/github-copilot/hosts.json on macOS/Linux), Cursor from cursor-agent's auth.json first and then Cursor's state.vscdb (ItemTable row cursorAuth/accessToken, handling both TEXT and UTF-16 BLOB storage)
- The session credential stays in the main process for both: Cursor's WorkosCursorSessionToken cookie is derived from the token's JWT there, and the renderer only receives usage numbers. When a recent Cursor build seals the token with the OS keychain (cursor-safe-storage:v1: prefix), the card says this app cannot read it and points at the manual paste path instead of sending a request that cannot succeed
- Both appear as cards on the plans page beside Codex / Claude / Gemini / Grok / Trae / Kimi / Antigravity, and show an honest "no login found" state when the client is not installed
- The manual path stays available: when the local login cannot be read (a sealed Cursor token, or a second account), add Cursor / GitHub Copilot on the providers page and paste a token. The two paths do not conflict — a configured account uses its own token, otherwise the local login is used

## [v0.8.5] - 2026-11-02

### 中文
- 套餐额度补上两家新来源，填写 token 即可查询：Cursor（/api/usage-summary，用 token 里的 JWT 现算 WorkosCursorSessionToken cookie）与 GitHub Copilot（copilot_internal/user，把「剩余百分比」换算成已用）；两者作为服务商接入，支持多账号与套餐筛选
- Codex 卡片补上接口已返回但此前未解析的信息：计划类型、随用随付余额、可用重置次数与个人限额；窗口时间同时接受 reset_at 与 resets_at（ISO 形式此前会被误读成 2026 这个数字）
- Claude 卡片补上 limits[] 里的按模型周限额，模型级额度耗尽不再显示成一切正常
- Z.ai 套餐额度在接口只给 currentValue / usage 而不给 percentage 时按两者比值反推，不再静默丢掉整条窗口
- 灵动岛入场与退场统一成同一段物理：内容在壳长完前落定、收缩时文字先退净再让胶囊收尾，并去掉透明置顶窗口上逐帧的模糊滤镜；收缩时长由 300ms 调整为 280ms

### English
- Two new plan-quota sources, both keyed by a pasted token: Cursor (/api/usage-summary, with the WorkosCursorSessionToken cookie derived from the token's JWT) and GitHub Copilot (copilot_internal/user, converting the reported remaining percentage into used). Both are providers, so multi-account and plan filtering work the same way
- The Codex card now reads what the endpoint already returned: plan type, pay-as-you-go balance, reset credits and the personal spend cap. Window times accept reset_at and resets_at, the ISO form of which used to be misread as the number 2026
- The Claude card now shows the model-scoped weekly limits from limits[], so an exhausted per-model allowance no longer looks like a healthy account
- Z.ai plan windows derive their percentage from currentValue / usage when the API omits percentage, instead of silently dropping the window
- The dynamic island open and close now run as one gesture: content lands before the shell finishes growing, text clears before the pill finishes collapsing, and the per-frame blur filter is gone from the transparent overlay; the collapse is 280ms instead of 300ms

## [v0.8.4] - 2026-11-02

### 中文
- 本地 Agent 成本改以 models.dev 官方厂商价为主：只取厂商自有店面，过滤第三方与 coding-plan/token-plan 的零价条目；OpenRouter 仅在 models.dev 拉取失败时兜底。内置快照重新生成（251 个模型，2026-11-02），旧的 OpenRouter 价格缓存升级后自动失效
- 计价补齐 cache read/write 默认倍率（input × 0.1 / × 1.25）、长上下文分档、fast/flex 倍率与常见路由前缀匹配；长上下文分档只在单条消息聚合时启用，避免把整日多请求误按高价档计费。历史用量在每次扫描时按当前价格表重新计价，避免新旧价源混算；tokscale 只提供单一 cacheWrite 桶，1h 缓存写入暂按 5m/默认价计
- 成本页显示价格来源、更新时间与覆盖模型数，并增加「已知成本下限」和兜底价格提示；缺价 token 不再静默按 0 混入总额

### English
- Local-agent cost now uses models.dev official vendor prices: only vendor-owned storefronts are accepted, filtering third-party and coding-plan/token-plan zero-price listings; OpenRouter is only a fallback when models.dev cannot be fetched. The builtin snapshot is regenerated (251 models, 2026-11-02), and the old OpenRouter price cache is invalidated on upgrade
- Pricing now fills cache read/write defaults (input × 0.1 / × 1.25), long-context tiers, fast/flex multipliers and common route-prefix matching; long-context tiers apply only to single-message aggregates so a busy day is not billed at the high-context rate. History is repriced against the current table on every scan so old and new price sources cannot mix; tokscale exposes one cacheWrite bucket, so 1h cache writes use the 5m/default rate
- The cost page shows the price source, update time and model count, plus a known-cost floor and fallback-price note; unpriced tokens are no longer silently folded into the total as zero

## [v0.8.3] - 2026-11-02

### 中文
- Antigravity 额度接口按当前 Cloud Code 协议重写：User-Agent 改为 `antigravity/hub/<版本>`（版本从官方更新清单读取），旧的 1.x 版本标识会让服务端返回裁剪过的额度摘要、静默丢掉 Gemini 组；同时补上 `loadCodeAssist` 的 project 参数，并在摘要为空时用 `fetchAvailableModels` 的每模型额度重建 5 小时池。`remainingFraction` 省略按 0% 处理，额度耗尽的一档不再从卡片消失
- 告警中心、概览「近期告警」、账户页与侧边栏的相对时间不再只显示分钟：超过 60 分钟显示「x 小时 x 分钟前」，超过 24 小时显示「x 天 x 小时前」，两个月前的旧告警不再显示成 `78776 分钟前`
- 告警中心「已恢复」徽标从标题行移到右侧状态区，与时间文本共用一条垂直居中的线（两者此前相差 8px）

### English
- Rewrite the Antigravity quota probe against the current Cloud Code protocol: the User-Agent now identifies as `antigravity/hub/<version>` (version read from the official updater manifest) because a 1.x build string makes the service return a reduced summary with the Gemini pool silently dropped; the probe also names the `loadCodeAssist` project and rebuilds the 5-hour pools from `fetchAvailableModels` when the summary is empty. An omitted `remainingFraction` reads as 0%, so an exhausted pool no longer disappears from the card
- Relative times in the alerts center, the overview "Recent alerts" card, the accounts page and the sidebar step up past minutes: over 60 minutes reads "x h x min ago", over 24 hours "x d x h ago", so an old alert no longer says "78776 min ago"
- The alerts center's "Resolved" badge moved from the title line to the right-hand status group, sharing one vertically centred line with the time text (the two were 8px apart)

## [v0.8.2] - 2026-10-31

### 中文
- 本地 Agent 用量：Cindy 的读取路径收敛为 `cindyAgentHome()` 一处并由测试固定（`<appData>/Cindy/pi-agent-home`）。此前目录拼接分散在主进程与读取器两边、没有断言，改错一级目录的表现是「Cindy 一行凭空消失」且没有任何报错
- 用量趋势与模型对比的「输出速度」补上口径注释：Cindy、Qoder、CodeBuddy IDE、Trae 国内版这类由主进程直读的客户端只贡献输出、不贡献时长，与有计时的客户端落在同一天时该数值会偏高；日级时长是扫描能提供的唯一粒度，所以这里记录边界而不改写指标
- README 纠正本地 Agent 的能力描述：覆盖数由「20 种」改为「20 余种」（实际 29 个标识，其中 25 个由 tokscale 扫描），并写明除 tokscale 扫描外主进程还直接读取 Cindy 的 Pi 会话、CodeBuddy IDE、Qoder CLI 与 Trae 国内版本地库

### English
- Local agent usage: Cindy's path resolution now lives in one function, `cindyAgentHome()`, pinned by a test (`<appData>/Cindy/pi-agent-home`). It used to be split between the main process and the reader with no assertion, so renaming one directory level would have made the Cindy row vanish with no error anywhere
- The trend and model-comparison "output speed" now documents its measurement: clients the main process reads directly (Cindy, Qoder, the CodeBuddy IDE, Trae CN) contribute output without seconds, so a day shared with a timed client reads high. A per-day clock is the only granularity the scan provides, so the limit is recorded instead of the metric being rewritten
- README corrects the local-agent description: "20-some" tools instead of "20" (29 ids, 25 of them scanned by tokscale), and it now names the stores the main process reads besides tokscale — Cindy's Pi sessions, the CodeBuddy IDE, the Qoder CLI and Trae CN's local database

## [v0.8.1] - 2026-10-31

### 中文
- 本地 Agent 用量新增 Cindy：Cindy 的 Pi 运行时使用自己的 agent home（`%APPDATA%/Cindy/pi-agent-home`，Cindy 自己的 userData，不是本应用的）而不是 `~/.pi`，tokscale 的 `pi` 客户端扫不到这部分记录，此前完全不计入。现在由主进程直接读取普通会话与子智能体运行两处的会话文件，按条目 id 去重（fork / clone 会把同一轮生成复制进第二个文件，只算一次），并带入记录里的模型、供应商与成本；其余读取器一样，只读 token 计数与模型 id，不触碰对话内容
- 补齐供应商显示名：Cindy 网关的 `moonshotai` / `z-ai` 前缀按厂商归并到 Moonshot / Z.ai，另加 `cindy` 本身；卡片里使用其安装目录的应用图标
- 新增 7 项测试覆盖 Cindy 读取器：会话头校验、助手消息与 `usage` / `compaction` 条目、损坏尾行、跨文件去重，以及聚合结果经 `summarizeScan` 后的呈现

### English
- Local agent usage gains Cindy: Cindy runs Pi on its own agent home (`%APPDATA%/Cindy/pi-agent-home` — Cindy's own userData, not this app's) instead of `~/.pi`, so tokscale's `pi` client never sees those transcripts and nothing was counted. The main process now reads the chat and subagent session files directly, deduplicating by entry id — a fork / clone replays the same generation into a second transcript and is counted once — and carries over each entry's model, provider and recorded cost. Like every other reader it reads token counters and model ids only, never conversation content
- Fold the gateway vendor prefixes Cindy emits onto their vendors (`moonshotai` → Moonshot, `z-ai` → Z.ai) instead of splitting one provider across two rows, add a display name for `cindy` itself, and draw the agent row with Cindy's own app icon from its install directory
- Add 7 tests for the Cindy reader: the session-header gate, assistant messages plus `usage` / `compaction` entries, torn trailing lines, cross-file deduplication, and the aggregated payload surviving `summarizeScan`

## [v0.8.0] - 2026-10-30

### 中文
- 本地 Agent 用量改为持久化保存：每次扫描到的每日用量（按智能体、模型、供应商拆分的四段 token、成本与调用数）写入本机 SQLite 数据库，不再随原始会话文件删除而消失。此前每次扫描只反映磁盘上现存的会话记录，删掉或轮转掉日志后，那部分用量会从今日、本月乃至累计数字里一并消失
- 合并规则为「新扫描优先、消失的智能体保留」：某天某个智能体不再出现在扫描结果里时，保留库里那天的记录，并把它的用量加回当天汇总，避免它从总量里消失却在按智能体明细里仍然存在
- 设置页新增「本地用量历史」区块：显示已存历史的起止日期与天数，可按 30 / 90 / 180 / 365 天前或全部清除，带二次确认，清除后自动重新扫描以同步界面。只清除已保存的历史，仍在磁盘上的会话文件会在下次刷新时重新计入
- 用量卡片的「数据截至」在数据不是当天时改为显示日期（`MM-DD HH:mm`）：扫描失败时会回放库里保存的历史，此前只显示时分，几天前的数据会被读成刚扫描的
- 新增 10 项测试覆盖历史库的合并与清除语义，含「合并结果重新聚合后未分类桶仍为空」的跨模块断言

### English
- Local agent usage is now persisted: each scanned day (four token tiers, cost and call counts split by agent, model and provider) is written to a local SQLite database, so deleting the original session logs no longer erases it. Until now every scan reflected only the transcripts still on disk, and a removed or rotated log took that usage out of the today, month and all-time figures alike
- Merge rule is "fresh scan wins, vanished agents are kept": when a day no longer reports an agent, the stored row for that day is kept and its usage is added back to the day total, so it cannot drop out of the headline while still showing under that agent
- Settings gains a "Local usage history" section: it shows the stored date range and day count, and can purge everything older than 30 / 90 / 180 / 365 days or the whole history behind a confirmation, rescanning afterwards so the views agree. Only stored history is removed — session files still on disk are counted again on the next refresh
- The usage card's as-of label now carries the date (`MM-DD HH:mm`) once the figures are not from today: a failed scan falls back to stored history, and a time-only stamp made days-old data read as freshly scanned
- Add 10 tests for the history store's merge and purge semantics, including a cross-module assertion that re-aggregating the merged day leaves the unclassified bucket empty

## [v0.7.1] - 2026-10-25

### 中文
- 修复灵动岛弹出与收起完全没有动效：此前宿主组件在渲染前就决定是否显示，外壳一帧内直接出现在最终尺寸、关闭时整块消失。现在挂载与收起由组件自己持有（`open` / `onExitComplete`），外壳从 126x37 的胶囊尺寸弹出到内容尺寸，关闭时缩回胶囊并淡出，动画结束才卸载
- 修复桌面覆盖窗（屏幕顶部居中的灵动岛窗口）在点击关闭的瞬间就隐藏、收缩动画被整段截断：现在窗口等收缩结束后才隐藏，并先恢复鼠标穿透
- 收缩期间的外壳不可点击、不进 Tab 顺序（`inert` 加 `pointer-events-none`）：退场中的按钮此前仍可被点到，误触会打断正在进行的收起
- 删除两帧 `requestAnimationFrame` 的临时补丁（`use-island-bloom`），胶囊与正文的进出改由外壳尺寸与内容弹簧共同驱动；`prefers-reduced-motion` 下改为整块淡入淡出，不再从胶囊尺寸瞬间跳变
- 为覆盖窗补超时兜底隐藏：窗口被遮挡时动画帧不再触发、退场回调可能永远不来，而常驻的置顶透明窗会吞掉桌面点击

### English
- Fix the island having no open or close animation at all: the host decided whether to render it before painting, so the shell appeared at its final size in one frame and vanished wholesale on close. Presence now belongs to the component (`open` / `onExitComplete`): the shell springs out of the 126x37 pill to the measured content, collapses back into the pill and fades, and only unmounts once that collapse finishes
- Fix the desktop overlay window (the island centred at the top of the screen) hiding the instant close was clicked, cutting the collapse off: it now hides after the collapse has finished, and restores click-through first
- Make the collapsing shell unclickable and untabbable (`inert` plus `pointer-events-none`): its buttons stayed live during the exit, and a stray click could interrupt the collapse
- Drop the two-frame `requestAnimationFrame` workaround (`use-island-bloom`); the pill and the body now move with the shell size and the content spring, and `prefers-reduced-motion` gets a plain cross-fade instead of a jump from the pill size
- Add a timeout fallback for hiding the overlay window: an occluded window stops receiving animation frames, so the exit callback may never arrive, and a permanently visible always-on-top transparent window would swallow desktop clicks

## [v0.7.0] - 2026-10-20

### 中文
- 修复智能体用量副标题的分项加不到主数字：缓存写入原本只并入合计、没有单独保留，于是提示词被写入缓存过的智能体，副标题里「输入 + 输出 + 缓存」会小于右侧的合计，差额无从解释。现在缓存写入单独成项，仅在非零时显示（这一档很稀疏，常年为 0 时不显示以免每行都拖一个 `0`）
- 为启动缓存补上 `cacheWrite` 归一化：旧缓存没有该字段，补齐为 0 而不是让它参与运算后得到 `NaN`

### English
- Fix the agent usage breakdown not adding up to the headline figure: cache writes were folded into the total but never kept as their own counter, so any agent whose prompts had been cache-written showed input + output + cache smaller than the total beside it with nothing accounting for the gap. Cache writes are now their own part, shown only when non-zero — the tier is sparse and reads 0 on most days, and a permanent zero would just add noise to every row
- Normalize `cacheWrite` when loading the startup cache: older caches lack the field, and 0 is the honest default instead of letting it participate in arithmetic as `NaN`

## [v0.6.9] - 2026-10-20

### 中文
- 本地 Agent 用量新增 Pi Agent（`pi`，pi.dev）：tokscale 的 `pi` 客户端已原生解析 `~/.pi/agent/sessions` 下的会话记录，随扫描管线、标签与图标完整接入，无需主进程另写读取器
- 本地 Agent 用量支持按智能体展开模型明细：点开任意智能体即可看到它实际请求过哪些模型、各自的今日 / 本月 / 累计用量。此前只有按模型合并的视图，同一模型经由不同智能体产生的用量无法区分
- 修复窄屏（375px）下本地 Agent 用量卡片的智能体名被数值列压成单字：数值列固定 220px 宽，而卡片在窄屏只剩约 280px，名字与数字叠在一起；现在窄屏改为名字与数值分两行，桌面宽度保持不变
- 修复启动缓存中残留的未知智能体 id 会让整个窗口白屏：展开行按 id 查标签，缓存若来自另一个版本（降级安装、或某个客户端已移除）拿到 `undefined` 后取下标即抛错，而应用没有错误边界，首帧抛出后永远不会挂载。现在读取缓存时丢弃本版本不认识的客户端行
- 模型明细里 token 为零的记录（credits 计费 / 中断的调用）不再显示成 `0`：这类行只有调用次数没有 token，三个 `0` 会被读成「测出来是零」，现在显示 `—` 表示未记录；同 token 时按调用次数排序，避免最久未用的模型排在最前
- 为扫描聚合补回归测试（7 项）：覆盖今日与本月双写、历史日归属、模型行恒为本智能体用量的子集、排序与零 token 并列顺序

### English
- Local agent usage adds Pi Agent (`pi`, pi.dev): tokscale's `pi` client already parses the transcripts under `~/.pi/agent/sessions`, so it joins the scan pipeline with its label and brand mark and needs no main-process reader
- Local agent usage can now expand any agent into the models it actually called, with today / month / all-time figures per model. Until now only a merged by-model view existed, where the same model id arriving from two different agents was indistinguishable
- Fix the agent names being crushed to a single character on a 375px viewport: the period columns are a fixed 220px while the card is only ~280px wide there, so names and figures drew on top of each other. Narrow screens now put the figures on their own line; the desktop layout is unchanged
- Fix a stale unknown agent id in the startup cache blanking the whole window: the expandable row resolves its label by id, so a cache written by another build (a downgrade, or a client since removed) yields `undefined` and the subscript throws. With no error boundary above the app, the first frame throws and the app never mounts. Cache reads now drop client rows this build does not know
- Token-zero records in the model detail (credits-billed or aborted calls) no longer render as `0`: such rows carry calls but no tokens, and three zeros read as a measured zero. They now show `—` for not recorded, and equal-token rows order by call count so the longest-unused model is not listed first
- Add regression tests for scan aggregation (7 cases): today/month double-write, historical day bucketing, the model-rows-are-a-subset invariant, ordering, and the zero-token tie-break

## [v0.6.8] - 2026-10-18
### 中文
- 修复 opencode 新版数组式 `variants`（`[{id, …}]`）在保存时被整段删除：读取端只认对象式，数组被当成「没有档位」，于是一次保存就把整段变体连同每个变体的请求体补丁一起删掉。现在两种写法都能读，且保存时保持记录原本使用的写法
- 修正上一版新增的「不重写」回归断言：其中两条只断言结果的顺序，重写与不重写产出相同，无法发现门控失效；改为断言对象引用同一性

### English
- Fix opencode's array-shaped `variants` (`[{id, …}]`) being deleted wholesale on save: the read path only understood the map shape, so an array looked like a model with no levels and a single save removed the whole field along with every variant's request-body patch. Both spellings are now read, and a record keeps the one it already used
- Fix the "does not rewrite" regression assertions added in the previous release: two of them only checked the resulting order, which a rewrite and a no-op both produce, so they could not detect a broken gate. They now assert reference identity

## [v0.6.7] - 2026-10-18

### 中文
- 修复在智能体管理里保存 provider 后，模型的推理档位被改写成乱序：opencode 按 `variants` 的键顺序渲染选择列表，而写入时沿用了输入数组的顺序、界面又按勾选顺序构造它，于是每保存一次就把 `none → low → medium → high → max` 打乱成 `low/high/medium/none`；读取端还把乱序原样读回界面，形成自持闭环。现在读取、写入与界面三处统一按强度序排列（kimicode 的 `support_efforts`、mcode 的 `thinking.effortOptions` 同样处理）
- 修复 `off` / `on` 被当作推理强度排序：它们是「关闭思考」与「不分档思考」两个状态而不是档位，此前会排在 `max` 之后，等于把关闭开关摆到最强一端；现在固定排在所有档位之前
- 修复默认推理档位无法清除：取消勾选该档位后界面发出的清空指令在校验层被折叠成「保持原值」，文件里留下一个指向已不存在档位的默认值；现在清空会真正写入

### English
- Fix model reasoning ladders being rewritten into a scrambled order after saving a provider in the agent config: opencode renders its picker from the key order of `variants`, but the write path reused the incoming array order and the editor built that array in click order, so every save turned `none → low → medium → high → max` into `low/high/medium/none`. The read path then fed the scrambled order straight back to the UI, closing the loop. Reading, writing and the editor now all use strength order (kimicode's `support_efforts` and mcode's `thinking.effortOptions` are handled the same way)
- Fix `off` / `on` being ranked as reasoning strengths: they are the "thinking disabled" and "ungraded thinking" states rather than rungs, and used to sort after `max`, which put the off switch at the strongest end of the picker. They now sort before every rung
- Fix the default reasoning level being impossible to clear: after unchecking that level, the clear instruction from the UI was collapsed into "keep the stored value" during validation, leaving the file with a default pointing at a level the model no longer declares. Clearing now actually clears

## [v0.6.6] - 2026-10-10

### 中文
- 趋势页的时间范围改为按真实日历日计算：「最近 N 天」原先取的是「最近 N 条有记录的天」，跨度可能远超 N 天，中断几周后相隔一个月的两天会被画成相邻两列；现在按日历日补齐，没有记录的日子以 0 计入，x 轴间距不再说谎
- 同一页的聚合列改为按真实跨度切分：原先按「每 7 条记录」分桶，实测「全部」档的 31 个「周」跨度从 3 天到 98 天不等，柱高之间无法比较；现在按跨度选列宽（30 天以内逐日、一个季度按周、更长按两周），「全部」档为 28 列 × 14 天
- 修复本地扫描不足两天、页面回退到本地归档或服务商快照时，分模型曲线与筛选后的指标错位：按模型的数据只对应扫描序列，回退时仍按索引套用会把某模型的第一天画在窗口最后一列下面
- 新增「历史累计」区块：全部模型的累计消耗、有消耗的天数与统计区间，以及按模型的累计排名（含占比、输出、调用次数），与上方时间范围无关
- 修复「不含缓存」模式下累计区块的按模型合计反而大于上方总量：扫描结果里每个模型本来就带着输入 token，只是原先没有保存，那一列只能用含缓存的口径；现在两处同源
- 修复「模型输出速度」严重偏低：分母取自扫描的「活跃时长」，而它实际上是会话跨度之和——实测 211 天里有 30 天超过 24 小时，最坏的一天记了 2471 小时却只有 6 次调用，这些天占了分母的 97%；超过一天的时长不是时长，现在这类日子连同与它配对的输出一起不参与计算，其余统计不变（实测该值由 1.06 修正为 34.6 tok/s）
- 趋势图最后一列不足一个完整周期时给出说明，避免柱高偏低被读成用量下滑
- 设置页的「清除趋势快照」更名为「清除账户配额快照」，并在确认时说明本地 Agent 的用量统计与趋势数据不受影响：该按钮清除的一直是各账户从服务商拉取的配额快照，90 天的本地日归档是另一份数据
- 移除已无引用的代码：三个组件（在线状态点、重置倒计时、套餐卡片的旧实现）、若干导出，以及每次扫描都计算却从未被读取的「当日按模型切片」；同时移除从未接线、也没有读取接口的开机自启桥接

### English
- The trends range selector now counts real calendar days: "last N days" used to mean "the last N days that have a record", which could span far more than N days — after a few weeks away, two days a month apart were drawn as adjacent columns. Missing days are now inserted as zeros, so the axis spacing no longer lies
- Aggregation on the same page now follows real spans: buckets were cut every 7 rows, which made the 31 "weeks" of the all-time range anywhere from 3 to 98 days long and their bar heights incomparable. The column width is now chosen from the span (daily up to 30 days, weekly for a quarter, fortnightly beyond), giving 28 columns of 14 days for the full range
- Fix per-model curves and filtered figures misaligning when the local scan covers fewer than two days and the page falls back to the local archive or provider snapshots: the per-model data describes the scan only, and applying it by index put a model's first day under the window's last column
- Add an all-time block: cumulative consumption across every model, the days carrying usage and the covered range, plus a per-model ranking with share, output and call counts — independent of the range above
- Fix the per-model total exceeding the headline in "no cache" mode: each model's input tokens were already in the scan, just never stored, so that column could only use the cache-inclusive figure. Both sides now share one basis
- Fix the output-speed figure reading far too low: its denominator is the scan's "active time", which is a sum of session spans — 30 of 211 days exceeded 24 hours, the worst recording 2471 hours for 6 calls, and those days took 97% of the denominator. Time beyond a day is not a duration, so such days no longer enter the rate, nor does the output paired with them; every other figure is unchanged (the value moves from 1.06 to 34.6 tok/s)
- The last column of the trend chart is now labelled when it covers a partial period, so a shorter bar is not read as a drop in usage
- Rename the settings action "Clear trend snapshots" to "Clear account quota snapshots" and say in the confirmation that local agent usage and trend data are unaffected: the action has always cleared the quota snapshots fetched from each provider, while the 90-day local daily archive is a separate store
- Remove code with no remaining references: three components (the online dot, the reset countdown and the old plan-card implementation), several exports, and a per-day model slice that every scan computed but nothing read; also remove the launch-on-login bridge, which was never wired and had no getter for a toggle to read
## [v0.6.5] - 2026-09-29

### 中文
- 新增三个本地 Agent 用量来源：Trae CN / SOLO CN（读取加密的本地会话库，密钥只在运行中的 IDE 内存里扫描得到，只回传聚合数字）、Qoder（会话 transcript）、CodeBuddy CN IDE（每个会话的逐条消息文件，与 tokscale 的 CLI 路径互不重叠，两边用量都会计入）
- 套餐计划页新增 Trae CN 官方额度卡：显示当前周期的 Credits 已用情况与重置倒计时，凭据不出主进程
- 修复在智能体管理里给 opencode 添加只填了「上下文」的模型后，整个 Provider 的模型全部消失：opencode 要求 `limit` 的 `context` 与 `output` 同时存在，缺一个会让它判定整个 Provider 非法并跳过；现在写入时自动补全缺失的 `output`（用 opencode 自身的默认值），无法补全时则移除该字段而不是留下半截
- 修复 Qoder 用量可能成倍虚高：流式追加的同一轮回复会多次落盘且计数递增，原先按行累加会把中间值也算进去；现在按消息 id 归并、只保留最终值
- 修复 Trae 扫描可能因一行损坏数据而完全读不到：改为只取需要子字段（用户消息正文不再进入进程内存），并过滤掉写入中途产生的坏行，避免一行坏数据让整库读取失败
- 修复 CodeBuddy CN IDE 侧用量在同时使用 CLI 的用户上被整体漏算：两个来源物理上互不重叠，现在无条件合并
- 修复 CodeBuddy 用量在成本分析里被归到错误的供应商：改为按模型名推断厂商（与 tokscale 一致），同一账号不再拆成两个供应商
- 修复 Trae 额度卡的定时器在每轮刷新后残留、组件卸载后仍会写状态

### English
- Three new local agent usage sources: Trae CN / SOLO CN (reads the encrypted local session store — the key is only ever scanned out of the running IDE's memory and only aggregates are returned), Qoder (session transcripts) and the CodeBuddy CN IDE (per-message files, disjoint from tokscale's CLI path so both halves are now counted)
- The plans page gains a Trae CN quota card showing credits consumed in the current period with its reset countdown; the credential never leaves the main process
- Fix every model under a provider disappearing after adding one with only a context window in the agent config: opencode requires both `context` and `output` inside `limit`, and a half-filled pair makes it reject the whole provider. The write path now completes the pair with opencode's own default output budget, or drops the field when it cannot
- Fix Qoder usage inflating: a streamed reply is appended several times with growing counters, so summing every line counted the intermediate values. Records are now merged by message id and only the final report is kept
- Fix a Trae scan losing everything to a single corrupt row: the query now selects only the sub-fields it needs (the user's message body no longer enters process memory) and filters out rows torn mid-write, which would otherwise abort the whole read
- Fix CodeBuddy CN IDE usage being dropped entirely for users who also run the CLI: the two stores cannot overlap, so the IDE half is now merged unconditionally
- Fix CodeBuddy usage being attributed to the wrong provider in the cost breakdown: the vendor is now inferred from the model name like tokscale does, so one account no longer splits into two providers
- Fix the Trae quota card leaving a timer behind on every refresh and writing state after unmount

## [v0.6.4] - 2026-09-23

### 中文
- 修复 Antigravity 额度卡每次都提示「登录凭据已失效或被拒绝」：刷新令牌要用的 OAuth 客户端原先取自语言服务器的二进制，而它导出的两个客户端 id 里，被选中的那个并不属于唯一的 secret，Google 对这对组合一律回 `invalid_client`；存档里的 access token 早已过期，于是每次取额度都必然走刷新分支、又必然被拒，看起来就像登录反复失效。现在按 IDE 自身 bundle（`app/out/main.js`）里声明的顺序成对读取，实测刷新成功并正常返回 Gemini 与 Claude/GPT 两组额度
- Antigravity 的客户端查找也更快了：优先读 IDE bundle 里的成对声明（两次小文件读取），仅在都未被接受时才去扫 135 MB 的语言服务器二进制；服务端明确回 `invalid_grant`（令牌真的失效）时立即停止尝试，不再把每个候选都试一遍；被缓存的客户端日后被拒时重新读取，IDE 升级换了客户端也会自愈

### English
- Fix the Antigravity quota card always asking the user to log in again: the OAuth client used to refresh the token was read from the language server binary, whose two client ids are not both owned by its single secret — the pair that got picked made Google answer `invalid_client` every time. The stored access token was long past its expiry, so every quota read took the refresh branch and every refresh was rejected, which read as a login that kept dying. The client is now read as declared pairs from the IDE's own bundle (`app/out/main.js`), and a live refresh returns both the Gemini and Claude/GPT pools
- That lookup is also cheaper and self-healing: the bundle's declared pairs are tried first (two small file reads) and the 135 MB language server binary is only scanned when none is accepted; an `invalid_grant` from Google (a genuinely dead token) stops the search instead of trying every candidate, and a cached client that is later rejected is re-resolved so an IDE update replaces the pair on its own

## [v0.6.3] - 2026-09-23

### 中文
- 概览页的服务商分布改为按用量排序：原来按成本排序，而价格未收录的服务商成本同为 0 而并列，图例看起来像随机排列（环形图的弧长本来就是按 token 画的）
- 套餐计划页的官方订阅额度跟上自动刷新：六张额度卡原先只在挂载时取一次，自动刷新期间进度条一直是旧的，必须离开页面再回来才更新；现在跟随刷新周期
- 修复微信 iLink 机器人重启后发送必失败：会话就绪判定改为依赖 getupdates 轮询（原用 getconfig 探活，而它对着未就绪的会话也会正常应答），recover 也把「被服务端 hold 住」判为成功而非失败；同时移除只会误报的「验证连接」按钮
- 主题切换改为带模糊的擦除过渡：改用 beui 的 theme-toggle（View Transition API），新主题从右上角以圆形展开并带 8px 模糊渐入，不再是一帧硬切；减少动效模式与不支持该 API 的环境自动退回瞬时切换
- 本地扫描不再因模型或供应商名含中文等非 ASCII 字符而丢失整个客户端：tokscale 的字节切片会 panic（exit 101、stdout 为空），客户端因此从面板消失；现在扫描前把 id 百分号编码、结果回传前解码，界面仍显示原始中文且不丢 token
- 本地 Agent 用量新增 MiniMax Code：tokscale 不读取它的会话存储，改由主进程直接解析；并计入 v2 会话存储建立之前的旧用量（那时记在 sqlite），两代数据按世代时间窗隔离、sqlite 内的重复行折叠，避免重复计数
- 本地 Agent 用量新增 Antigravity：tokscale 只认终端版的数据目录，IDE 版存在 `~/.gemini/antigravity-ide`，此前读数一直为 0；现在直接读它的会话库，每行都用存盘量自检、跨库按响应 id 去重，价格未收录的内部代号也按别名定价
- 套餐计划页新增 Antigravity 官方额度卡：显示 Gemini 与 Claude/GPT 两组的周 / 5 小时剩余额度与重置倒计时。数值是「剩余」而非「已用」，因此进度条按剩余方向配色（充足为绿、低于 30% 转黄、归零转红）

### English
- Provider distribution on the overview is ordered by usage: it was ordered by cost, and providers missing from the pricing catalogue all tied at zero, so the legend read as a shuffled list (the ring's arc length is token-based to begin with)
- The plans page's official subscription quotas now follow auto refresh: all six cards fetched on mount only, so their bars stayed stale while the cycle ran and needed a page change to update
- Fix WeChat iLink sends failing after every restart: session readiness now follows the getupdates poll instead of a getconfig ping (which answers happily against a session the platform has not prepared), and recovery counts a server-held poll as success rather than failure; the "verify connection" button, which could only report the wrong signal, is gone
- Theme switching is now a blurred wipe: beui's theme-toggle (View Transition API) opens the incoming theme as a circle from the top-right that resolves out of an 8px blur instead of cutting over in a single frame, with reduced motion and older engines falling back to an instant switch
- The local scan no longer loses an entire client when a model or provider id contains non-ASCII text: tokscale panics on its byte slice (exit 101, empty stdout) and the client disappeared from the panel; ids are now percent-encoded before the scan and decoded again for display, keeping the original text and every token
- Local agent usage counts MiniMax Code, whose session store tokscale never reads, by parsing it in the main process; usage recorded before the v2 session store existed (kept in sqlite back then) is included too, with the two generations separated by era and duplicate rows collapsed so nothing is counted twice
- Local agent usage counts Antigravity: tokscale only knows the terminal agent's data directory, so an IDE install under `~/.gemini/antigravity-ide` always read zero. Its conversation stores are now read directly, each row verified against the stored output total, generations deduplicated by response id across stores, and internal codenames priced through an alias map
- The plans page gains an Antigravity quota card: the weekly and five-hour allowance remaining for the Gemini and Claude/GPT pools, with reset countdowns. The values are REMAINING rather than used, so the bars are coloured by how much is left (green while comfortable, amber under 30%, red at zero)

## [v0.6.2] - 2026-09-21

### 中文
- 趋势分析页的模型配色改为一张统一的槽位表，并按「这张图实际画了哪些模型」优先分配：此前三处列表各自按自己的顺序取色，同一个模型在筛选标签、曲线图例与对比列表里颜色各不相同，切换「Token / 调用次数」还会让整排柱子重新上色；现在同一张图上的曲线颜色两两不同
- 图表的悬停读数可以用键盘取了：Tab 聚焦图表后用左右方向键逐点查看、Home / End 跳到首尾、Esc 清除，当前数值通过辅助朗读播报，并带上度量单位与完整模型名
- 修复趋势分析页多出一条外层滚动条：辅助朗读区域原本放在图表框架之外，绝对定位让它逃出了主内容区的裁剪，把页面撑高约 294px
- 修复深色模式下滚动条仍是浅色：改为按主题声明 `color-scheme`，滚动条等原生部件跟随主题
- 三处图表细节：气泡不再为没有颜色的行画一个看不见的色块；全零的日期不再只画一条没有气泡可解释的十字线；刻度计算遇到非有限值时回退到可用坐标轴，而不是给出一条空轴
- 清理没有读取方的字段与函数，其中「每客户端活跃时间」在每次扫描时都会计算并写进启动缓存，却从来没有人读它

### English
- Model colours on the trends page now come from one slot table, assigned by the models a chart actually draws: the three lists used to take their colour from their own order, so one model appeared in three colours across the filter chips, the legend and the comparison rows, and switching between tokens and calls recoloured every bar. Curves on a single chart are now always distinct
- The charts' hover readouts are reachable by keyboard: tab to a chart, step through the points with the arrow keys, jump to either end with Home and End, clear with Escape, and the value is announced with its measure and the full model name
- Fix an extra outer scrollbar on the trends page: the announcement region sat outside the chart frame, where its absolute positioning escaped the main area's clipping and stretched the page by about 294px
- Fix the scrollbar staying light in the dark theme: `color-scheme` is now declared per theme, so native chrome follows it
- Three chart details: the bubble no longer draws an invisible swatch on rows that carry no colour, an all-zero day no longer shows a crosshair with no bubble to explain it, and the tick calculation falls back to a usable axis for a non-finite maximum instead of returning an empty one
- Removed fields and functions that nothing read, including a per-client active-time map that every scan computed and wrote to the startup cache with no reader

## [v0.6.1] - 2026-09-21

### 中文
- 智能体配置新增 OpenCode：同时识别两代配置写法（v1 的 `provider` / `npm` / `options` 与 v2 的 `providers` / `package` / `settings`），并把模型的 `variants` 键当作推理档位；本机 v2.0.10 实测仍读 v1 布局，因此按文件已有形态读写而不做迁移
- 已保存模型的 ID 现在可以修改：ID 就是配置里的键，改动按「移动记录」处理 —— 旧键删除、字段原样带到新键、指向它的默认模型指针一并跟随；kimicode 的上游模型名只在恰好等于旧 ID 时跟随，本来就指向别处的保持不动
- 补齐三个 Agent 的凭据形态：除明文密钥外，还识别 `{env:NAME}` 引用与 provider 级 `env: [...]` 候选列表，按顺序取第一个已设置的变量；一个都没设置时明确报出变量名，不再笼统地回一句「没有可用的凭据」
- 新增 Kimi Code 订阅额度卡（套餐计划页）：显示 5 小时 / 每周 / 每月窗口的已用百分比与重置倒计时，凭据不出主进程（PR #2，感谢 @billowliu2）
- Kimi 适配器把两套计费面分开：Moonshot 平台密钥只能查余额、Kimi Code 令牌只能查订阅额度，任一面被拒时给出该面的可操作提示，而不是一律报「密钥无效」（PR #2，感谢 @billowliu2）
- 趋势分析页的图表重做：抽出共享的刻度、标签抽稀、单调样条、柱形几何与图例提示层，曲线改用单调三次插值因此不再低于零点，堆叠柱改用同一色相的三级，模型对比改为排行列表（PR #3，感谢 @billowliu2）

### English
- The agent configuration section gains OpenCode: it reads both config generations (v1 `provider` / `npm` / `options` and v2 `providers` / `package` / `settings`) and treats a model's `variants` keys as its reasoning ladder; the installed v2.0.10 still reads the v1 layout, so the file is written back in whichever shape it already uses rather than migrated
- A saved model's ID can now be changed: the ID is the record's key, so the edit moves it — the old key is removed, every untouched field lands under the new one, and default-model pointers follow it; kimicode's upstream model name follows only when it was exactly the old ID, and stays put otherwise
- All three agents' credential forms are understood: besides a literal key, an `{env:NAME}` reference and a provider-level `env: [...]` candidate list are resolved in order, and an unset variable is now named instead of reported as a generic missing credential
- New Kimi Code subscription quota card on the plans page: the 5-hour / weekly / monthly windows as used percentages with reset countdowns, and the credential never leaves the main process (PR #2, thanks to @billowliu2)
- The Kimi adapter separates the two billing surfaces: a Moonshot platform key only ever yields the balance and a Kimi Code token only the subscription quota, so a rejection on one is reported in that surface's own terms instead of a blanket "invalid key" (PR #2, thanks to @billowliu2)
- The trends page's charts are rebuilt around shared primitives (ticks, label thinning, monotone spline, bar geometry, legend and tooltip); the curves use monotone cubic interpolation and no longer dip below zero, stacked bars step through one hue, and the model comparison becomes a ranked list (PR #3, thanks to @billowliu2)

## [v0.6.0] - 2026-09-21

### 中文
- 智能体管理页新增「Agent 配置」：直接读取并编辑 Kimi Code（`~/.kimi-code/config.toml`）与 MiniMax Code（`~/.minimax/config.yaml`）的 Provider、Base URL、密钥与模型列表，不必再手改配置文件
- 每个模型可单独发起一次最小请求做连通性测试，结果用图标加短标识直接显示（401/403 是密钥、404 是路径、400/422 是请求被拒、超时是网络），不需要悬停面板
- 可从服务商拉取模型列表并批量加入，已存在的模型自动过滤；拉取与测试都会在候选路径与两种鉴权风格之间依次回退，因此声明为 Anthropic 协议、实际却用 Bearer 鉴权的网关也能查通
- 每次写入前自动备份到同目录，写入时比对文件是否被外部改动（不一致就拒绝而不是覆盖），并以临时文件原子替换；删除 Provider 时一并清理指向它的默认模型设置
- 新增 `smol-toml` 与 `yaml` 两个依赖用于解析两种配置格式，写入会保留未改动的内容（TOML 可逐行不变，YAML 需开启单引号选项才能达到同样效果）

### English
- The agents page gains an "Agent configuration" section: read and edit the providers, base URLs, credentials and model lists of Kimi Code (`~/.kimi-code/config.toml`) and MiniMax Code (`~/.minimax/config.yaml`) without hand-editing either file
- Each model can be probed with one minimal live request, and the result appears as a glyph plus a short label (401/403 is the key, 404 the path, 400/422 a rejected body, timeout the network) with no hover panel to open
- A provider's model list can be fetched and added in bulk, with existing models filtered out; both fetching and probing fall back across candidate paths and both credential styles, so a gateway that declares the Anthropic protocol yet authenticates with a bearer token still answers
- Every write is backed up beside the file first, refused when the file changed underneath rather than overwritten, and applied as a temporary file plus an atomic replace; removing a provider also clears the default-model pointers into it
- Adds `smol-toml` and `yaml` for the two config formats; writing preserves what it did not change (TOML line-for-line, YAML once the single-quote option is enabled)

## [v0.5.10] - 2026-09-18

### 中文
- 概览页服务商分布改为按用量排序：原按成本排序，而价格未收录的服务商成本同为 0 而并列，图例看起来像随机排列（环形图的弧长本来就是按 token 画的）
- 修复微信 iLink 机器人重启后发送必失败：会话就绪判定改为依赖 getupdates 轮询（原用 getconfig 探活，而它对着未就绪的会话也会正常应答），recover 也把"被服务端 hold 住"判为成功而非失败；同时移除只会误报的「验证连接」按钮
- 本地扫描不再因模型/供应商名含中文等非 ASCII 字符而丢失整个客户端：tokscale 的字节切片会 panic（exit 101、stdout 为空），现于扫描前把 id 百分号编码、结果回传前解码，界面仍显示原始中文且不丢 token
- 本地 Agent 用量新增 MiniMax Code：tokscale 不读取它的会话存储，现由主进程直接解析 `~/.minimax/v2/sessions` 并计入今日/本月/累计
- MiniMax Code 计入迁移前的历史用量：旧版把用量记在 sqlite，而 v2 会话存储是 2026-08-13 由迁移建立的、此前数据没有会话文件；两代数据按世代时间窗隔离、sqlite 内的重复行按会话+轮次折叠，避免重复计数
- 非 ASCII 兼容层的单文件大小上限由 32MB 提升到 192MB（真实转录最大 42MB，原上限恰好跳过最大的文件）

### English
- Provider distribution on the overview is now ordered by usage: it was ordered by cost, and providers missing from the pricing catalogue all tied at zero, so the legend read as a shuffled list (the ring's arc length is token-based to begin with)
- Fix WeChat iLink sends failing after every restart: session readiness now follows the getupdates poll instead of a getconfig ping (which answers happily against a session the platform has not prepared), and recovery counts a server-held poll as success rather than failure; the "verify connection" button, which could only report the wrong signal, is gone
- The local scan no longer loses an entire client when a model or provider id contains non-ASCII text: tokscale panics on its byte slice (exit 101, empty stdout), so ids are percent-encoded before the scan and decoded again for display — the UI keeps the original text and no token is lost
- Local agent usage now counts MiniMax Code, whose session store tokscale does not read, by parsing `~/.minimax/v2/sessions` directly in the main process
- MiniMax Code usage recorded before the v2 session store existed is included: older builds kept it in sqlite, and the session store was created by a migration on 2026-08-13, so nothing earlier has session files. The two generations are separated by era and duplicate rows inside sqlite are collapsed, so no usage is counted twice
- The non-ASCII compatibility layer's per-file size cap rises from 32 MB to 192 MB (the largest real transcript is 42 MB, which the old cap skipped)

## [v0.5.9] - 2026-09-14

### 中文
- 修复 MiniMax 套餐到期时间不显示：套餐接口实际把订阅块放在顶层返回，适配器却一直在 `data` 包裹层下查找，永远读空且静默失败；现两种结构都兼容，并优先使用更可靠的数字时间戳字段。v0.5.8 日志中超前的那句在此真正兑现

### English
- Fix MiniMax plan expiry never showing: the plan API returns the subscription block at the top level, but the adapter kept looking under a `data` envelope that does not exist — always empty, always silent; both shapes are accepted now, preferring the more reliable numeric timestamp field. This finally delivers what the v0.5.8 notes prematurely promised

## [v0.5.8] - 2026-09-14

### 中文
- Command Code GOAT 套餐卡片新增「套餐到期」行（绝对日期 + 剩余天数，临期变色）：补调了一直只写在注释里的第三个接口 `/alpha/billing/subscriptions`，取当前计费周期的结束时间；仅有效订阅显示，接口无权限或订阅非有效时静默隐藏，不影响卡片其余内容
- 顺带点亮 MiniMax 套餐的到期时间：它的过期接口与格式化函数早就写好，但一直没有渲染链路，本次一并接上

### English
- Command Code GOAT plan cards gain a "Plan expires" line (absolute date + days left, urgency-toned): the adapter now calls the third endpoint it always named but never queried, `/alpha/billing/subscriptions`, reading the current billing period's end; shown for active subscriptions only, silently hidden without billing-scope access or on inactive subscriptions, never affecting the rest of the card
- MiniMax plan expiry lights up as a side effect: its expiry fetch and formatter existed but had no render path until now

## [v0.5.7] - 2026-09-14

### 中文
- 概览页账户余额卡片的多服务商悬停明细改为锚定在金额正下方的气泡（原 Popover 落在卡片下方、离金额太远），并补充每家的充值/赠送拆分、累计花费与请求数；动效使用 beui 官方 Tooltip，与全站一致
- 套餐计划卡片同时显示余额与额度窗口（此前只显示额度窗口）
- 修复品牌图标悬停弹出系统原生提示框（无法自定义的黑框）：@lobehub/icons 在每个图标内嵌了 SVG `<title>`，Chromium 会把它渲染成原生提示；现已在全部品牌图标（余额卡片、明细气泡内小图标、本地 Agent 用量行、四张订阅额度卡）中剥离该元素，可访问名称继续由外层 aria-label / aria-hidden 承担
- 修复金额明细气泡在浅色主题下与页面底色同为浅灰而糊在一起：改用卡片底色，与 Popover、Drawer 等浮层的选色一致

### English
- The overview balance card's multi-provider hover panel is now a tooltip anchored right under the figure (the old popover opened below the card, far from the number) and lists each provider's top-up/grant split plus lifetime cost and request count; it uses beui's own Tooltip so the motion matches the rest of the app
- Plan cards show the balance alongside the quota windows (previously windows only)
- Fix brand marks popping the OS-styled native tooltip on hover: @lobehub/icons embeds an SVG `<title>` in every mark, which Chromium paints as an unstyleable black box; the element is now stripped from every brand mark (balance card, the breakdown panel's mini logos, local agent usage rows, the four subscription quota cards) while the wrappers keep carrying the accessible name (aria-label / aria-hidden)
- Fix the balance breakdown panel blending into the page in the light theme (both were light grey): it now uses the card surface, the same choice as the other floating layers (Popover, Drawer)

## [v0.5.6] - 2026-09-14

### 中文
- 新增两个服务商：Command Code GOAT（API key 认证：额度余额 + 5h/周窗口 + 累计花费/请求数）、Ollama Cloud（API key 认证：5h/周窗口，重置时间按官方固定周期本地推算）
- 硅基流动新增国际站区域（api.siliconflow.com），并修正国际站域名标签（原误写为 siliconflow.ai，实为跳转域名）
- 添加服务商下拉菜单、服务商管理页与账户管理页统一按名称字母排序（原为注册顺序，新服务商总是排在末尾）
- 修复概览页账户余额卡片高度与其他 KPI 卡片不齐（多服务商悬停明细卡片的包装层未撑满高度）

### English
- Add two providers: Command Code GOAT (API-key auth: credit balance + 5h/weekly windows + lifetime cost/requests) and Ollama Cloud (API-key auth: 5h/weekly windows, reset times derived locally from the documented fixed schedule)
- SiliconFlow gains an international region (api.siliconflow.com); its region label is corrected (was siliconflow.ai, a redirect domain)
- The add-provider menu, providers page and accounts page now sort alphabetically by name (was registry order, which pushed new providers to the bottom)
- Fix the overview balance card rendering shorter than its sibling KPI cards (the multi-provider hover card's wrapper did not stretch to full height)

## [v0.5.5] - 2026-09-11

### 中文
- 本地 Agent 用量纳入 WorkBuddy AI 国际版：其转录存于 `~/.workbuddy-ai`，此前完全不参与扫描；现在每次扫描前自动将国际版转录硬链接进被扫描的 `~/.workbuddy`（同 inode：追加写入即时可见、零拷贝），与国内版合并为同一条 WorkBuddy 统计；已存在的真实会话文件绝不触碰，源文件删除时自动清理别名

### English
- Local agent usage now includes the international WorkBuddy AI app: its transcripts live under `~/.workbuddy-ai`, which the scanner never visited; before every scan they are hard-linked into the scanned `~/.workbuddy` (same inode: appends are visible immediately, nothing copied) and merge into the same WorkBuddy totals as the domestic app. Pre-existing real session files are never touched and aliases are pruned when their sources are removed

## [v0.5.4] - 2026-09-10

### 中文
- 修复火山引擎套餐查询始终报「网络请求失败」：异步签名类适配器（火山 Ark）不再被预检逻辑拦截，真实签名请求得以发出；请求域名对齐官方文档（ark.cn-beijing.volcengineapi.com），并适配 GetAFPUsage 文档契约（字符串化数值、毫秒重置时间戳）
- 「获取 Key」「文档」等外链改用系统默认浏览器打开，不再弹出应用内窗口

### English
- Fix Volcengine plan queries always failing with a network error: async-signing adapters (Volcengine Ark) are no longer blocked by the preflight path, so the real signed request goes out; the endpoint now matches the official docs (ark.cn-beijing.volcengineapi.com) and the GetAFPUsage contract (string-ified numbers, millisecond reset timestamps)
- External links such as "Get Key" and "Docs" now open in the system browser instead of an in-app window

## [v0.5.3] - 2026-09-10

### 中文
- 修复 DSH 用量冻结：DSH 新版把会话转录改名为 `session.v3.jsonl.zstd`，而 tokscale 按规范文件名发现会话——改名后的会话全部不可见，用量停在改名当天。现在每次扫描前自动为 v3 转录建立规范名硬链接（同 inode：追加写入即刻可见、零拷贝）；已存在的规范名文件（如迁移前原件）绝不触碰，避免重复计数

### English
- Fix frozen DSH usage: DSH moved its transcripts to `session.v3.jsonl.zstd`, which tokscale's filename-based scanner never matches — every post-rename session was invisible. Scans now alias each v3 transcript to the canonical name with a hard link (same inode: appends are visible immediately, nothing copied); pre-existing canonical files (e.g. pre-migration originals) are never touched, so nothing is double-counted

## [v0.5.2] - 2026-09-10

### 中文
- 修复手动刷新时活跃告警重复弹提醒：进行中或失败的查询不再被当作「条件解除」，仅在拿到成功结果后才更新告警状态；条件真实复发仍会正常提醒一次
- 铃铛角标、铃铛预览与告警中心「未读」筛选不再计入已恢复的历史告警（历史仍只在告警中心置灰展示）
- 本地 Agent 用量接入统一刷新：自动刷新、全部刷新与卡片按钮均会驱动扫描（主进程 5 分钟缓存 + 节流，真实扫描最快约每 5 分 30 秒一次），「手动」档不再后台扫描；「数据截至」改为真实扫描时间，缓存命中不再虚标
- 修复微信 iLink 推送重启后 `prepare failed`（ret -2）：对齐 ZCode 会话模型——应用运行期间主进程常驻 `getupdates` 长轮询保活；冷启动推送前先 `getconfig` 预热；收到 ret -2 自动完整拉一轮 `getupdates` 后重试一次；`get_updates_buf` 游标落盘，断开/退出时停循环

### English
- Fix duplicate alert popups on manual refresh: in-flight or failed queries no longer count as "condition cleared" — alert state changes only on a successful result, and genuinely re-firing conditions still notify once
- The bell badge, bell preview and the alerts-center "unread" filter no longer count resolved history (history stays as dimmed rows in the alerts center only)
- Local agent usage joins the unified refresh: auto-refresh, refresh-all and the card button all drive the scan (main-process 5-min cache + throttle — a real scan at most every ~5m30s), and "Manual" no longer scans in the background; the as-of label now shows the real scan time instead of being re-stamped on cache hits
- Fix WeChat iLink `prepare failed` (ret -2) after restarts: mirror ZCode's session model — a main-process `getupdates` long-poll keep-alive while the app runs; `getconfig` warm-up before the first cold-start send; one full `getupdates` recover + retry on ret -2; persist the `get_updates_buf` cursor; stop the loop on disconnect/quit

## [v0.5.1] - 2026-09-10

### 中文
- 本地 Agent 用量新增小米 MiMo：经 tokscale `micode` 客户端直读会话（模型 `mimo-x-pro-preview`、渠道 Xiaomi MiMo），随扫描管线、标签与图标完整接入

### English
- Local agent usage adds Xiaomi MiMo: sessions read via the tokscale `micode` client (model `mimo-x-pro-preview`, Xiaomi MiMo attribution), wired through the scan pipeline with label and icon

## [v0.5.0] - 2026-09-10

### 中文
- 用量统计新增 Token 活动热力：近 12 个月日历墙，支持每日 / 每周（整墙显示周总量）/ 累计三档，悬停显示精确值
- 趋势折线改顺滑曲线，悬停气泡增加垂直翻转（峰顶不再顶出卡片），数据刷新不清残留气泡
- 统一总量口径：趋势与热力改用 breakdown 加总，与概览总额头一致

### English
- Usage stats gain a Token activity heatmap: trailing-12-month calendar wall with daily / weekly (whole-wall week totals) / cumulative modes and exact-value hovers
- Smoothed trend curves, vertical tooltip flipping at peaks, no stale bubbles across refreshes
- Unified total definitions: trends and heatmap use the breakdown sum like the overview headline

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
