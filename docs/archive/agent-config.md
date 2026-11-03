# Agent 配置功能 — 设计与实现记录（历史）

- **状态**：historical（功能已上线，本文只作背景参考，不代表当前实现细节）
- **合并自**：原 `docs/agent-config-feature-report.md`（调研与方案）与
  `docs/agent-config-development.md`（开发台账）。逐任务流水、审查过程与临时脚本清单已删除。
- **对象**：`kimicode`（Kimi Code CLI，`~/.kimi-code/config.toml`）与 `mcode`（MiniMax Code，
  `~/.minimax/config.yaml`），后续扩展到 `opencode`。
- **当前实现位置**见文末「实现落点」。

## 1. 目标与范围

在 agents 页面下方新增「Agent 配置」分区，用于查看与修改本机编码 Agent 的 Provider / 模型 /
推理等级配置。

做：Provider 的读 / 增 / 改 / 删；模型列表的读写（按可编辑性分级）；base URL、协议类型、密钥编辑；
密钥「小眼睛」查看；写入前备份与写入后校验；未编辑字段原样保留。

不做：MCP 配置；技能目录、自定义 Agent 档案；会话级设置（只读展示）；模型级深度参数（`variants` /
`compat` 等）；kimi 本地 REST server 路线。

## 2. 关键结论

| 问题 | 结论 |
| --- | --- |
| 展现方式 | agents 页内的双栏配置台（左 Agent/Provider 树，右详情），不做独立页面 |
| 集成面 | 以**解析配置文件**为主，CLI（`kimi doctor config` / `mcode provider test`）只作校验增强 |
| 参数分层 | ① Agent 全局（默认模型 / 推理等级 / 权限模式）② Provider（名称 / base URL / 协议 / 密钥）③ Model（ID / 显示名 / 上下文与输出上限 / 能力位 / 档位） |
| 最大风险 | 两个配置文件都**明文存密钥**：必须读不回显、写不落日志、改前备份、改后校验 |

## 3. 必须记住的配置事实

### 3.1 路径陷阱

`~/.minimax-code` 是 npm 安装前缀（程序），`~/.minimax` 才是运行时数据目录（`config.yaml`）。
上游正在把默认数据目录迁向 `.minimax-code`，因此定位顺序应为：环境变量 `MINIMAX_DATA_DIR` →
`~/.minimax/config.yaml` → `~/.minimax-code/config.yaml`，以文件存在为最终判据。
CLI 入口要避开失效包装器（`~/.minimax/bin/minimax.cmd` 是残留），用 `~/.minimax-code/mcode.cmd`。

### 3.2 推理档位（effort）

- 合法档位由**模型自己**声明（kimicode `support_efforts`，mcode `thinking.effortOptions`），
  不是固定枚举；顺序按强度升序。
- 默认档：模型级 `default_effort` / `thinking.defaultEffort` → 否则列表中间值；全局默认分别在
  `[thinking].effort` 与 `defaultModelThinking.effort`。
- `off` / `on` 是布尔态，不是档位；含 `always_thinking` 的模型禁止关闭思考。
- 产品含义：GUI 必须按所选模型动态渲染档位，不能给统一下拉框。
- 限制：mcode 顶层 `defaultModelThinking.effort` 只对 MiniMax 官方渠道生效；BYOK 模型走模型级
  `thinking.defaultEffort`。界面必须标注全局档只对官方渠道有效。

### 3.3 会让配置静默失效的坑

1. `max_completion_tokens` 写在模型条目里会被静默忽略（schema `.passthrough()`），唯一生效位置是
   全局 `[model_overrides]`。模型表单不能放这个字段。
2. Provider 的 `type` 写错不报错（`ProviderTypeSchema = z.string()`），只表现为模型不可用。
   协议类型必须用白名单下拉（`anthropic` / `openai` / `openai_responses` / `google-genai` / `kimi`）。
3. 其它：`provider_id` 与 `provider` 并存时前者优先；模型级 `api_key` 与 `oauth` 同时存在会报错；
   `KIMI_MODEL_NAME` 会接管 `default_model`；`[thinking].enabled` 不要写 `false`（视为显式关闭）；
   空串等价于未设置，判「有无密钥」要先 trim。

## 4. 技术决策

1. **读取以解析文件为主**：文件是唯一真相，CLI 输出是其投影；CLI 参数在源码与安装包间会漂移；
   CLI 不可用时功能要降级而非失效。代价是自维护 TOML/YAML 解析。
2. **写入直接改文件**：备份 → 进程内按路径串行化 → 临时文件 + rename 原子写 → 校验；
   不复刻 CLI（`kimi provider add` 无法新增单个 Provider），也不走 kimi REST（需另起进程）。
3. **写字段遵循官方白名单**：mcode 只写官方 13 字段白名单内的键，Provider 与密钥限定在
   `custom_provider` 树下，不碰会被 preset 恢复的 `provider.minimax`。
4. **密钥按需取明文**：读取时不把明文推给渲染层，只给 `hasKey` 与掩码；点「小眼睛」时经独立 IPC 取。
5. **解析库**：`smol-toml`（TOML）+ `yaml`（YAML）。已知代价：两者都丢注释（当前配置文件 0 注释，
   写入前有备份可恢复）。

## 5. 实现落点

```text
electron/agent-config-paths.ts     # 环境变量 → 既有目录 → 迁移后目录的路径探测
electron/agent-config-io.ts        # 快照读取（sha256/mtime）、写前备份、串行化、原子写、CAS
electron/agent-config-service.ts   # 定位 → 读取 → 解析 → 校验 → 变换 → 序列化 → CAS 写入
electron/agent-model-list.ts       # 拉取模型列表
electron/agent-model-test.ts       # 单模型连接测试
electron/kimi-config.ts / mcode-config.ts / opencode-config.ts
src/lib/agent-config.ts            # 载荷校验、掩码、输入校验、视图模型（纯函数）
src/components/agent-config/       # AgentConfigSection / ProviderCard / ProviderDrawer / ModelEditor
```

## 6. 验证结论（历史记录）

- `npx tsc --noEmit` 零错误；`npm run build:web` 与 `npm run build` 通过。注意两者共用 `dist/`，
  验证桌面端前必须重跑 `npm run build`。
- 读取正确性：kimi 10 Provider / 49 模型，mcode 10 Provider / 46 模型。
- 未编辑内容保留：沙箱写入后逐行比对，编辑仅 2 行差异。
- 密钥掩码：折叠与展开态断言无明文，明文仅在小眼睛点击后出现。
- 备份与回滚：备份内容与写入前一致。
- 降级路径：浏览器模式 / 未安装 / 解析失败各有独立空状态。
- 用 Agent 自己的 CLI 交叉验证：`kimi doctor config` OK；`mcode provider test <new>` 返回
  `Provider available`，说明写出的结构符合其加载要求。

## 7. 已知限制

1. 主进程写路径用同步文件 API，配置几十 KB 无感但会短暂阻塞事件循环。
2. 已有模型记录只能新增/删除，不支持编辑（留待后续）。
3. 整份重写丢注释；当前两文件 0 注释，往返 100% 行保持。
4. 不参与官方文件锁，改用 compare-and-swap 拒绝漂移。
5. 仅 Windows 实测；macOS / Linux 有分支但未运行；未在 NSIS/portable 产物中验证。
