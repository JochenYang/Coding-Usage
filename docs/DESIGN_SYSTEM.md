# Coding Usage — Design System 规范（DS）

> 独立样式开发遵循文档。Source of truth 永远是源码：`src/index.css`（Token）
> 与 `src/components/**`（组件实现）。本文档是其可读映射，发现与源码不一致时以源码为准，
> 并回更新本文档。
> 定位：为个人开发者在桌面端长时间监控多家 AI 供应商用量时，提供冷静、高密度、可信的数据仪表盘。

## 0. Discovery Notes（系统现状快照）

- 系统现状：**有成体系系统**。Tailwind v4 `@theme` 语义 Token 被全站消费（`bg-card` / `text-muted-foreground`
  等），`.dark` 类切换主题，共享组件集中在 `common/`、`beui/`、`charts/`、`layout/`。
- Source of Truth：`src/index.css:6-65`（全部颜色 Token + 明暗两套映射）；动效唯一权威 `src/lib/ease.ts`。
- 缺口：图表分类色板（`lib/overview.ts:192`）非主题感知（SVG `stroke` 属性无法消费 CSS 变量，
  已收敛为单源常量 + 文档化为例外，见 §10）。
- 冲突记录：已解决。动效曾分裂为 `motion-presets.ts` / `ease.ts` / `drawer.tsx` 三套；
  现已合并至 `ease.ts`（`motion-presets.ts` 删除，6 处引用改道；`EASE_OUT` 两处值原本相同，
  零运行时变化），`AGENTS.md` 动效段已同步修订。

## 1. 视觉方向（反向沉淀：从既有系统提炼）

- 定位一句话：为个人开发者在桌面端专注场景下提供多供应商用量监控，气质上要冷静、精确、可信。
- 方向关键词：冷静（低饱和冷灰底 + 单一 indigo 强调色）／精确（等宽数字、高密度数据卡）／克制
  （无装饰插画、无营销动效；阴影只用于浮层分层）。
- Design Principles：
  1. 层级靠字重与留白，不靠颜色——单视图内彩色强调不超过两处（主强调 + 状态色）；因此标题不加彩色底块。
  2. 状态色只表达状态——`accent` 表品牌/主操作，`success/warning/danger` 表状态语义；因此破坏性操作不用品牌主色。
  3. 密度优先于装饰——数据页用高密卡片（`p-5` 起），空位用信息补足而不用装饰元素填充。
  4. 动效只用于转场反馈，不得承载信息——关键状态变化必须有静态视觉（颜色 + 文案/图标）兜底；
     因此 `prefers-reduced-motion` 下一切动效降级为透明度脉冲或静止（各组件已实现，见 §7）。

## 2. Token 规范

命名沿用项目既有小写 kebab（Tailwind `@theme` 原生形态：`--color-*`），不另起第二套。
引用方向只允许 Primitive → Semantic → Component/页面；**页面禁止直引 Primitive**（本项目 Primitive
即 `@theme` 原始值，页面只消费语义类名）。

### 2.1 Semantic Token 全表（`src/index.css`）

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `background` | `#eef0f5` | `#0b0b12` | 页面底色（全站唯一，不逐页换色） |
| `foreground` | `#16161f` | `#f4f4f8` | 正文 |
| `card` | `#ffffff` | `#15151f` | 卡片/浮层底 |
| `muted` | `#e7e8ef` | `#1c1c29` | 次级底（进度条轨道、徽章底、选中行） |
| `muted-foreground` | `#6b6b80` | `#9ca3af` | 辅助说明文字 |
| `subtle` | `#a3a3b8` | `#5c5c72` | 占位/刻度/次弱信息 |
| `border` / `border-strong` | `#dcdce8` / `#c9c9da` | `#232336` / `#32324a` | 分隔线 / 需明确边界的控件 |
| `ring` | `#6366f1` | （同左，不参与主题） | 焦点环 |
| `primary` / `primary-foreground` | `#16161f` / `#f6f6f9` | `#f4f4f8` / `#0b0b12` | 主按钮（随主题反转） |
| `popover` / `popover-foreground` | `#ffffff` / `#16161f` | `#171724` / `#f4f4f8` | 浮层 |
| `accent` / `accent-strong` / `accent-soft` | `#6366f1` / `#4f52e0` / `#eef0fe` | 同左 / 同左 / `rgba(99,102,241,.16)` | 品牌强调/悬停/柔底（主题恒定 indigo，暗色只调柔底透明度） |
| `success` / `online` | `#22c55e` | 同左 | 成功 / 在线（同值不同语义） |
| `warning` | `#f59e0b` | 同左 | 预警 |
| `danger` / `destructive` | `#ef4444` | 同左 | 危险/错误；`destructive-foreground`恒 `#ffffff` |
| `offline` | `#a3a3b8` | `#4b4b63` | 离线/静默 |

