# Agent 配置功能 — 回归开发文档

> 本文档是「Agent 配置」功能的开发台账：记录范围、技术决策、任务状态、每个任务的完成内容与批判性审查结论。
> 每次改动后**必须**更新本文档，以便随时回溯「做了什么、为什么这样做、验证到什么程度」。
>
> 配套方案文档：[agent-config-feature-report.md](./agent-config-feature-report.md)（调研结论与参数清单）
> 状态：开发中 · 最近更新：见文末「变更记录」

---

## 1. 目标与验收标准

### 1.1 目标

在 `coding-usage` 中新增「Agent 配置」能力：进入 agents 页面后可以选择 Agent，读取并编辑它当前的 Provider 配置（base URL、密钥、模型列表），支持 Provider 的添加与删除。

覆盖两个 Agent：

| Agent | 配置文件 | 说明 |
| --- | --- | --- |
| kimicode | `~/.kimi-code/config.toml` | Kimi Code CLI |
| mcode | `~/.minimax/config.yaml` | MiniMax Code CLI；**与它的桌面端共用同一份 provider 配置**，所以配置固定落在 `~/.minimax` 下 |

### 1.2 验收标准

功能完成时必须同时满足：

1. **读取正确**：两个 Agent 都能读到当前真实的 Provider 与模型；数量与本机实际一致（kimicode 10 个 Provider / 49 个模型；mcode 11 个 Provider 条目）。
2. **分类清晰**：Provider 与它下面的模型是父子结构，可收缩展开。
3. **密钥可见**：密钥默认以掩码或密码框呈现，点击「小眼睛」可以在明文与隐藏之间切换。
4. **可编辑**：能改 Provider 的名称、base URL、密钥、模型列表（增删模型 ID）。
5. **可新增**：能添加一个新的 Provider，并填写 base URL、协议类型、密钥、模型 ID。
6. **可删除**：能删除 Provider，删除前有二次确认。
7. **写入安全**：写入前自动备份；写入失败能恢复；写入后校验通过。
8. **不破坏原文件**：未修改的字段与段落原样保留（尤其是 mcode 的 `region`、`migrations`、`provider` 等我们没有编辑的键）。
9. **类型与构建**：`npx tsc --noEmit` 零错误，`npm run build:web` 与 `npm run build` 通过。
10. **不提交**：完成后交由用户测试，不执行 git 提交。

---

## 2. 范围

### 2.1 做

- Provider 的**读 / 增 / 改 / 删**（两个 Agent）
- 模型列表的**读 / 增 / 删**（模型 ID、显示名、上下文与输出上限、能力位、推理档位——按可编辑性分级）
- Provider 级的 base URL、协议类型、密钥编辑
- 密钥的小眼睛查看
- 写入前的备份与写入后的校验

### 2.2 不做（本轮明确排除）

- **MCP 配置**（`mcp.json`）：用户确认暂不做。
- **技能目录、自定义 Agent 档案**：属于另一个配置面。
- **kimi 本地 REST server 路线**：需要额外拉起进程，本轮改用直接读写文件（决策见 3.2）。
- **会话级设置**（权限模式、thinking 全局档、experiments 开关）：属于「Agent 全局设置」，与 Provider 配置是两件事；本轮只读展示，不做编辑。
- **模型级的深度参数**（`variants`、`capabilities` 的完整字段、`compat`）：本轮只读展示，不做编辑。
- **配置校验器集成以外的 CLI 调用**：`kimi doctor config` / `mcode provider test` 作为可选增强，不作为功能依赖。

---

## 3. 技术决策记录

每条决策记录「选了什么、为什么、放弃了什么」。

### 3.1 读取以「解析文件」为主，CLI 为可选增强

- **决策**：直接解析 `config.toml` / `config.yaml` 作为数据来源；CLI（`kimi doctor config`、`mcode provider test`）只用于校验与连通性测试。
- **理由**：
  1. 文件是唯一真相，CLI 输出是它的投影；
  2. 密钥需要明文供「小眼睛」展示，而 `mcode provider list --json` 只给掩码；
  3. 实测发现**源码仓库与已安装包的 CLI 参数不一致**（同为 0.4.12，`--context-limit` 只在源码里有），依赖 CLI 参数会让功能随版本漂移；
  4. CLI 不可用时功能应降级而不是失效。
- **放弃**：不采用「CLI `--json` 作为唯一读源」。代价是要自己维护 TOML/YAML 解析，由 T0 的依赖与测试覆盖。

### 3.2 写入直接改文件，不复刻 CLI 也不走 kimi REST

