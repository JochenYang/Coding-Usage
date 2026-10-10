# 死代码清理与趋势分析修正 + 历史累计总耗量

- Status: active
- Plan date: 2026-10-10

## Goal

让趋势分析在稀疏数据下给出正确的时间口径（"近 N 天"是真的 N 个日历日、周分桶是真的周），消除回退数据源下的索引错位；在趋势页补一个「历史累计」区块，直接展示全部模型的累计总耗量与按模型的累计排名；同时删除已用全仓 grep 证实的死代码并消除已证实的重复实现。

## Scope

- Must-have:
  - 趋势页的 range 与周分桶按真实日历日计算，不再把"有记录的天"当作连续天。
  - 回退数据源（本地日归档 / 服务商快照）下，模型曲线、模型筛选后的 KPI 不再与实际 x 轴错位。
  - 新增「历史累计」区块：全部模型累计总耗量 + 按模型累计排名（含占比）。
  - 删除无引用的文件与导出，并同步 `AGENTS.md` 与 `docs/DESIGN_SYSTEM.md`。
- Out of scope:
  - i18n 词典的逐键未使用审计（本轮未做，见「未验证项」）。
  - `electron/*-usage.ts` 的 helper 合并（W7，独立一批）。
  - 7 张配额卡片、两套 Tooltip、两份 AlertRow 的合并（W8，独立一批）。
  - `setLoginItem` 的取舍（W9，待用户决定：接线或移除）。

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | `dailySeries` 是稀疏序列（实测 213 条覆盖 388 个日历日，缺 175 天，最大间隔 49 天）。`sliceRange` 取的是"最后 N 条记录"而非"最后 N 个日历日"，`bucketize` 把 7 条记录当一个周桶。实测 range=全部 时 31 个桶的真实跨度为 3–98 天（均值 12.1 天），"周对比"不成立。需在 `src/lib/trend-analysis.ts` 增加按日历日补零的稠密化（仅对带 `day` 字段的点有效，legacy 归档点无 `day` 需保留旧路径），`sliceRange`/`bucketize` 在稠密序列上运行；x 轴刻度与桶标签随之反映真实日期。注意 `ModelDailySeriesVM` 的三个数组与 `dailySeries` 按索引一一对应，稠密化必须同时补齐每个模型行。**审查中补加两道守卫**：`day` 必须是可往返的合法日历日（`2026-02-30` 会被 `Date.parse` 归一化成 `2026-03-02`，静默丢点并造出幽灵日），以及跨度上限 `MAX_GRID_DAYS`（由 `MAX_BUCKET_COLUMNS × 最粗桶宽` 推出，挡住越界日期引发的上亿行同步分配）。 | [x] |
| W2 | P0 | 回退源错位：`src/pages/TrendsPage.tsx:177` 的 `offset` 用 `agentUsage.dailySeries.length`，而 `windowed` 来自 `filtered ← source`；`source` 在 `TrendsPage.tsx:69-102` 可回退为 `agentDailySeries(90)` 或 `buildTrendPoints(sections)`。当 `dailySeries.length <= 1` 且归档 ≥2 天时 `offset` 被钳到 0，模型数组的**开头**被贴到窗口的**末尾**标签上（`MultiSeriesChart` 对短数组按 0 补齐，呈现为"用量骤降"）。模型筛选路径 `TrendsPage.tsx:106-132` 同样按索引把模型数组映射到 `source`。根因是"有模型数据"与"当前展示的序列"不是同一条。修法：判定 `source` 是否与 `modelDaily` 同源，不同源时禁用模型筛选与按模型视图，并把 `offset`/`buildModelRows` 的参照长度统一为 `source.length`。**实现**：改为 `selectTrendSource` 返回 `kind`/`points`/`models`/`hasModelDetail`，模型 UI 只在 `hasModelDetail` 为真时可用，筛选重算抽为 `filterByModels` 以便单测。 | [x] |
| W3 | P1 | 新增「历史累计」区块（用户本轮的核心诉求）。数据已具备：`agentUsage.allTimeTotal` 是累计聚合，`agentUsage.modelDaily[].tokens` 是全量跨度累计（实测 97 个模型、41,876,157,574 tokens）。**审查中修正了设计**：原以为「按模型无法区分缓存」，但 `summarizeScan` 累加时手上就有 `e.tokens.input`，只是没存进 `ModelDailySeriesVM`——已补上 `input` 字段（含 `densifySeries` 扩展、`groupModelDaily` 合并、`startup-cache` 对旧缓存的归一化），于是 headline 与按模型列**都跟随显示模式**，不再出现「不含缓存时合计反而大于总量」的自相矛盾。另：覆盖天数与区间改取扫描序列（回退源下不再出现「累计非零但天数 0」）；模型筛选对新区块同样生效（筛选时 headline = 所选合计）；表格截前 30 行 + 其余合计行；补 ARIA table 角色；窄屏把隐藏的三列折到模型名下方。 | [x] |
| W4 | P2 | KPI 行与视图切换不一致：`totals` 只依赖 `buckets`，与 `view` 无关；切到「按模型」后图表只画 output 日粒度曲线，KPI 仍是窗口聚合量，且 `chartNote` 在 byModel 下返回空串。**实现**：byModel 下改显示 `splitKpiNote`（“上方指标是所选范围的聚合口径”）；审查指出原文案把 KPI 描述成“含输入与缓存读取”，在「不含缓存」模式下与数字不符，已改为模式无关的表述。 | [x] |
| W5 | P2 | 删除已证实无引用的文件与导出：文件 `src/components/common/StatusDot.tsx`、`src/components/ResetCountdown.tsx`、`src/components/overview/PlanCardsRow.tsx`；导出 `src/lib/ease.ts` 的 8 个（`EASE_DRAWER`/`EASE_OUT_CSS`/6 个 `SPRING_*`）、`src/lib/touch.ts` 的 5 个、`src/lib/agent-config.ts` 的 `MODEL_CAPABILITIES`、`src/lib/agent-usage.ts` 的 `clearDailyUsage`、`src/lib/rates.ts` 的 `isKnownCurrency`、`src/lib/storage.ts` 的 `getEntryConfig`、`src/lib/trend-analysis.ts` 的 `rangeKey`、`src/types.ts` 的 `PushChannelId`、`electron/agent-config-paths.ts` 的 `resolveAllAgentLocations`、`electron/opencode-config.ts` 的 `opencodePackageChoices`（连带其唯一使用者 `DEFAULT_PACKAGE`）；`DayPointVM.models` / `DayModelSlice` / `DAY_MODELS_KEPT` 与 `summarizeScan` 里逐天计算它的那段。**实现**：全部删除后 `tsc` 0 错误（`DEFAULT_PACKAGE` 是连带发现的第二个孤儿）。文档同步：`AGENTS.md`（组件清单、`lib/` 清单、动效段）、`docs/DESIGN_SYSTEM.md`（在线表达、组件表、§7 动效章、§10 修订记录）、`PlansPage.tsx` 两处指向已删组件的注释。**审查发现文档同步不全**：§7 仍写 `ease.ts` 是弹簧权威且引用已删的 `SPRING_MOUSE`、与同文件 §10 自相矛盾；`AGENTS.md` 的 `drawer.tsx:28,30` 行号错（实为 32,34）；在线/离线两句只覆盖了一半（离线单层圆点在 `ProvidersPage.tsx:95`）。均已修正。另删掉 `PlanCardsRow` 遗留的孤儿词典键 `overview.plansTitle`（三处）。 | [x] |
| W6 | P3 | 末桶不完整无标注：`bucketize` 的末桶可能是 2–6 天（实测 range=全部 的末桶 3 天），柱高天然偏低，会被读成用量下滑。**实现**：`TrendBucket` 新增 `partial`（`chunk.length < width`），`StackedBarLineChart` 新增可选 `partialSuffix`，在 tooltip 标题与屏幕阅读器播报里对 partial 桶追加该后缀；`TrendsPage` 在聚合视图且 `totals.tokens > 0` 时于图表下方显示说明。新增 i18n `partialBucketShort` / `partialBucketNote`（三处同步）。真实数据：388 天 → 28 列 × 14 天，末列 `partial=true`。**残留**：日粒度视图（7/14/30 天）的末列是尚未过完的今天，同样偏低，但 `width === 1` 时 `partial` 恒为 false——这需要“当前周期是否完整”的概念（依赖时钟），本轮未做。 | [x] |
| W7 | OPT | 合并 `electron/*-usage.ts` 的重复 helper：`localDay` 5 份字节相同、`buildPayload` 5 份近似、`asRecord` 9 份、`num` 4 份、`str` 4 份、`numFrom` 2 份、`splitVendorModel` 3 份。抽到共享模块。不做要写明理由：属纯内部重构，无用户可见收益，风险集中在 5 个采集器的回归面。 | [–] |
| W8 | OPT | 合并渲染层重复：7 张 `*QuotaCard.tsx` 的同一套桥接拉取状态机（`Promise.race` 12s）抽 `useBridgeQuota`；`common/Tooltip.tsx` 与 `beui/tooltip.tsx` 二选一；`AlertsPanel`/`AlertsPage` 的 `LEVEL_CHIP`+`AlertRow` 抽共享；`CostAnalysisPage.makeCostText` 与 `UsageStatsPage.costText` 下沉到 `src/lib/format.ts`。不做理由同上。 | [–] |
| W9 | P3 | `setLoginItem` 全链路已接（`electron/preload.ts` + `electron/main.ts` + `src/globals.d.ts`）但渲染层 0 调用。**用户裁定：整条移除**。理由：全仓没有 `app.getLoginItemSettings()`，只暴露了“写”，接线后的开关无法反映用户在系统里的改动（会撒谎）；做对 = 新增 IPC + getter + 设置页 + 两套文案，是功能而非清理。已删三处，并同步 `AGENTS.md` 的 IPC 清单。 | [x] |
| W10 | P2 | **删除 `clearDailyUsage` 暴露的既有缺陷**：设置页的「清除趋势快照」只调 `clearSnapshots()`（删 `coding-usage.snapshots.v1`），而 90 天日归档的键 `coding-usage.agentUsage.daily` 在删掉 `clearDailyUsage` 后全仓再没有任何代码会移除它。**用户裁定：改文案，不接线**。理由：趋势页主数据源是扫描结果，清掉归档并不能让趋势页归零；而反向“把行为加宽到匹配文案”就必须连导出一起加宽，否则会产生“能删、但备份里没有”的不可逆动作。已把按钮/确认框/导出/导入四处文案改为“账户配额快照”，并在确认语里说明本地 Agent 用量与趋势数据不受影响。 | [x] |
| W11 | P1 | **趋势页「模型输出速度」的分母不是时长**（用户报告“感觉不准”）。实测：`activeTimeMs` 是**会话跨度之和**而非耗时；211 天里 **30 天超过 24 小时**，最坏的一天 2471 h 却只有 6 次调用（全部来自 opencode，tokscale 自带读取器；我们自己的读取器一律写 0）。这些天占分母的 **97%**，把 KPI 从 ~35 tok/s 拉到 **1.06**。修法：日历日不可能容纳超过一天的时间，超过 24 h 的日子的时钟不是时长，其时间与**与它配对的输出**一起不进入速率（分母、分子同源，否则会变成“别人的输出 ÷ 这些天的时间”而虚高）。真实数据：**1.06 → 34.62 tok/s**，可用时钟 34,086 h → 973 h；继续收紧到 ≤8h/≤3h 时分别为 31.1 / 29.0，说明剩下的时钟确实是时间。已同步 `speedHint` 文案与 `TrendBucket.measuredOutput`。 | [x] |
类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选（不做要写明理由）。

