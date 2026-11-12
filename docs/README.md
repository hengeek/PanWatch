# PanWatch 文档导航

本目录同时承载产品说明、开发规范、需求/实施记录和验收证据。同一事实只维护一处，其他文档通过链接引用。

## 产品与对外说明

| 文档 | 内容 |
|---|---|
| [产品目标](product/vision.md) | 目标用户、产品目标、范围与成功标准 |
| [助手能力](assistant-capabilities.md) / [中文](assistant-capabilities.zh-CN.md) | 导航级助手的能力与边界 |
| [TradingAgents 流程](tradingagents-flow.md) / [English](tradingagents-flow.en.md) | 多 Agent 深度分析流程 |
| [时区策略](timezones.md) / [中文](timezones.zh-CN.md) | 调度、展示与到期时间的时区规则 |
| [PR 范围与验收规范](pr-policy.md) / [中文](pr-policy.zh-CN.md) | 贡献范围、证据和自动关闭规则 |

## 架构与开发规范

| 文档 | 内容 |
|---|---|
| [当前架构](arch/arch.md) | 系统组成、仓库地图、依赖边界与部署形态 |
| [后端架构](../src/ARCHITECTURE.md) / [English](../src/ARCHITECTURE.en.md) | 后端模块、平台层、HTTP 边界与持久化细则 |
| [开发规范](standards/development.md) | 项目级必须/建议/可选规则与任务契约 |
| [贡献指南](../CONTRIBUTING.zh-CN.md) / [English](../CONTRIBUTING.md) | 环境、流程、测试与 PR 要求 |
| [统一 UI 约定](../frontend/UI_GUIDELINES.zh-CN.md) / [English](../frontend/UI_GUIDELINES.md) | 共享组件、交互与视觉验收 |

## 需求、实施与验收

| 目录/文档 | 内容 |
|---|---|
| [需求索引](features/README.md) | 活跃需求 spec 与归档入口 |
| [实施索引](impls/README.md) | 实施计划、执行日志与归档入口 |
| [人工验收清单](tests/smoke.md) | 启动、组合、行情、提醒、Agent、通知与 PWA 的 smoke 步骤 |
| [框架落地验证](verification.md) | 本次文档与技能接入的检查记录 |
| [文档样板](templates/README.md) | spec、plan、状态摘要、brief、日志和追溯样板 |

## Agent 入口与技能

| 文档 | 内容 |
|---|---|
| [AGENTS](../AGENTS.md) | AI 阅读顺序、项目地图、真实命令与执行边界 |
| [技能索引](skills.md) | 六个项目内技能的触发场景、结果落点与使用方式 |
| [脚本说明](../scripts/README.md) | 工程脚本职责、调用方式与前置条件 |

## 素材与历史

- [`design/`](design/README.md)：pen.dev 可编辑设计源文件（`.pen`），是界面设计的事实源。
- `prototypes/`：设计稿导出的 PNG，用于评审、文档展示和无法打开 pen.dev 的场景。
- `screenshots/`、`diagrams/`、`sponsors/`、`donate/`：对外文档使用的图片资源。
- 已交付、被替代或取消的需求与实施文档迁入对应 `archive/`，索引保留链接。
- `docs/superpowers/` 与 `.superpowers/` 为本地设计记录，已被 `.gitignore` 忽略，不属于版本库事实源。
