# Token Monitor 接口调研（集成参考）

> 调研对象：[Javis603/token-monitor](https://github.com/Javis603/token-monitor)（MIT）。原本地快照 `token-monitor/` 已在调研完成后删除，文中所有 `文件:行号` 引用对应上游 commit `c493a20`（feat(kimi): integrate Kimi Work usage and project attribution, #453），需要复核时重新 clone 该 commit 即可。
> 目的：为 coding-usage 桌面化改造与后续集成提供接口契约依据。
> 结论以 **源码核对** 为准（标注 `文件:行号`），上游自带文档（`docs/API.md`、`worker/README.md`）为辅助；两者冲突处见 §10。核对基准日期：2026-08。

## 1. 项目与架构速览

Token Monitor 是 AI 编码工具用量监控悬浮组件（Electron），核心分三块，共享一套 Hub 协议：

```text
widget (Electron, src/electron/main.js)     ──本地模式──▶ tokscale ──▶ ~/.claude、~/.codex 等本地日志
headless agent (src/agent/agent.js)         ──┐
widget 同步模式 (client/host)                ──┴──POST /api/ingest──▶ Hub ──SSE /api/stats/stream──▶ 各端 widget
```

Hub 有三种可互换实现，**对外说同一个 HTTP 协议**：

| 形态 | 入口 | 存储 | 说明 |
|---|---|---|---|
| Node Hub | `npm run hub`，`src/hub/server.js` | `data/devices.json` | 自托管，默认端口 `17321` |
| Cloudflare Worker | `worker/src/index.js` + Durable Object | DO SQLite | 免运维公网部署，iOS 小组件可达 |
| Widget 内嵌 Host | widget 设置里"Host hub on this device"，复用 `createHub()`（`src/electron/main.js:2825`） | Electron `userData/hub-devices.json` | 随 widget 存活 |

## 2. 端点总表

| 方法 | 路径 | 鉴权 | 可用范围 | 用途 |
|---|---|---|---|---|
| OPTIONS | `*` | 无 | 两端 | CORS 预检，204 |
| GET | `/api/health` | 无 | 两端 | 存活探测 + 设备数 + 构建标识 |
| POST | `/api/ingest` | secret | 两端 | 上报/更新一台设备的用量快照（upsert） |
| GET | `/api/stats` | secret | 两端 | 聚合统计（today/month/allTime + limits + devices） |
| GET | `/api/stats/stream` | secret | 两端 | SSE 推送，ingest/delete/subscriptions 即时广播 |
| GET | `/api/devices` | secret | 两端 | 全部设备原始记录 |
| DELETE | `/api/devices/:id` | secret | 两端 | 删除设备记录（目标不存在也返回 200，`server.js:259`） |
| GET | `/api/history` | secret | 两端 | 历史趋势聚合 ⚠️ 官方 API.md 无此章节 |
| GET | `/api/subscriptions` | secret | 两端 | 读取共享订阅清单 |
| PUT | `/api/subscriptions` | secret | 两端 | 整体替换订阅清单（乐观锁） |
| GET/HEAD | `/api/public/stats` | 无（需开关） | **仅 Worker** | 公开脱敏统计，供公开面板/iOS 小组件 |

## 3. 鉴权

三种凭据通道（按优先级）：

1. `Authorization: Bearer <secret>` —— 两端支持，推荐；
2. `X-Token-Monitor-Secret: <secret>` 头 —— 两端支持（`src/shared/http.js:61-65`）;
3. `?secret=<secret>` 查询串 —— **仅 Worker 支持**（`worker/src/index.js:31-34`），为 iOS WKWebView 无法过 CORS 预检的兜底。

未配置 secret 时的行为两端完全不同（集成时的最大坑）：

- **Worker**：所有数据路由返回 `503 {"error":"secret_required"}`，只有 health 和开启后的 public/stats 可访问（`worker/src/index.js:186-188`）；
- **Node Hub**：`isAuthorized` 对空期望密钥恒真 → **完全开放访问**，但强制只绑 `127.0.0.1`（`src/shared/http.js:68`、`src/hub/server.js:28-29,313`）。配置了 secret 才允许绑 `0.0.0.0`。

Widget 内嵌 Host 模式永不落入开放分支：secret 缺省时随机生成 24 字节 base64url 并持久化到设置（`main.js:431-437`）。

## 4. 端点详情

### GET /api/health

免鉴权。响应（字段名两端一致，取值随运行时而异）：

```json
{
  "ok": true,
  "role": "hub",
  "runtime": "node-hub",            // Worker 为 "cloudflare-worker"
  "version": 1,
  "hubBuild": { "schemaVersion": 1, "coreRevision": 1, "coreBuildId": "sha256:…", "runtimeRevision": 1, "runtimeBuildId": "sha256:…" },
  "deviceCount": 2,
  "secretRequired": true,
  "now": "2026-05-18T00:00:00.000Z"
}
```

`hubBuild` 是内容派生的部署指纹，用于新旧版本比对；缺失视为旧版兼容，畸形视为未知而非旧版。

### POST /api/ingest

上报一台设备的用量快照，Hub 归一化后 upsert。响应 `{"ok":true,"deviceId":"…","stats":{…}}`。

请求体核心结构（完整契约见上游 `docs/API.md`，此处只列集成要关心的骨架）：

```jsonc
{
  "deviceId": "macbook",             // 必填，缺省 400 deviceId_required
  "hostname": "…", "platform": "darwin-arm64",
  "osName": "macOS", "osVersion": "26.0",
  "updatedAt": "ISO 时间戳",
  "agentVersion": "…", "agentRuntime": "headless-agent",
  "syncUploadIntervalMs": 1200000,   // 0/缺省=实时上传
  "projectsEnabled": true, "historyAvailable": true,
  "trackedClients": ["codex"],       // 声明采集范围，缺席客户端保留历史不清零
  "today":    { "totalTokens": 0, "costUsd": 0, "clients": {}, "clientCosts": {},
                 "models": {}, "modelCosts": {}, "sessions": { … }, /* 缓存/输出细分同构 */ },
  "month":    { … }, "allTime": { …, "projects": { … } },
  "periodWindows": {                  // today/month 窗口的本地时区截止时间，过期即从聚合中剔除
    "timeZone": "Asia/Hong_Kong",
    "today": { "key": "2026-05-18", "endsAt": "…" }, "month": { "key": "2026-05", "endsAt": "…" } },
  "limits": {                         // 可选；原始凭据与供应商响应体禁止上送
    "updatedAt": "…", "refreshMs": 300000,
    "providers": [ {
      "provider": "claude",           // 枚举见 §5
      "accountKey": "sha256:…",       // 跨设备去重键
      "status": "ok", "source": "oauth",
      "windows": [ { "kind": "session", "usedPercent": 42, "resetsAt": "…" } ],
      "balanceUsd": null, "balance": { … }
    } ]
  },
  "clientHealth": { … }               // 可选逐客户端诊断，见官方文档
}
```

要点：

- 请求体上限：Node Hub 1 MiB（UTF-8 字节），超限 `413 payload_too_large`；**Worker 代码层无对应限制**（`worker/src/index.js:227-230`）。
- `today.sessions` / 会话明细是有界同步，超预算时设备会置 `sessionDetailsOmitted` / `periodProjectsOmitted` 等诊断位；消费端必须容忍字段缺失。
- `limits-only` 更新（只刷新额度）会沿用上次用量并前推诊断字段。

### GET /api/stats

聚合快照，是我们做仪表盘最常用的只读端点。响应顶层：

- `staleAfterMs`：设备陈旧阈值（默认 10 分钟）
- `periods.{today,month,allTime}`：跨设备合计，每周期 `{totalTokens, costUsd, clients{}, clientCosts{}, models{}, modelCosts{}, clientModels{}, sessions{}, projects{}}`
- `historyPreview`、`historyRevision`、`deviceHistoryRevision`
- `subscriptionsUpdatedAt`：共享订阅版本戳（`""` 表示从未写入；public 端点不含）
- `limits.providers[]`：按账号聚合的额度状态，附 `sourceDeviceId`、`stale`
- `devices[]`：各设备归一化记录 + `receivedAt`/`ageMs`/`stale`/`periodWindows`

同一账号多设备上报时，Hub 只保留最新有效的额度状态。

### GET /api/stats/stream（SSE）

⚠️ 上游任何文档均未成文记载，以下为代码核对结论（`src/hub/server.js:80-97,202-216`；Worker 同构 `worker/src/index.js:117-129,205-225`）：

- 连接建立立刻推送 `snapshot` 事件；此后每次 ingest/删除/订阅变更广播 `stats` 事件；
- 帧格式：

```text
event: snapshot          // 或 stats
data: {"type":"stats","reason":"snapshot","stats":{…GET /api/stats 同构…},"at":"ISO"}

```

- `reason` 枚举：`snapshot` / `ingest` / `delete` / `subscriptions`；
- 心跳：每 30 秒一行注释 `: hb`；无 `retry:` 字段，客户端自行重连；
- **CORS 差异**：Worker 的 SSE 响应带 CORS 头，**Node Hub 的 SSE 响应不带**（`server.js:203-208` 手写 writeHead 漏加）——浏览器页面直连 Node Hub 读 SSE 会被拦，桌面主进程发起则不受影响。

### GET /api/history ⚠️ 未记载端点

两端均实现（`server.js:200`、`worker/src/index.js:200-203`），返回历史趋势聚合；widget 在 hub 模式经 `src/electron/historySource.js:111` 消费。`docs/API.md` 没有该章节（其 `docs/export.md:117` 引用的是死链）。集成时按 `GET` + secret 调用即可，响应结构与 `historyPreview` 同族。

### GET/PUT /api/subscriptions

订阅记录是 **Hub 级共享单例**（不属于任何设备记录）：

- `GET` 返回 `{ok:true, version:1, updatedAt:"…", subscriptions:[…]}`；
- `PUT` 体为 `{subscriptions:[…], baseUpdatedAt:"<上次读到的 updatedAt>"}`：
  - 非数组 / 不支持的币种（仅 USD/TWD/HKD/CNY）→ `400` 且不落盘；
  - `baseUpdatedAt` 不匹配 → `409 stale_write`，响应携带当前文档供重新定基；
  - 成功 → 200 返回存储后文档，并向所有 SSE 客户端广播 `reason:"subscriptions"`。
- `amountMinor` 为最小货币单位整数（分的百倍语义：hundredths）；`topUps[]` 为 `{id,date,amountMinor}` 新在前。

### GET/HEAD /api/public/stats（仅 Worker）

- 开关：env `PUBLIC_STATS_ENABLED ∈ {1,true,yes,on}`（大小写不敏感）；关闭时返回 `404 not_found`；
- 开启后剥离：整个 `devices[]`、原始 `limits`/`periods` 替换为 `publicLimits`/`publicPeriods`——删除账号身份字段（`accountKey`、`accountEmail`、`planLabel` 等）、项目映射与会话归属；不含 `subscriptionsUpdatedAt`；
- 缓存头 `public, max-age=15`。

## 5. limits 数据模型速查

`limits.providers[].provider` 权威枚举以代码为准（`src/shared/limitProviders.js:5-10`，共 22 家；`docs/API.md:308` 的列表漏了 `trae`）：
`claude, codex, opencode, cursor, antigravity, kimi, grok, copilot, commandcode, mimo, zai, zaiteam, kiro, workbuddy, qoder, deepseek, openrouter, minimax, volcengine, ollama, trae, thirdparty`

- `windows[].kind`：`session` / `weekly` / `billing`；百分比窗口带 `usedPercent/remainingPercent/resetsAt`；
- `windows[].metric`：`credits`=余额类（headline 是金额 `remaining`+`currency`，非百分比）、`spend`=已消费金额；
- `balance` 结构按 provider 而异（DeepSeek 带 today/month/allTime spend，OpenRouter 带 weekSpend 等，Claude 预付池带 `tranches[]`）——渲染余额一律走 `metric === 'credits'` 判断，勿按 provider 名硬编码（上游约定，值得沿用）。

## 6. 配置环境变量（集成相关子集）

连接/设备（agent 与同步模式共用，`.env.example`）：
`TOKEN_MONITOR_HUB_URL`、`TOKEN_MONITOR_SECRET`、`TOKEN_MONITOR_DEVICE_ID`（默认主机名）、`TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS`

自托管 Node Hub：`TOKEN_MONITOR_PORT`(17321)、`TOKEN_MONITOR_HOST`、`TOKEN_MONITOR_STALE_AFTER_MS`、`TOKEN_MONITOR_DATA_FILE`；CLI 参数同名（`--port/--host/--secret/--staleAfterMs/--dataFile`）。⚠️ 这四个在 `.env.example` 中未列出（`server.js:302-306`）。

Worker：`PUBLIC_STATS_ENABLED`、`STALE_AFTER_MS`（wrangler secrets 方式配置）。

## 7. 数据导出文件格式

手动导出与自动导出写出同一套文件（`docs/export.md`）：

- `token-monitor-export.json`：`{generatedAt, app{name,version}, snapshot:{today,month,allTime}, daily[]?, monthly[]?}`，序列项含日期键、tokens、cost 与 `perClient/perModel` 明细；
- `token-monitor-snapshot.csv`：列 `period,dimension,name,tokens,cost_usd`；
- `token-monitor-daily.csv`：列 `date,tool,tokens,cost_usd`（约最近 370 天，多设备为当日合计、无设备列）；
- CSV 均 UTF-8 带 BOM、RFC 4180；成本恒为 USD；不含设备标识与账号信息。

## 8. Node Hub 与 Worker 行为差异对照

| 维度 | Node Hub | Cloudflare Worker |
|---|---|---|
| `?secret=` 查询串 | ❌ 不支持 | ✅ 支持 |
| 未配 secret | 开放访问 + 强制 loopback 绑定 | 所有数据路由 503 `secret_required` |
| `/api/public/stats` | ❌ | ✅（开关控制，关=404） |
| HEAD 方法 | ❌（404） | ✅ health/stats/devices/history/public |
| 请求体上限 | 1 MiB → 413 | 代码层无限制 |
| SSE CORS 头 | ❌ 缺失 | ✅ |
| health `runtime` | `"node-hub"` | `"cloudflare-worker"` |
| 异常响应 | 500 `{error:"internal_error"}` | 平台默认（无自定义 JSON） |
| 存储 | `data/devices.json` | Durable Object SQLite（`dev:<id>` 键） |

## 9. 错误码汇总

| 状态码 | error 值 | 场景 |
|---|---|---|
| 400 | `deviceId_required` / `bad_request` | ingest 缺 ID；JSON 解析失败、订阅非数组、币种不支持 |
| 401 | `unauthorized` | secret 不匹配 |
| 404 | `not_found` | 未知路由；未开启的 public/stats |
| 409 | `stale_write` | 订阅 PUT 版本冲突（响应体带当前文档） |
| 413 | `payload_too_large` | Node Hub 超 1 MiB |
| 500 | `internal_error` | Node Hub 未捕获异常 |
| 503 | `secret_required` | Worker 未配置 secret |

## 10. 上游文档 vs 实现差异清单（踩坑预警）

1. `GET /api/history` 两端都存在，`docs/API.md` 无章节；`docs/export.md:117` 的引用是死链；
2. SSE 协议（事件名/reason 枚举/心跳）任何上游文档均未记载，本文档 §4 为唯一成文来源；
3. worker/README.md 的端点表漏掉 `GET/PUT /api/subscriptions` 与 `GET /api/history`（代码均存在）；
4. "`?secret=` 三通道"的说法仅对 Worker 成立，Node Hub 只认两种头；
5. "未配 secret 返回 503"仅 Worker 成立，Node Hub 是开放访问 + loopback 绑定；
6. `docs/API.md` health 示例固定写 `"runtime":"cloudflare-worker"`，Node Hub 实际返回 `"node-hub"`；
7. "1 MiB 上限"表述未区分两端，Worker 实际无代码级限制；
8. `docs/API.md:308` 的 limits provider 枚举漏了 `trae`（Trae CN，实现在 `src/shared/traeLimits.js`，走 `https://api.trae.cn`）。

## 11. 与本项目的集成路径建议

- **A. 做 Hub 的只读消费端（最快见效）**：部署/复用一个 token-monitor Hub，我们的桌面端轮询 `GET /api/stats` 或订阅 SSE，即可在现有"提供商额度"之外增加"本地编码真实用量"（Claude Code/Codex/OpenCode 等 30+ 工具）视图。桌面主进程发请求可无视 Node Hub SSE 缺 CORS 头的问题。
- **B. 协议级共存**：若未来做多设备聚合，直接说这套协议（ingest + stats + stream），可与其生态互通，不必自造同步层。
- **C. 本地采集自研**：长期如需脱离 Hub 单机展示，可借鉴其 collector 思路（调用 `tokscale` CLI 读本地日志），与我们现有的 provider API 轮询互补——它管"本地烧了多少 token"，我们管"云端额度还剩多少"。

## 12. 桌面化技术栈结论（详见评审对话）

推荐 **Electron（electron-vite + electron-builder）**：纯 TS 团队迁移成本最低，主进程 `net.fetch` 天然绕开 CORS（可删除 `proxy.mjs`），safeStorage(DPAPI) 加密存 key，托盘/全局快捷键/置顶小窗/开机自启/自动更新全内置；同构产品 token-monitor 本身即 Electron 栈实证可行。代价：安装包与内存大一个量级、分发需 Authenticode 证书、每 8 周安全跟进。Tauri 2.x 为备选（体积 3–10 MB 但引入 Rust 工具链，密钥存储插件生态较弱）。