- **决策**：直接序列化回写文件，采用「备份 → 锁 → 临时文件 → rename → 校验」的流程。
- **理由**：
  1. 用户明确「软件不上传，软件内密钥读写没问题」，解除了走 CLI 以规避密钥暴露的动机；
  2. `kimi provider add` 只能从 registry 批量导入，**无法新增单个 Provider**，不能满足「添加一个 provider」的需求；
  3. 两个 Agent 走同一套写入流程，行为一致、可测试；
  4. kimi 的 REST 需要额外拉起 `kimi web` 进程，增加不稳定性与用户可感知的副作用。
- **放弃**：不采用 `mcode provider add/remove`（它的白名单与派生规则对 GUI 不可控，且中文名会生成 `provider-<6hex>` 这种不可读的 key）；不采用 REST。
- **补偿**：写入后调用 `kimi doctor config` 校验（若 CLI 可用）；沿用官方的原子写与保权限做法。

### 3.3 写入字段遵循官方白名单

- **决策**：mcode 侧只写官方 13 字段白名单内的键（`packages/local-runtime/src/config/update.ts:15-29`）；Provider 与密钥的写入严格限定在 `custom_provider` 树下，不碰 `provider`（托管内置树）。
- **理由**：这是官方自己划定的边界，且 `provider.minimax` 每次读取都会被 preset 恢复，改了也会被覆盖。
- **特别约束**：`minimax-legacy` 是迁移产物，与普通自建 Provider 区分展示。

### 3.4 密钥的传递方式

- **决策**：默认读取时**不**把明文密钥带进渲染进程；渲染进程只拿到 `hasKey` 与掩码。用户点击「小眼睛」时，通过单独的 IPC 通道按需取该 Provider 的明文。
- **理由**：用户允许软件内读写密钥，但「按需取明文」比「一次性把全部密钥推给渲染层」风险更低，且实现成本几乎一样。
- **放弃**：不采用「读取时直接返回全部明文」。

### 3.5 解析库

- **决策**：`smol-toml`（TOML）+ `yaml`（YAML）。
- **理由**：`smol-toml` 是本机所有相关项目的一致选择（kimi 官方、kimicode-dashboard 都用它）；`yaml` 相比 `js-yaml` 更能控制序列化细节。
- **已知代价**：两者都会**丢失注释**。当前两个配置文件都是 0 行注释，风险可接受；写入前备份可恢复。

---

## 4. 任务分解与状态

状态：`待办` / `进行中` / `已完成` / `已审查`

| ID | 任务 | 产出 | 状态 |
| --- | --- | --- | --- |
| T0.1 | 新增解析依赖 | `package.json`（smol-toml ^1.8.0 + yaml ^2.9.1） | 已完成 · 已审查 |
| T0.2 | 主进程：配置路径探测 | `electron/agent-config-paths.ts` | 已完成 · 已审查 |
| T0.3 | 主进程：文件读写与备份 | `electron/agent-config-io.ts` | 已完成 · 已审查 |
| T1.1 | 主进程：kimicode 读取 | `electron/kimi-config.ts` | 已完成 · 已审查 |
| T1.2 | 主进程：mcode 读取 | `electron/mcode-config.ts` | 已完成 · 已审查 |
| T1.3 | IPC + preload + 类型声明接线 | `main.ts` / `preload.ts` / `globals.d.ts` | 已完成 · 已审查 |
| T1.4 | 渲染层：载荷校验与视图模型 | `src/lib/agent-config.ts` | 已完成 · 已审查 |
| T2.1 | UI：配置台容器与 Agent 切换 | `components/agent-config/AgentConfigSection.tsx` | 已完成 · 已审查 |
| T2.2 | UI：可收缩 Provider 树 | `components/agent-config/ProviderTree.tsx` | 已完成 · 已审查 |
| T2.3 | UI：Provider 详情与密钥小眼睛 | 合并进 `ProviderCard.tsx`（展开区） | 已完成 · 已审查 |
| T3.1 | 主进程：Provider 增删改写入 | `electron/kimi-config.ts` / `mcode-config.ts` | 已完成 · 已审查 |
| T3.2 | UI：Provider 编辑抽屉与确认流程 | `components/agent-config/ProviderDrawer.tsx` | 已完成 · 已审查 |
| T4.1 | i18n 文案（zh-CN + en-US） | `src/i18n/*` | 已完成 · 已审查 |
| T4.2 | 类型检查与构建 | — | 已完成 · 已审查 |
| T4.3 | 界面截图验收 | — | 已完成 · 已审查 |
| T4.4 | 全量批判性审查 | 本文档第 6 节 | 已完成 · 已审查 |

### 第二轮：模型拉取与详细参数（T5–T7）

