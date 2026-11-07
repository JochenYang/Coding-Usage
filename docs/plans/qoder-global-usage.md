# Qoder 国际版（global build）用量读取

- Status: active
- Plan date: 2026-11-07
- 进度：本地 credits 记账 + `qoder-global` 独立行、账户 credits 额度卡片均已实现并通过实测；critical review 已完成，指出的问题已修（见文末）。

## 目标

本地 Agent 卡片里 Qoder 一行，对安装并使用的**国际版（global build）**显示真实用量，而不只是调用次数。

国内版（CN build）会话已由 `electron/qoder-usage.ts` 读取。本次要确认的是：国际版的数据在哪里、能不能读、读出来是什么数字。

## 已核实事实（本机实测，2026-11-07）

本机安装的是 global build：`~/.qoder/.qoder-app-status.json` 里 `"product": "qoder"`、`"version": "0.5.6"`，登录态正常；`~/.qoder-cn` 不存在（CN build 不在本机，无法在这里复核 CN 行为）。

| 位置 | 内容 | 是否含 token 用量 |
|---|---|---|
| `~/.qoder/projects/<project>/<sessionId>.jsonl` | IDE 与 CLI 共用的会话转录，session id 与 IDE 库一致 | 有 `usage` 字段，但**token 计数全为 0** |
| `%APPDATA%\com.qoder.app.stable\main.sqlite` | IDE 主库：`chat_sessions`(6) / `chat_session_messages`(59) / `chat_session_context_usage`(6) | **无** |
| `%APPDATA%\com.qoder.app.stable\chat-session-turn-payload-buffer.sqlite` | 两个表，均为 0 行 | — |
| `%APPDATA%\com.qoder.app.stable\logs\<ts>-<pid>\main.log` | IDE 主进程日志 | 只有账户级接口调用记录 |
| `~/.qoder/logs/runs/<ts>-p<pid>/qodercli.log` | CLI 日志 | 日志里的 usage 行同样是 0 |

细节：

- 转录里 assistant 行的 `message.usage` 形如：
  `{input_tokens:0, cache_creation_input_tokens:0, cache_read_input_tokens:0, output_tokens:0, service_tier, credits, original_credits, billable, request_id, context_usage_ratio}`
  —— 真实数字只有 **`credits` / `original_credits` / `billable`**（实测值如 `2.904257142857143`、`3.1640571428571427`、`0.0809142857142857`）。
- IDE 侧 `chat_session_messages.payload_json` 顶层键为 `requestSetId, resultUuid, completedAt, durationMs, turnMetrics, parts, finalTextId`，`turnMetrics` 只有 `{durationMs, turnCount}`，没有任何 usage。
- IDE 侧 `chat_session_context_usage.snapshot_json`：`totalTokens=0`、`apiUsage=null`、`messageBreakdown=null`；`sessionStats` 只有 `messageCount / promptCount / toolCalls / linesChanged`。
- 模型标识是别名：`lmodel`、`qfmodel`、`byok:qoder-custom-<uuid>/group%2Fauto-deepseek-v4-1-flash`，另有一条 `<synthetic>`。
- IDE 日志里能看到账户级调用：`openapi.qoder.sh` 的 `account.getProfileMetric`（`source: credits-summary`、`region: global`、`status: 200`）与路径 `/sash/api/v2/me/usage`。
- 鉴权材料：`~/.qoder/.auth/` 只有 `machine_id` 与动态文案；疑似 token 存放在 `%APPDATA%\com.qoder.app.stable\auth.v1.dat`（**未验证**能否解码）。

现有读取器在本机的输出（`readQoderUsage(homedir())`）：

```text
2026-11-06 tokens=0 messages=108   client=qoder provider=qoder model=qfmodel
2026-11-07 tokens=0 messages=2     client=qoder provider=qoder model=lmodel
```

## 关键结论

**「再加一个国际版读取器」解决不了问题。** 国际版的会话转录已经在现有读取器的根里（`~/.qoder/projects`），行已经出现、调用次数正确；缺的是可展示的数字——国际版本地没有 token 计数，只有 credits。

### 为什么确定没有 token（复核记录，2026-11-07）

- 转录里 assistant 行的 `usage` 全部字段：`input_tokens=0, cache_creation_input_tokens=0, cache_read_input_tokens=0, output_tokens=0, credits=0.306, original_credits=0.306, billable=false, context_usage_ratio=0.16876, iterations=[]`。
- `~/.qoder/logs/runs/*/qodercli.log` 里 813 行 `input_tokens=0`，**零行非零**；日志内没有其它 token 字面量。
- IDE `main.sqlite`：`chat_session_messages` 无 usage 字段，`chat_session_context_usage` 的 `totalTokens=0` / `apiUsage=null`。
- 唯一非零的相近字段是 `context_usage_ratio`（如 0.84），它是**上下文窗口占用比例**，不是计费 token 数；乘窗口尺寸只能得到估值，本项目不拿估值冒充用量。

因此这条计划不是「找路径」，而是「定语义」：卡片要不要展示 credits，还是展示账户级额度。

## 候选路径

1. **credits 记账（本地、不联网，建议先做）**
   - 读 `usage.credits`（缺失回退 `original_credits`），按日 / 模型 / agent 汇总。
   - 需要决定的点：credits 在卡片上放哪一列（现有卡片是 token + 成本）；`billable: false` 的行是否计入；是否按 credits↔USD 折算（**汇率未知，不能猜**）。