状态流转（就地更新，不得跳级）：
- `[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过
- `[?]` 审查不通过，已回退或待重做；`[–]` 本轮不做（写明理由）；`[!]` 待用户决定

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1, W2 | 时间口径与索引对应的用例全 PASS；`npx tsc --noEmit` 0 错误 | [x] |
| 2 | W3, W4 | 累计区块在稀疏/回退/空数据三种输入下渲染正确；两套词典键一致 | [x] |
| 3 | W5, W6 | 删除后 `npx tsc --noEmit` 与 `npm run build:web` 均通过；文档已同步 | [x] |
| 4 | W7, W8, W9, W10, W11 | W9/W10/W11 已由用户裁定并完成；W7/W8 仍未做 | [x] |

阶段闸门：任何条目处于 `[~]` 或 `[?]` 时不得开始下一阶段。Gate 通过 = 该阶段条目的验证项全 PASS 且 review 无阻塞发现；条目从 `[~]` 转 `[x]` 前必须回答四问——主张复核、最小性、新风险、反例。

## Affected behaviors

- 趋势页时间口径：`src/lib/trend-analysis.ts` 的 `sliceRange`/`bucketize`/`computeTotals`，影响 KPI 行、堆叠柱状图、对比表、分模型曲线四处的窗口含义。
- 分模型视图与模型筛选：`src/pages/TrendsPage.tsx:106-186`、`buildModelRows` 的活跃时间摊派（`trend-analysis.ts:209-238`）。
- 回退数据源：`agentDailySeries`（`src/lib/agent-usage.ts:665` 的 90 天归档）与 `buildTrendPoints`（`src/lib/overview.ts`）进入趋势页的路径会因 W2 改变可见性——回退态下模型筛选将不可用。
- 累计区块新增读取 `agentUsage.modelDaily`，与 UsageStatsPage 的 `todayByModel`、OverviewPage 的 `totalQuotaTokens`（`src/pages/OverviewPage.tsx:69`，标签为「总额度（Tokens）」）口径需保持一致：三处都是同一份扫描数据的不同切片。
- 删除死代码会影响 `AGENTS.md` 与 `docs/DESIGN_SYSTEM.md` 的组件清单；`ease.ts` 的 `SPRING_*` 删除会暴露"动效权威"的文档漂移（文档称以 `ease.ts` 为准，实际组件各自本地定义弹簧）。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 稀疏序列下的 range 语义 | 构造 `dailySeries`：213 条覆盖 388 个日历日（含 49 天空档），选「近 30 天」 | 窗口 = 最近 30 个日历日；空档日以 0 计入，而非取最近 30 条记录 | `npm test` + `.tmp/realdata.verify.ts` | PASS |
| 2 (W1) | 周桶真实跨度 | 同上，选「全部」 | 每个桶的真实跨度固定（末桶可短），不再是 3–98 天 | `npm test` + 真实扫描数据 | PASS（`partial` 标记属 W6，未做） |
| 3 (W2) | 回退源不再错位 | `dailySeries.length = 1` + 本地归档 90 天 | 模型筛选与按模型视图不可用，分模型曲线不再把首日数据贴到末段标签上 | 单元测试 + 趋势页手工核对 | PASS（单测）；界面表现未复现 |
| 4 (W2) | 正常源不受影响 | 稠密序列 + 模型筛选 B 模型 | 筛选后合计 = 该模型窗口内合计，与手工求和一致 | `npm test` | PASS |
| 5 (W3) | 累计区块数值 | 真实扫描（本机 213 条记录） | 累计总耗量 = 41,876,157,574；按模型排名合计 = 该总值；占比之和 = 100%；不含缓存模式 headline 与按模型合计相等（7,569,631,974） | `.tmp/realdata.verify.ts` | PASS |
| 6 (W3) | 累计区块空/回退态 | `modelDaily = []` | 渲染 gathering 文案，不出现空表或 NaN | 手工（清 localStorage 缓存） | pending |
| 7 (W4) | 视图切换口径 | 在 byModel 与 aggregate 间切换 | KPI 行标注口径，不把聚合量当作按模型合计 | 界面核对 | pending |
| 8 (W5) | 删除后仍可编译与构建 | 删除全部条目后 | `npx tsc --noEmit` 退出码 0；`npm run build:web` 与 `npm run build` 成功 | 命令 | PASS |
| 9 (W5) | 删除不破坏运行时 | 打开 11 个页面与设置抽屉 | 无白屏、无运行时报错 | 手工 + Playwright 截图 | 未做（见未验证项） |
| 10 | 类型与构建基线 | 未改动代码 | `npx tsc --noEmit` 退出码 0 | 命令 | PASS |

（用例对应 Work item 时在编号列注明，如 `1 (W1)`。）

## Verification commands

- `npx tsc --noEmit` — 类型检查，当前基线为退出码 0（已实测）。
- `npm run build:web` — 浏览器路径构建，确认渲染层无回归。
- `npm run build` — electron-vite 构建，改动触及 `electron/` 时必跑。
- 界面核对：趋势页 5 个范围档 × 2 个视图 × 筛选开/关 × 明暗主题 × 375px 窄屏。

## Rollback

- 代码改动按 Work item 粒度提交，回滚 = 用编辑工具把文件改回先前的状态（或 revert 对应提交）。
- W1 若改为在 `summarizeScan` 内稠密化，会改变持久化缓存的形状：回滚时必须同时清 `coding-usage.agent-usage.v1` 缓存，否则旧形状的缓存与新读取逻辑不匹配。
- W3 只读现有数据、不写存储，回滚无数据风险。
- W5 的删除不涉及存储与迁移，回滚即恢复文件。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| — | 2026-10-10 | 审计阶段：`npx tsc --noEmit` 退出码 0；`tokscale graph` 实扫 213 条记录；死代码逐个 grep 复核 | 计划落盘，未动代码 |
| 1 | 2026-10-10 | `npm test` 26 passed；`npx tsc --noEmit` 退出码 0；`npm run build:web` 成功；真实扫描（213 行/388 天）经 `.tmp/realdata.verify.ts` 8 项全过 | W1/W2 完成。自审发现并修复 4 项：快照回退被提前求值（localStorage 读回退到每次刷新）、归档点缺 `day` 致回退态无法稠密化、模型行长度用 `>=` 会静默丢弃行尾、筛选重算内联在组件里不可测（已抽为 `filterByModels`）。四问结论：主张已复核（真实数据端到端）；最小性——未引入新依赖以外的抽象，`densifySeries`/`selectTrendSource` 各只服务一处；新风险——`bucketize` 桶宽改为自适应，已同步 `weeklyNote` 文案与触发条件；反例——旧行为在 213 行非稠密输入下为 31 列，新规则下为 16 列，仅在稠密化失败（缺 `day` 或乱序）时出现，已由测试锁定。 |
| 1 | 2026-10-10 | 独立审查（另派子智能体）结论：必须修 P1（稠密化无跨度上限，`9999-12-31` 会同步分配 8.47 亿次 push）；另报 A1 越界日期被归一化后静默丢点、A2 命中率从「—」回归成 0.0%、B5 声明类型未跟上 `day`、两条测试是同义反复。全部已修。复审后 `npm test` 29 passed、`tsc` 0、真实数据 8 项全过、`build:web` 成功。变异检查：删掉日历校验后「calendar-invalid day」用例立刻失败（复现 `2026-02-30` → `2026-03-01` 幽灵日），证明该测试承重。审查者提出的 `vitest.config.ts` 用 `__dirname` 一项已驳回（`package.json` 有 `"type": "module"`，且 `vite.config.ts` 同款用法工作正常）。 |
| 2 | 2026-10-10 | `npm test` 36 passed；`tsc` 0；真实数据 11 项全过（含「不含缓存 headline = 按模型合计 = 7,569,631,974」）；`build:web` 成功 | W3/W4 完成。独立审查报 1 个阻塞项（B1：口径说明在「不含缓存」模式下与数字相反，且其依据的「数据不存在」是错的）与 4 个应修项（单日扫描自相矛盾、筛选不生效、div 表格无 ARIA、375px 丢三列），已全部处理；B1 的修法是把每模型 `input` 真的存下来，而不是改文案绕过。四问结论：主张已复核（真实数据端到端）；最小性——只加了一个 `input` 数组，未动缓存键版本（改用读取处归一化，与仓库既有做法一致）；新风险——旧缓存缺少 `input` 时用 `total - output` 兜底，仅影响升级后首屏一次；反例——若某天 `totals.tokens` 为 0 而拆分非 0，旧写法会漏计该天，已加测试锁定。 |
| 3 | 2026-10-10 | `tsc` 0；`npm test` 38 passed；`npm run build`（electron-vite，主进程+preload+渲染层）与 `npm run build:web` 均成功；真实数据 11 项全过（含「388 天 → 28 列 × 14 天，末列 partial=true」） | W5/W6 完成。独立审查结论：无阻塞项，但报 4 处**文档同步不全**（`DESIGN_SYSTEM.md` §7 仍写 `ease.ts` 是弹簧权威且引用已删的 `SPRING_MOUSE`、与同文件 §10 自相矛盾；`AGENTS.md` 的 `drawer.tsx:28,30` 行号错，实为 32,34；在线/离线两句只覆盖一半；`types.ts` 的注释挂错键）与 2 项建议（`PlanCardsRow` 遗留的孤儿词典键、`clearDailyUsage` 删除暴露的日归档无法清理）。前 4 项与孤儿键已修，第 5 项记为 W10。四问结论：主张已复核（两套构建 + 真实数据）；最小性——删除零引用代码，未动任何存活路径，唯一新增是 `TrendBucket.partial` 与一个可选 prop；新风险——`TrendBucket` 新增必填字段，但全仓只有一个构造点，`tsc` 已穷尽校验；反例——`width === 1` 时 `partial` 恒 false，日粒度视图的末列仍未标注，已记入 W6 与未验证项。 |
| 4 | 2026-10-10 | `tsc` 0；`npm test` 41 passed；`npm run build` 与 `npm run build:web` 均成功；真实数据 18 项全过 | W9（移除 `setLoginItem`）、W10（「清除趋势快照」文案改为“账户配额快照”，四处同步）、W11（输出速度分母修复）完成。W11 的证据：KPI 走生产路径从 **1.06 → 34.62 tok/s**，可用时钟 34,086 h → 973 h；根因定位到 tokscale 自带 opencode 读取器把会话跨度当成单日耗时（211 天里 30 天 >24h）。四问结论：主张已复核（真实数据 + 41 条单测）；最小性——只加了一个 `measuredOutput` 字段与一个 `measurableActiveMs` 守卫，未改任何 UI 结构；新风险——`TrendBucket` 新增必填字段，全仓唯一构造点已同步；反例——若未来 tokscale 修好该字段，本守卫不会误伤（正常日耗时远小于 24 h），但日粒度视图仍无速度可用（`width === 1` 时每列一天，守卫不影响）。 |

## 未验证项（审计残留）

- i18n 两个词典（各约 600 键）未做逐键未使用审计；动态访问只确认了 `PlansPage.tsx:53` 的 `t.providers[...]` 一处。
- W2 的错位是代码推演 + 索引对应的演算结论，未在运行中的应用里复现界面表现。
- W0 已决策：仓库现有 Vitest 与 `npm test`；`src/lib/trend-analysis.test.ts` 共 38 条覆盖稀疏序列、日历边界、回退源判别、筛选重算、累计区块与末桶标记，真实扫描数据的端到端核对在 `.tmp/realdata.verify.ts`（已 gitignore，不随仓库提交）。
- W3 新增的 UI（区块布局、ARIA table、窄屏折叠、截断行）与 W6 的图表说明未做界面截图核对，只有类型检查、构建与真实数据证据。
- 计划 Test plan 第 9 项（删除后打开 11 个页面确认无白屏）**未执行**：没有启动应用，删除的安全性由 `tsc` + 两套构建 + 全仓 grep 支撑，不是运行时证据。
- W6 的日粒度残留（7/14/30 天视图的末列是未过完的今天，`partial` 恒 false）未处理，见 W6。
- 工作树里 W1–W6 的改动未按 Work item 拆分为独立提交（未经提交授权），因此 Rollback 一节里“按条目粒度回滚”目前只能靠文件级恢复。
- `docs/DESIGN_SYSTEM.md` 与 `AGENTS.md` 关于弹簧的描述本轮已改为“就近声明”，与代码一致；`ease.ts` 现在只剩两条缓动曲线。原记录的面板弹簧数值差异（文档 420/40/0.5 vs 组件 220/26/0.9）随 `SPRING_PANEL` 一并消失。

## W0 已决策：测试载体

已引入 Vitest（devDependency，`npm test` = `vitest run`），配置在 `vitest.config.ts`（node 环境，`src/**/*.test.ts`）。W1/W2 的回归测试在 `src/lib/trend-analysis.test.ts`；真实扫描数据的端到端核对脚本放在 `.tmp/`（已 gitignore），不随仓库提交。

用户已裁定：ease.ts 删未使用常量并把文档改为描述现状（归 W5）；`setLoginItem` 本轮不动（W9 保持 `[!]`）。