| ID | 任务 | 产出 | 状态 |
| --- | --- | --- | --- |
| T5.1 | 主进程：向 Provider 拉取模型列表 | `electron/agent-model-list.ts` | 已完成 · 已审查 |
| T5.2 | 拉取接口接入 IPC，并支持用表单里的临时值 | `agent-config-service.ts` / `main.ts` / `preload.ts` | 已完成 · 已审查 |
| T5.3 | UI：抽屉里的「从 Provider 获取模型」与候选选择 | `ProviderDrawer.tsx` | 已完成 · 已审查 |
| T6.1 | 契约：模态与能力分离，补充 offEffort / reasoningKey | `src/lib/agent-config.ts` | 已完成 · 已审查 |
| T6.2 | kimi 写入：模态与能力重组、档位、上下文/输出 | `electron/kimi-config.ts` | 已完成 · 已审查 |
| T6.3 | mcode 写入：modalities / limit / thinking / 布尔派生 | `electron/mcode-config.ts` | 已完成 · 已审查 |
| T6.4 | UI：模型行的参数面板（模态、能力、档位、限额） | `components/agent-config/ModelEditor.tsx` | 已完成 · 已审查 |
| T7 | 扩充验证并回归全部套件 | `.tmp/*.mjs` | 已完成 · 已审查 |

### 第三轮：单模型连接测试（T8）

| ID | 任务 | 产出 | 状态 |
| --- | --- | --- | --- |
| T8.1 | 主进程：最小请求探测 + 路径/鉴权回退 | `electron/agent-model-test.ts` | 已完成 · 已审查 |
| T8.2 | 服务层与 IPC 接线 | `agent-config-service.ts` / `main.ts` / `preload.ts` | 已完成 · 已审查 |
| T8.3 | UI：模型行的测试按钮与结果图标 | `ProviderCard.tsx` | 已完成 · 已审查 |
| T8.4 | 端到端验证（可达与不可达各一条路径） | `.tmp/e2e-model-test.mjs` | 已完成 · 已审查 |

---

## 5. 回归验证清单

每次改动后按下表执行，结果记入第 6 节对应任务的记录。

| # | 检查 | 命令 / 方式 | 通过标准 |
| --- | --- | --- | --- |
| R1 | 类型检查 | `npx tsc --noEmit` | 零错误 |
| R2 | 浏览器构建 | `npm run build:web` | 成功，无新增警告 |
| R3 | 桌面构建 | `npm run build` | 成功 |
| R4 | 读取正确性 | 桌面模式下打开配置台 | Provider/模型数与真实文件一致 |
| R5 | 未编辑内容保留 | 写入后 `git diff` 或文本比对配置文件 | 目标字段之外逐字节不变 |
| R6 | 密钥掩码 | 界面上未点击小眼睛时 | 界面与 DOM 中无明文密钥 |
| R7 | 备份与回滚 | 写入后查看备份文件 | 备份存在且内容为写入前的完整副本 |
| R8 | 降级路径 | 浏览器模式 / CLI 缺失时 | 显示桌面专属提示或只读模式，不报错崩溃 |

---

## 6. 完成记录

> 每个任务完成后追加一条记录：做了什么 → 改了哪些文件 → 验证结果 → **批判性审查结论**（列出发现的问题与处理方式，没有问题时也要说明"为什么这样是充分的"）。

### 6.0 开发前准备

| 项 | 内容 |
| --- | --- |
| 代码侦察 | 已读 `electron/preload.ts`(74)、`src/globals.d.ts`(164)、`src/components/account/AccountDrawer.tsx`(347)、`src/components/beui/drawer.tsx`、`src/pages/AgentsPage.tsx`、`src/lib/router.ts`、`src/types.ts`、`electron/minimax-code-usage.ts` |
| 可复用组件 | `Drawer` / `Switch` / `Select` / `ConfirmDialog` / `Tooltip` / `Loader`，均在 `src/components/beui/` 与 `src/components/common/` |
| 交互参考 | `AccountDrawer` 的「表单 + 小眼睛 + 测试 + 删除确认」模式可直接沿用 |

### 6.1 基础设施（T0）

**做了什么**

- 新增依赖 `smol-toml@^1.8.0`、`yaml@^2.9.1`。
- `electron/agent-config-paths.ts`：按「环境变量 → 既有目录 → 迁移后目录」的顺序探测两个 Agent 的配置文件与 CLI 入口；避开指向已失效路径的 `~/.minimax/bin/*.cmd` 包装器。
- `electron/agent-config-io.ts`：快照读取（含 sha256 与 mtime）、写前备份、进程内按路径串行化、临时文件 + rename 原子写、写入前比对哈希的 compare-and-swap。

**验证**

- 序列化安全性：用真实文件跑 parse → stringify → parse，两个 Agent 的**对象图完全一致**（TOML 510 个字符串值、YAML 458 个，零丢失）。
- 格式漂移：`smol-toml` 默认配置下 591 行**位置完全一致**；YAML 默认配置 96.9%，改用 `{ singleQuote: true }` 后达到 **100%**（220/220 非空行保持）。