2. **账户级用量/额度接口（联网、需鉴权）**
   - 走项目已有的「本地登录 → 官方接口 → 只回传数值」模式（同 Cursor / Copilot 探针）。
   - 未验证：`auth.v1.dat` 能否读到 token；`credits-summary` / `/sash/api/v2/me/usage` 返回的是额度还是用量；是否属于套餐额度而非会话用量。
3. **IDE sqlite 作为数据源（已排除）**
   - 无 token、无 usage，只有 turnMetrics 与会话统计；不要在这上面继续挖。

## 验收标准

- 国际版会话不再呈现「0 tokens 却有点击数」的矛盾：要么按 credits 展示并标注单位，要么展示账户级用量/额度。
- 不重复计数：同一会话被复制到两个构建根时只计一次（去重作用域是会话文件名 + 消息 id，详见「已实现」）。
- 失败即降级：没有 credits 字段时退回现有「只计调用次数」的行为，不猜数字、不写 0 冒充真实用量。
- 已知未覆盖：趋势图与日归档仍只统计 token，只有 Qoder 国际版一个 agent 的用户会看到空趋势图；模型名（`lmodel` / `qfmodel`）无法对应公开模型 id，成本列为 0。

## 已实现（2026-11-07）

用户选择：两个构建用 `global` 区分（同 Cindy），**本地 credits 与账户额度两种都展示**。

1. **本地会话 → `qoder-global` 独立行**（`electron/qoder-usage.ts`）
   - 根与行的映射：`~/.qoder-cn` → `qoder`，`~/.qoder` → `qoder-global`，`$QODER_CONFIG_DIR` → `qoder`。
   - 读 `usage.credits`（缺失时回退 `original_credits`），逐日/逐模型汇总后写进 payload。
   - 去重键从「路径 + 身份」改为「身份」：同一会话被复制到两个根时只计一次。
   - `usage` 全零且 credits 也为 0 的行仍然丢弃，不制造空记录。
2. **VM 与卡片承载 credits**（`src/lib/agent-usage.ts`、`LocalUsageCard.tsx`、`startup-cache.ts`）
   - `AgentPeriodVM.credits` 贯穿聚合/相加/相减；旧缓存缺该字段时按 0 补。
   - 行内明细追加 `Credits X`；只有 credits 没有 token 的行，token 列显示 `—` 而不是伪 0。
3. **账户额度卡片**（`electron/qoder-quota.ts`、`src/lib/qoder-quota.ts`、`QoderQuotaCard.tsx`）
   - 接口：`GET https://openapi.qoder.sh/sash/api/v2/me/usage`，`Authorization: Bearer <token>`，读 `qoderUsage.userQuota|addOnQuota` 与 `totalUsagePercentage`。本机实测：`used=100,total=200,remaining=100,percent=50,unit=credits,userType=personal_standard`。
   - 凭据：`<userData>\auth.v1.dat` 是 v10（AES-256-GCM），密钥在 `Local State` 的 `os_crypt.encrypted_key`（DPAPI）。Electron 自带的 `safeStorage` **无法**解密另一个应用的 blob（实测失败），所以 **仅 Windows**：子进程调用 PowerShell 的 `ProtectedData.Unprotect` 解包密钥，再由主进程做 AES-GCM 解密；token 只存主进程内存，过期前不重复解包。
   - macOS/Linux 不实现（Keychain / libsecret 是另一套机制），返回 `no-login` 让卡片降级，不猜。
   - 实测：首次 IPC 2201 ms（含 PowerShell + HTTP），二次 1 ms（进程内缓存）。
4. 验收对照：`qoder` 行仍显示 CN 的 token；`qoder-global` 行显示 credits 与调用次数；计划页多一张 Qoder（国际版）credits 额度卡片。

## 下一步

1. 历史库回填 / 去重范围 / 额度卡口径 / BYOK 厂商归属 / 文档同步：已根据 critical review 修正，并有测试或实测覆盖。
2. 已知未覆盖（未做）：趋势图与日归档仍只统计 token，只有 Qoder 国际版一个 agent 的用户会看到空趋势图；模型别名（`lmodel` / `qfmodel`）无法对应公开模型 id，成本列为 0；额度目前只在计划页卡片，若要并进 Agent 用量行需再接一次 IPC。

## 风险

- credits 是 Qoder 内部计价单位，没有公开汇率，**不能折算成 USD**；硬折会给出错误金额。
- 模型别名（`lmodel` / `qfmodel`）无法对应到公开模型 id，价格表匹配不上，成本列只能是 0 或 credits。
- 标识会随渠道变化（`byok:` 前缀、`group%2F` 转义），映射表需要容错。

## 复核方法（只读）

- 看会话转录：`~/.qoder/projects/*/*.jsonl` 里含 `"usage"` 的行，关注 `credits` 与四个 token 计数。
- 看 IDE 库：用 `node:sqlite` 的 `new DatabaseSync(path, { readOnly: true })` 打开 `main.sqlite`，查 `chat_session_messages` / `chat_session_context_usage`。
- 看接口线索：`%APPDATA%\com.qoder.app.stable\logs\*\main.log` 里搜 `credits-summary`、`me/usage`。