### 2.2 新增 Token 判定（满足任一才新增）

1. 真实复用 ≥2 处（“以后可能用”不算）；2. 表达新语义（如新增 warning 级别）；
3. 需随主题/品牌变化且挂不上现有 token。一次性场景保持局部值。

### 2.3 主题切换策略

- 机制：`<html class="dark">` 重定义同名变量（`src/index.css:50-65`，Tailwind `dark:` 按 class 策略，
  见 `:4`）。切换只发生在 Semantic 层，组件零改动。
- 暗色不止反色：`accent-soft` 改用透明度表达（阴影在暗底失效）；`offline` 在暗底加深保证可见。
- 例外（恒定值，注明不参与主题）：`accent` / `success` / `warning` / `danger` 两套主题同值；
  图表分类色板（`DIST_COLORS`，见 §4.3）暂不同值。

## 3. 色彩语义

- 主操作链：`bg-accent` → 悬停 `bg-accent-strong`；柔底图标槽 `bg-accent-soft` + `text-accent`
  （`StatCard` 标准形态）。
- 用量水位梯（`ProgressBar:15-19`，全站统一阈值）：`<70` 用 `accent`，`70–99` 用 `warning`，
  `≥100` 用 `danger`。阈值变更只改这一处。
- 状态徽章（`Badge` 四档，底色一律 `/10` 透明度 + 同色文字）：`success→online` / `warning` /
  `danger` / `neutral→muted底 + muted-foreground字`。
- 在线表达：`online` 双层圆点（halo + core，`StatusDot`）；离线 `offline` 单层无 halo——“静默就该看起来静默”。
- 灰度测试：错误/成功/选中除颜色外必须有图标或文字佐证（表单错误 = 红字 + 文案，不只变红）。

## 4. Typography / Spacing / Radius / Elevation / Icon

- 字体：系统栈（`-apple-system…PingFang SC…Microsoft YaHei`，`index.css:42-44`）；数字与代码用等宽
  （`tabular-nums` / `font-mono`，图表 tooltip、加载器、金额一律 tabular）。
- 字阶（只用这几档，不发明新字号）：`11px` 徽章/微标签 · `xs` 辅助/卡片标题 · `sm` 正文/控件 ·
  `base font-semibold` 空态标题 · `lg font-semibold` 页标题（`PageHeader`）· `28px semibold` 指标值
  （`StatCard`）。字重 ≤3 档（regular / medium / semibold）。
- 正文行高 1.4–1.6（`leading-tight` 仅用于大数字）；截断策略：单行 `truncate`，长标签配 `max-w-*` + 全文入口。
- Spacing：一切内外边距取自 Tailwind 默认 scale；卡片 `p-5`、section 间距 `space-y-5`、
  元素间距 `gap-2/3` 为基准档。页面边距 `px-4 sm:px-6`、纵向 `py-6`（`AppShell`）。
- Radius 语言：`rounded-2xl` 数据卡片/section · `rounded-xl` 输入/Select 触发器/浮层面 ·
  `rounded-lg` 按钮/图标槽/选项 · `rounded-md` 微标签/ProviderLogo ·
  `rounded-full` 徽章/进度条/胶囊/Switch。同语义同档，不混用。
- Elevation：页面与卡片**无阴影**（靠 `border-border` + 底色差分层）；阴影只给浮层三档：
  tooltip `shadow-md`、Select/Popover 面板 `shadow-lg`、Drawer 定制大阴影（浅色 `0 30px 60px -15px rgba(0,0,0,.25)`，
  暗色 `.6`）。不新增一次性自定义阴影。
- Icon：线性图标统一 `lucide-react`（卡片图标 `h-4 w-4` 配 `h-8 w-8 rounded-lg` 柔底槽）；
  供应商品牌用 lobehub CDN slug（白底白 logo 配 `logoDarkInvert`，见 `types.ts:57`），缺失时字母兜底；
  SiliconFlow 类例外用内联 SVG。描边/尺寸同页一致，不混两套风格。

## 5. 布局与页面组合

- 壳：`AppShell` = 左固定 Sidebar + 右 TopBar + 内容列（`max-w-[1280px]` 居中）。
  背景全站唯一 `bg-background`；页面只写布局（栅格/间距/排列），不写视觉。