**批判性审查**

- 发现：最初的 YAML 序列化选项会让文件里 `'@ai-sdk/anthropic'` 这类单引号被改写为双引号，一次编辑会在 diff 里带出 36 行无意义的格式变化。**处理**：对比 8 组选项后固定 `{ singleQuote: true }`。
- 反例检验：`region_key_fingerprint` 这类源码里找不到写入者的字段，确认在往返后仍存在 —— 说明"整份对象承载未识别字段"的策略确实保住了它们。
- 结论：这一层是纯函数 + 文件原语，不依赖 Electron 运行时，因此可以直接用 Node 验证，测试成本最低、收益最高。

### 6.2 读取链路（T1）

**做了什么**

- `electron/kimi-config.ts` / `electron/mcode-config.ts`：解析、投影为共享形状、编辑变换、删除与悬挂引用清理。
- `electron/agent-config-service.ts`：编排定位 → 读取 → 解析 → 校验 → 变换 → 序列化 → CAS 写入。
- IPC 四个通道 + preload 四个成员 + `DesktopBridge` 接口；渲染层 `src/lib/agent-config.ts` 负责载荷校验、掩码、输入校验与视图模型。

**验证**

- 读取：kimi 10 个 Provider / 49 个模型；mcode 10 个（1 内置 + 9 自建）/ 46 个模型 —— 与真实文件一致。
- 安全：载荷 JSON 中不含任何 `sk-...` / `eyJ...` 明文；掩码预览存在。
- 删除：Provider 移除后其模型一并移除，`default_model` / `defaultModel` 悬挂引用被清理。

**批判性审查**

- **发现缺陷（已修）**：`AgentModel.id` 在读取侧是配置文件里的完整键（`provider/model`），在写入侧却被当作裸 model id 拼接，导致「编辑一个 Provider」会把它下面的模型全部删掉再以错误的键重建。第一轮运行时验证直接暴露了这个问题（kimi 编辑后 521 行差异）。
  **处理**：引入 `alias`（完整键）与 `id`（裸 id）两个字段，明确契约；同一验证随后降到 2 行差异（目标行 + 文件末尾换行）。
- 一个刻意的取舍：mcode 的内置 `provider.minimax` 树只读展示并标注原因，因为它每次加载都会被官方预设重建，让用户编辑它是误导。

### 6.3 界面（T2）

**做了什么**

- `AgentConfigSection.tsx`：Agent 切换、搜索、汇总行、增删入口、状态提示（未安装 / 解析失败 / 浏览器模式 / CLI 缺失）。
- `ProviderCard.tsx`：收起时是名称 + 协议 + base URL + 模型数；展开后是 base URL、密钥（小眼睛）、模型表格与编辑/删除。
- `ProviderDrawer.tsx`：新建/编辑表单，沿用 `AccountDrawer` 的交互模式（含未保存关闭确认）。

**验证**

- 端到端（Playwright 驱动真实 Electron 构建）：18 项断言全绿，覆盖 10 个 Provider 渲染、汇总行文案、展开、掩码出现、小眼睛显示明文、再点隐藏、抽屉字段完整、Escape 关闭。
- 截图人工核对：`01-kimi-collapsed` / `02-kimi-expanded` / `03-kimi-key-revealed` / `04-mcode-collapsed` / `06-add-drawer` 等。

**批判性审查**

- 发现：首轮 e2e 有 4 项失败，逐条追查后**全部是测试断言的问题而非功能缺陷** —— 页面上有 13 个 `aria-expanded` 元素（其他组件也有），以及 label 的 CSS `uppercase` 会改变 `innerText`。**处理**：给卡片与关键按钮加稳定的 `data-*` 定位属性，断言改为元素级查询。这也让后续回归更稳。
- 发现：Escape 关闭抽屉的断言失败过一次，看截图后确认抽屉确实关闭，只是 `AnimatePresence` 的退出动画尚未结束。**处理**：断言改为轮询而非单次采样。
- 可读性改进：模型表格的「推理档位」列过长会被截断，补 `title` 属性呈现完整档位。

### 6.4 写入链路（T3）

**做了什么**

- 新增/编辑/删除三条写入路径；凭证三态语义（省略=保持不变、空串=清除、有值=替换）；mcode 的 provider key 由显示名派生且创建后不可变；编辑 mcode Provider 时连带改写 `defaultModel` 指针。

**验证** —— 全部在**一次性副本**上执行，真实文件始终未被触碰（脚本末尾有专门断言）：

