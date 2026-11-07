# 文档索引

> 从 [AGENTS.md](../AGENTS.md) 进入；本页列出全部文档的类别、位置与更新时机。

| 类别 | 位置 | 负责内容 | 何时更新 |
|---|---|---|---|
| 入口 | [AGENTS.md](../AGENTS.md) | 路由、硬规则、命令索引 | 入口、规则或阅读顺序变化时 |
| 项目简介 | [README.md](../README.md) / [README.en-US.md](../README.en-US.md) | 项目是什么、能力范围、安装与快速开始 | 对外介绍或启动方式变化时 |
| 架构事实 | [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层、模块边界、数据流、安全与打包约束 | 模块设计或边界变化时 |
| 开发与操作 | [development.md](./development.md) | 环境、命令、测试与验证、发布、新增 Provider、代码约定 | 操作方式或验证流程变化时 |
| UI / 组件规范 | [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) | 视觉方向、Token、组件规格、动效语言、无障碍 | 视觉规范或组件约定变化时 |
| 当前计划 | [plans/](./plans/) | 进行中方案的优先级与验收标准 | 任务开始、变更、完成时 |
| 历史记录 | [archive/](./archive/) | 已完成的计划、历史调研、旧方案 | 只追加，不参与当前事实 |
| 工作记录 | `.devflow/`（git 忽略） | 过程、审查、临时笔记 | 只追加，不纳入规范 |

## 唯一来源

- 当前架构事实只在 [ARCHITECTURE.md](./ARCHITECTURE.md)。
- 命令、测试与发布只在 [development.md](./development.md)。
- 视觉与组件规范只在 [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)。
- 发布历史只在 [CHANGELOG.md](../CHANGELOG.md)。
- 计划状态只在 `docs/plans/`；已完成方案移到 `docs/archive/`。

## 当前状态

- 进行中的计划：[qoder-global-usage.md](./plans/qoder-global-usage.md)（Qoder 国际版用量读取；新增计划请放 `docs/plans/<slug>.md`，并在 [AGENTS.md](../AGENTS.md) 的必读顺序中登记）。
- 归档内容：见 [archive/](./archive/)。