- Header 模式：`PageHeader`（`text-lg` 标题 + `sm` 描述 + 右侧 actions 槽）；全页 primary ≤1 个，
  次要操作降档 `secondary/ghost`。
- 本项目的 archetype 映射：Overview/Trends/CostAnalysis = Dashboard（指标卡 → 主图表 → 明细）；
  Providers/Accounts/Agents = List（统一条目高度，操作位固定）；Settings/Alerts = Settings
  （分类 section + 分组表单，危险操作独立分区 + 二次确认）；空数据页 = Empty State（见下）。
- Section 节奏：卡片/section 间距全站 `space-y-5`（或 `gap-4/5` 网格）；Section 间距 > Section 内元素间距。
- 状态必须件：Loading 用 `Loader`（按钮内/局部）或骨架占位（整区），不整页 spinner；
  Empty 用共享 `EmptyState`（图标槽 `h-14 w-14 rounded-2xl` + 标题 + 描述 + 一个主行动）；
  Error 用户语言 + 可恢复操作（重试保留输入），局部错误局部提示。

## 6. 组件规格（共享组件十节精简版）

新共享组件准入三问：复用 ≥2 处？现有组合表达不了？语义不重叠？全过才新建；同语义只允许一个实现。

| 组件 | Variants / Sizes | States（●必需） | 关键规则 |
|---|---|---|---|
| StatCard | 图标槽或 `iconSlot`（品牌 logo） | Default · Loading（上层骨架） · Empty（`—` 占位，图表同理） | 标题 `xs muted`、值 `28px semibold tabular`、footer `xs`；容器 `rounded-2xl border bg-card p-5` |
| Badge | `success/warning/danger/neutral` | Default（静态展示） | `rounded-full px-2 py-0.5 11px medium`；文案由调用方传入（i18n 在外） |
| ProgressBar | `sm(h-1.5)/md(h-2)` | Default · Empty（零值只留轨道） | 水位梯见 §3；`role=progressbar` + `aria-valuenow`；值钳制 0–100 |
| StatusDot | — | 在线（halo ping）/离线（静默点） | 在线 halo `animate-ping`，reduced-motion 下退为静态辉光 |
| EmptyState | — | Empty-首次/无结果/权限不足（三类文案区分） | 不用 Error 视觉渲染正常空态；action 槽调用方决定按钮/链接 |
| PageHeader | — | Default | 左标题右 actions；`actions` 内 `gap-2` |
| Drawer | `left/right` | Open · Closed · Esc 关闭 · body 滚动锁定 | 面板 `max-w-[min(560px,50vw)] sm:min-w-[440px]`，`bg-card`；backdrop `bg-black/40 + backdrop-blur-sm` |
| Switch | — | Default · Disabled（果冻抖动提示） · Pressed（挤压） | 轨道 `bg-accent` 开 / `bg-muted` 关，拇指纯白（跨主题恒定，显式例外）；焦点环 `ring-ring` |
| Loader | 17 种 `variant`（默认 `spinner`） | Loading · reduced-motion（透明度脉冲/放慢字形切换） | `role=status` + `sr-only` 标签；`size/speed` 受控；终端风 ascii 系列仅用于 agent 语境 |
| Select | Trigger/Content/Item 组合 | Default · Hover · Focus-visible · Open（果冻圆角 morph）· Disabled · Selected（√标记） | 面板绝对定位于 field 内；多 Select 叠放时由布局层控单开；`inert` 关闭态 |
| Popover | `click/hover` · `top/bottom` · 对齐三档 | Default · Open（gooey 形变）· Esc/外部关闭（焦点回触发器） | 面板 `max-w-[min(92vw,20rem)] p-4`；hover 模式 120ms 关闭延迟；触屏上 tap 同样可开 |
| ConfirmDialog | — | Default · Focus（危险确认） | 危险操作二次确认；按钮层级按主/次排布 |
| LineChart / DonutChart | 自研 SVG（无图表库依赖） | Default · Hover（十字线 + HTML tooltip）· Empty（`<2` 点显示 `—`） | 网格 `border` 虚线、刻度 `subtle 10px`、线/面 `accent`；tooltip 固定字号 HTML 渲染；x 标签 thinning ≤7 |
| ProviderLogo | lobehub slug / 内联 SVG / 字母兜底 | Default · 加载失败（字母兜底） | `rounded-md` 槽；`logoDarkInvert` 处理白底白 logo |
| 表单输入（各页内联） | — | Default · Focus-visible | 边框 `border`，聚焦 `focus:border-accent`；数字类配 `font-mono tabular-nums`；placeholder 用 `subtle` |
| AppShell/Sidebar/TopBar | 桌面壳（导航 + 视图路由 hash） | Active（当前项高亮）· Default | 导航是全站共享组件，页面不自造第二套 |