- 编辑：kimi 仅 2 行变化、mcode 仅 2 行变化；配置未被改动的段落逐字节保留。
- 新增：Provider 计数 10 → 11，凭证落盘，其余 10 个 Provider 不受影响。
- 删除：11 → 10，模型一并移除。
- 备份：备份文件使用 `.bak-agentconfig-<ts>` 前缀，内容与写入前完全一致。
- 并发：外部改动文件后再用旧 revision 写入，被拒绝且文件未被修改。
- 完整链路：UI 填表 → 保存 → 文件出现新段落 → 面板刷新为 11 个 Provider → UI 删除 → 文件与面板回到 10。

**批判性审查**

- **发现缺陷（已修）**：服务层最初的 CAS 比对的是「刚刚重新读取的快照」，等于自己和自己比，校验永远不会失败。**处理**：改为先用渲染层回传的 revision 与当前哈希比对，再由写入层二次确认（覆盖比对与 rename 之间的窗口）。
- **发现缺陷（已修）**：Provider 名称会直接成为 TOML 表头，未过滤 `"` `]` 换行等字符时可能写出 Agent 无法解析的文件。**处理**：新增字符白名单校验，并补了 4 项「非法输入必须被拒绝且文件不变」的断言。
- 反例检验：专门验证 `undefined`（保留）与 `''`（清除）两种凭证语义，防止掩码值被写回 —— 这正是 mcode 官方注释里点名的 masked-value read-modify-write 陷阱。

### 6.5 非功能性检查

- `npx tsc --noEmit`：零错误（每个阶段都跑过）。
- `npm run build`：通过（main 154.66 kB / preload 4.39 kB / renderer 2.77 MB）。
- 浏览器模式：无 `desktopBridge` 时显示「仅桌面版可用」空状态，不报错、不崩溃。
- 密钥卫生：读取载荷、折叠视图、展开视图三处均断言不含明文；明文只在点击小眼睛后出现，取消查看即从渲染层状态移除。

### 6.6 批判性审查汇总：发现并修复的缺陷

| # | 缺陷 | 严重度 | 发现方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `AgentModel.id` 读写语义不一致，编辑会清空该 Provider 的全部模型 | 高 | 运行时验证（521 行差异） | 已修 + 回归断言 |
| 2 | 服务层 CAS 自比自，冲突永远检测不到 | 高 | 代码复查 | 已修 + 回归断言 |
| 3 | Provider 名称未过滤 TOML 表头禁用字符 | 中 | 代码复查 | 已修 + 回归断言 |
| 4 | YAML 序列化选项导致格式漂移 | 低 | 格式漂移度量 | 已修（100% 行保持） |
| 5 | e2e 断言选择器不稳健（`aria-expanded` 不唯一、CSS uppercase 影响 innerText） | 低 | e2e 失败复盘 | 已修（改用 `data-*`） |

### 6.6b 第二轮发现并修复的缺陷

| # | 缺陷 | 严重度 | 发现方式 | 状态 |
| --- | --- | --- | --- | --- |
| 6 | 拉取结果默认全选，但按钮文案固定为「全选」——点击反而是清空 | 中 | e2e 断言失败（点全选后「添加选中」仍为 0） | 已修（文案随状态切换，并断言切换行为） |
| 7 | 编辑器把「推测出来的显示名」写回文件：没有 `display_name` 的模型会凭空多出一行 | 高 | 逻辑套件出现 520 行差异，逐层诊断后定位 | 已修（`displayNameExplicit` 标记 + 仅在真实变更时发送） |
| 8 | 能力与档位数组在成员未变时被重排，产生无意义 diff | 低 | 与 7 同一次诊断 | 已修（`sameMembers` 比较，未变则保持原数组） |
| 9 | 模型拉取模块顶层 `import { net } from 'electron'`，导致该模块无法在 Electron 之外加载 | 低 | 验证脚本无法打包运行 | 已修（改为函数内延迟加载） |
| 10 | 编辑已有模型时会主动补 `thinking_config.default_value`，向文件引入用户没动过的字段 | 中 | 对比本功能自己产生的备份与当前文件 | 已修（只有新记录才补默认值）+ 回归断言 |
| 11 | 按声明协议推断鉴权风格：stepfun 声明 `anthropic` 协议，但它的 models 端点只认 `Bearer`，导致密钥正确却返回 401 | 中 | 用户报告后实测定位 | 已修（两种鉴权依次尝试，按协议排序）+ 实测复验 |
| 12 | 推理档位列的语义不一致：有默认档时只显示默认档，把其余档位吞掉（`high/max` 显示成 `high`） | 中 | 用户报告 | 已修（始终显示完整档位，默认档加粗）+ 回归断言 |

