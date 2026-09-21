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