Accessibility 五条（组件评审 + 实现后各走查一次）：焦点可见（对比 ≥3:1，不被 overflow 裁切）；
纯键盘走完核心任务且顺序正确；语义角色与名称正确（纯图标必有可访问名）；状态变化可被感知
（属性/播报，不只靠颜色）；色彩不作唯一载体。触控热区 ≥44px 量级（含透明区）。

## 7. Motion 语言

- 唯一权威：`src/lib/ease.ts`（`EASE_*` / `SPRING_*`）。组件只从 `@/lib/ease` 引用，
  不得定义局部动效常量（Drawer 进出场弹簧是唯一的局部例外，见下）。
- 曲线：`EASE_OUT [0.16,1,0.3,1]`（进入/面板类），`EASE_IN_OUT [0.45,0,0.55,1]`（Loader 节奏）。
- 弹簧：Drawer 进入 `220/26/0.9`（延迟 80ms，backdrop 先 250ms 淡入）、退出 `260/30`；
  按钮按压短促弹簧；装饰性跟随（magnetic/tilt）用低刚度 `SPRING_MOUSE` 系。
- 铁律：所有动效读 `useReducedMotion()`，降级为透明度脉冲或静止；骨架屏与 spinner 不在同一区块混用；
  状态切换预留空间防布局跳动。

## 8. 品牌点缀（Provider accent）

供应商卡片允许的**唯一例外**：`ProviderDef.accent` 存 Tailwind 渐变片段
（如 `from-cyan-500 to-blue-600`）作品牌残留。仅用于品牌识别位，不许扩散为功能色；
功能语义（水位/状态/操作）一律走 §2–§3 token。

## 9. 文案与 i18n（遵循，不展开）

- 所有用户文案走 `src/i18n/dict.*.ts`，`useT()` 消费；`zh-CN` 为 source of truth，
  `en-US` 结构必须完全一致（`Dict` 类型强制）。
- 例外：`<input placeholder>` 可硬编码（须注释说明原因）；`EmptyState/Badge` 等组件不内含文案，
  由调用方传入。

## 10. 审计结论与例外台账（本轮已修复）

硬编码复扫：`src/` 内 `stone-/slate-` 零命中（opencode 的 `from-zinc-300 to-slate-500` 属 §8
品牌点缀例外，保留）；hex 命中只剩 `index.css` Token 定义 + 图表分类色板单源常量。

| # | 发现 | 级别 | 处理结果 |
|---|---|---|---|
| 1 | 动效权威曾分裂三套 | Major | ✅ 已合并至 `src/lib/ease.ts`，`motion-presets.ts` 删除，6 处引用改道；`AGENTS.md` 已同步 |
| 2 | `Switch` 用 `stone/slate` 硬编码；另有 6 处 `focus:border-stone-900`、1 处 `hover:border-stone-300`、`text-stone-600`、`text-slate-400` | Major | ✅ 已收敛：轨道 `accent/muted`、输入聚焦 `focus:border-accent`、悬停 `border-strong`、弱文本 `subtle/muted-foreground` |
| 3 | 图表分类色板非主题感知；前三档与 `accent/warning/danger` 值重复 | Minor | ✅ 接受为例外：SVG `stroke` 属性无法消费 CSS 变量；`"其他"` 灰收敛为 `DIST_OTHER_COLOR` 单源常量，前三档有意镜像语义色浅色值 |
| 4 | `dynamic-island.tsx:156` 一次性任意值（`min-h-[37px] min-w-[126px]`） | Minor | ✅ 注释理由：镜像 iPhone pill 物理尺寸，不进 spacing scale |
| 5 | `AGENTS.md` 动效段与 `ease.ts` 现实不符 | Minor | ✅ 已修订（含 press 弹簧以 `ease.ts` `SPRING_PRESS 500/30/0.6` 为准） |

## 11. 改版与新增流程（红线）

1. 顺序固定：语义 Token → 组件 → 页面。禁止先改页面后补 token。
2. 新视觉需求先回 Token/组件层评审；页面只写布局，不发明颜色/字号/圆角/阴影。
3. 局部样式被复制第二次时回收进共享组件，或显式记录为例外（含理由与位置）。
4. 提交前：`npx tsc --noEmit` 零错误；复扫硬编码（新增命中 = 0）；UI 改动附截图
   （空态 / 单卡 / 抽屉 / 暗色 / 375px）。