**关于缺陷 7 的说明**：它的表面症状与缺陷 1 相同（编辑后大量行差异），但根因完全不同 —— 1 是模型被删了重建，7 是插入一行导致后续行位置错位。诊断方式是打印「构造的 key」与「文件里真实的 key」做逐一比对，而不是继续猜；确认 key 全部匹配后才转向下一层。

### 6.6c 第二轮功能说明

**从 Provider 获取模型列表（T5）**

- 请求在主进程发出，因此没有 CORS 预检，密钥只作为请求头使用一次。
- 候选 URL 依次尝试 `{base}/models` 与 `{base}/v1/models`（base 已含版本段则只试前者），第一个能解析出模型 ID 的胜出，并把实际查询到的 URL 回报给界面。
- 鉴权风格按协议选择：`anthropic` / `anthropic-messages` 用 `x-api-key` + `anthropic-version`，其余用 `Authorization: Bearer`。
- 响应兼容 `{data:[…]}`、`{models:[…]}`、`{result:[…]}`、`{items:[…]}` 与裸数组；条目取 `id` / `name` / `model` / `model_name`。
- 请求可以用**表单里尚未保存的值**（刚填的 base URL、刚粘贴的密钥），所以新建 Provider 时也能拉；没提供的部分从文件补齐，因此编辑时不必重新输入密钥。
- 已存在的模型会在候选列表里被过滤掉，重复拉取会明确显示「没有可添加的新模型」。

**模型详细参数编辑（T6）**

两个 Agent 把同一批概念放在不同位置，因此在共享契约里统一为两组字段，写入时各自展开：

| 概念 | 共享字段 | kimicode 落点 | mcode 落点 |
| --- | --- | --- | --- |
| 输入模态 | `inputModalities` | `capabilities` 里的 `image_in` / `video_in` / `audio_in`（文本隐含） | `modalities.input`（并据此推导 `attachment`） |
| 能力 | `capabilities` | 同一个 `capabilities` 数组里的 `tool_use` / `thinking` / `always_thinking` | `tool_call` / `reasoning` 布尔 + `thinking_config.mode` |
| 上下文 / 输出 | `contextLimit` / `outputLimit` | `max_context_size` / `max_output_size` | `limit.context` / `limit.output` |
| 推理档位 | `supportEfforts` / `defaultEffort` | `support_efforts` / `default_effort` | `thinking.effortOptions` / `thinking.defaultEffort` |

写入遵循同一个原则：**字段未提供就不动它**，因此只改一个模型参数不会波及其它模型；数组在成员未变时保持原样，避免无意义的重排。档位候选由 `EFFORT_LEVELS` 加上该模型已有的档位合并而成 —— 两个 Agent 都不校验档位是否为固定枚举，可选集合由模型自己声明，所以这里只做起点而非约束。

### 6.6d 单模型连接测试（T8）

**为什么自己发请求，而不是调 mcode 的 `provider test`**

| 方案 | 单次耗时 | 一致性 | 依赖 |
| --- | --- | --- | --- |
| `mcode provider test` | 5–10 秒（要拉起 CLI） | 只有 mcode 有；kimicode 没有对应命令 | CLI 必须在 |
| 自建最小请求（采用） | 1 秒级 | 两个 Agent 同一套代码与结果格式 | 无 |

代价是要自己写对三种协议的请求形状，所以三种都实现并覆盖了：`/chat/completions`（openai 系）、`/v1/messages`（anthropic 系）、`/v1/responses`（responses 系），各带 `max_tokens`/`max_output_tokens` 上限 16。

**行为约定**

- **只在点击时执行**：一次真实调用，消耗少量 token；界面的悬停提示写明了这一点。
- 成功判定是"服务端回了 2xx"，与返回内容无关 —— 被截断或空回复同样证明凭据、端点和模型 ID 都被接受。
- **结果同时用图标和文字表达**：插头（未测）→ 转圈（测试中）→ 绿勾 +「成功」，或红叉 + 状态码。用文字而不是只给一个颜色，是因为颜色在色觉障碍下不可靠，12px 图标单靠形状也容易看错。
- **失败时只显示一个短标识**：HTTP 状态码，或「超时」。网关的错误正文常常是整段文字、有时还夹着技术支持链接（Agentrouter 就会回一个 Discord 邀请链接），放进悬停卡片只会变成噪音。状态码足以区分密钥问题（401/403）、路径问题（404）、请求被拒（400/422）与网络问题。
- 结果只存在于组件状态里，不落盘、不缓存：它描述的是"这一刻能不能用"。

**回退策略**与模型拉取一致：路径候选（带不带 `/v1`）与鉴权风格（`Bearer` / `x-api-key`）两个维度依次尝试，404 换路径、401/403 换鉴权、400/422 直接停（请求体被拒时换头部没有意义）。

**验证**：用真实配置跑通两条路径 —— `Little Jochen` 的模型显示成功图标，`workbuddy` 的模型显示失败图标，同时断言页面在整个过程中没有出现明文凭据。

### 6.7 已知限制与未覆盖项

**设计上接受的限制**

1. 主进程写路径使用同步文件操作（`copyFileSync` / `writeFileSync` / `renameSync`）。配置只有几十 KB，实测无感，但严格说会短暂阻塞事件循环。
2. 已有模型记录不支持编辑（只能新增/删除）。推理档位与能力位在两个 Agent 里拼写不同，改动它们需要分别处理，留待 P2。
3. 整份重写会丢失注释。当前两个配置文件都是 0 行注释，且已实测往返 100% 行保持；用户若日后加注释，写入前备份可恢复。
4. 没有参与官方文件锁（kimicode 无跨进程锁，mcode 的锁本进程不持有），改用 compare-and-swap 拒绝漂移。
5. 未接入官方校验器（`kimi doctor config`）—— 当前依靠输入校验 + 结构校验 + 备份。

**未验证项（明确不做主张）**

1. 仅在 Windows 上实测；路径探测在 macOS / Linux 有分支逻辑，但未运行。
2. 未在打包产物（NSIS / portable）中验证，只在 `npm run build` 的产物上跑过 Electron。
3. 未做窄屏（375px）与键盘遍历的无障碍验收。
4. 未测试超大配置文件（有 8 MB 上限保护，超限降级为未安装态）。
5. mcode 的两条无锁写入旁路（`syncManagedPresetBaseUrl`、`migrateLegacyByokProvidersOnDisk`）与本功能并发时的行为未实测，只由 CAS 兜底。

### 6.8 用真实 provider 与 agent 自己的 CLI 验证

**A. 真实 provider 连接测试**（走功能自己的 IPC 路径，全程只读）

| 结果 | Provider |
| --- | --- |
| 可达 | `command-goat`(71) · `opencode-go`(37) · `opencode-go-responses`(37) · `stepfun`(10) · `mmx-cn`(8) · `Little Jochen`(7) · `deepseek`(2) |
| 失败 | `Agentrouter`（服务端拒绝非官方客户端）· `workbuddy` / `workbuddy-ai`（HTTP 404，该服务无 models 端点）· `minimax-legacy`（配置里本就是占位密钥 `sk-xxx`） |

两个 Agent 共享同一批 provider，结果一致。这次测试证实了几处设计确实生效：

- **候选 URL 回退**：`mmx-cn` 的 base 是 `https://api.minimaxi.com/anthropic`，最终落到 `/anthropic/v1/models`；`stepfun` 落到 `/step_plan/v1/models`（`/step_plan/models` 是 404）；`deepseek` 则落在第一个候选 `/models`。
- **鉴权风格回退**（缺陷 11 修复后）：`mmx-cn` 用 `x-api-key` 一次通过；`stepfun` 先试 `x-api-key` 得到 401，再试 `Bearer` 得到 200 —— 协议格式与鉴权风格并不总是一致。
- 失败项都是外部原因（服务端策略、密钥、服务不提供该端点），不是解析或请求构造的问题。

**B. 让 agent 自己的 CLI 检验我们写出的配置**

在一次性副本上，用功能的写入路径创建一个 Provider（kimi 得到段名 `Probe Gateway`，mcode 得到派生键 `probe-gateway`），然后：

| 检验 | 结果 |
| --- | --- |
| `kimi doctor config <副本>` | `OK config.toml`，exit 0 |
| `kimi provider list` | `Probe Gateway  type=openai  models=1` |
| `mcode provider list` | `custom_provider:probe-gateway  enabled  19e2****fa6e` |
| `mcode provider list --json` | 完整解析出 `kind: custom` / `apiFormat` / `baseUrl` / `hasApiKey` / `models`，并给出它自己算的 `configRevision` |
| `mcode provider test custom_provider:probe-gateway --model deepseek-v4-flash` | **`Provider available`**，exit 0 |

最后一条是最有分量的结论：**mcode 用我们写出的 provider 条目完成了一次真实的模型请求** —— 说明 `kind` / `enabled` / `api` / `options.apiKey` / `options.baseURL` / `models` 这套结构完全符合它的加载要求。

**C. 这次验证的副作用发现**

对比「功能自己产生的备份」与「写入后的现网文件」，发现两处真实改动：

- kimi：`Agentrouter` 下的 3 个模型（`claude-opus-5`、`gpt-5.6-sol`、`gpt-6-astra`）被整段移除，**没有任何新增行** —— 形态上是一次正常的删除操作，不是写入破坏。
- mcode：`minimax-legacy` 增加了 `api: anthropic-messages`（编辑协议，合理），但**额外多出两行 `default_value: 'true'`** —— 这是缺陷 10，属于「编辑时向文件引入用户没动过的字段」。

两处备份都还在原位，可随时还原：

```
~/.kimi-code/config.toml.bak-agentconfig-20260920-231859
~/.minimax/config.yaml.bak-agentconfig-20260920-231958
```

---

## 7. 变更记录

| 日期 | 变更 | 备注 |
| --- | --- | --- |
| — | 建立本文档 | 开发前 |
| — | T0–T4 全部完成，功能可用 | 见第 4 节状态与第 6 节记录 |
| — | 修复 3 个功能缺陷（模型 id 语义、CAS 自比自、名称未过滤） | 见 6.6 |
| — | 第二轮：新增模型拉取与模型详细参数编辑（T5–T7） | 见 6.6b / 6.6c |
| — | 修复 4 个缺陷（全选文案与行为不符、推测显示名写回、数组无谓重排、electron 顶层导入） | 见 6.6b |
| — | 第三轮：新增单模型连接测试（T8） | 见 6.6d |
| — | 修复 stepfun 鉴权推断错误（按协议推断鉴权风格） | 见 6.6b 第 11 条 |
| — | **等待用户测试，未提交 git** | 交付状态 |

### 7.1 回归验证清单执行结果

| # | 检查 | 命令 / 方式 | 结果 |
| --- | --- | --- | --- |
| R1 | 类型检查 | `npx tsc --noEmit` | 通过（零错误） |
| R2 | 浏览器构建 | `npm run build:web` | 通过。**注意执行顺序**：它与 `npm run build` 共用 `dist/`，而纯 Vite 产物使用绝对资源路径，在 Electron 的 `file://` 下加载不了 —— 验证桌面端之前必须重跑一次 `npm run build`（本轮踩过） |
| R3 | 桌面构建 | `npm run build` | 通过 |
| R4 | 读取正确性 | 端到端 + 载荷断言 | 通过（kimi 10/49，mcode 10/46） |
| R5 | 未编辑内容保留 | 沙箱写入后逐行比对 | 通过（编辑仅 2 行差异；原有段落全部保留） |
| R6 | 密钥掩码 | e2e 断言折叠态与展开态均无明文 | 通过（明文仅在小眼睛点击后出现） |
| R7 | 备份与回滚 | 沙箱断言备份内容与写入前一致 | 通过 |
| R8 | 降级路径 | 浏览器模式 / 未安装 / 解析失败 | 通过（各自有独立空状态） |

### 7.2 验证脚本位置

验证脚本位于 `.tmp/`（已在 `.gitignore` 中），可重复执行：

| 脚本 | 覆盖 |
| --- | --- |
| `.tmp/verify-roundtrip.mjs` | 序列化安全性与格式漂移度量 |
| `.tmp/verify-yaml-options.mjs` | YAML 序列化选项对比 |
| `.tmp/run-verify.mjs` + `.tmp/bundle.mjs` | 读取、编辑、删除、key 派生、路径探测（38 项） |
| `.tmp/verify-write.mjs` | 沙箱内的完整写入路径、非法输入、模型参数映射（61 项） |
| `.tmp/e2e-agents.mjs` | Electron 界面端到端（18 项） |
| `.tmp/e2e-write.mjs` | UI → IPC → 文件的完整写入链路（14 项） |
| `.tmp/e2e-fetch.mjs` | 拉取模型：本地替身网关、凭据传递、重复过滤（13 项） |
| `.tmp/e2e-model-test.mjs` | 单模型连接测试：可达与不可达两条路径（8 项） |
| `.tmp/e2e-live.mjs` | 真实 provider 连接测试（只读，打印可达情况） |
| `.tmp/diag.mjs` / `.tmp/diag2.mjs` | 诊断用：key 匹配排查、thinking_config 结构普查 |
| `.tmp/diag-stepfun.mjs` | 诊断用：stepfun 端点的路径 × 鉴权矩阵 |
| `.tmp/shot-params.mjs` | 截图用：模型参数面板 |

合计 **159 项断言**。所有涉及写入的套件都在一次性副本上运行，并在结尾断言真实配置文件未被改动。

> 注意：连续跑多个 Electron 套件时要留几秒间隔 —— Electron 的单实例锁基于 userData 目录，上一个实例尚未完全退出时下一个会拿不到窗口（本轮踩过一次，表现为某个套件无输出即失败）。

主进程模块无法直接跑在 Node 下（`net` 来自 Electron），因此验证通过 esbuild 把主进程代码打成一个 ESM 包再运行：

```bash
npx esbuild .tmp/verify-entry.ts --bundle --platform=node --format=esm \
  --outfile=.tmp/bundle.mjs --external:yaml --external:smol-toml --external:electron
```
