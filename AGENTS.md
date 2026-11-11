# PanWatch Agent 指南

PanWatch 是自托管 AI 股票监控与研究平台。后端为 FastAPI 模块化单体，前端为 React + Vite PWA，另有可独立复用的 Python 包。本文件是 AI 开发入口；详细规则维护在对应文档中，不在这里复制第二份。

## 阅读顺序

1. [README](README.md)：产品能力、快速开始与实际运行方式。
2. [开发规范](docs/standards/development.md)、[贡献指南](CONTRIBUTING.zh-CN.md) 和 [PR 范围与验收规范](docs/pr-policy.zh-CN.md)。
3. [当前架构](docs/arch/arch.md)；修改后端边界前再读 [后端架构](src/ARCHITECTURE.md)。
4. 本次任务的需求与实施方案；大型任务先读状态摘要，再读当前 brief。
5. [文档导航](docs/README.md) 与 [技能索引](docs/skills.md)。

## 项目地图

| 路径 | 职责 |
|---|---|
| `server.py` | 后端服务入口：启动 FastAPI、数据库、调度器与通知 |
| `src/bootstrap/` | 唯一创建 FastAPI 应用和装配 router 的位置 |
| `src/modules/` | 产品业务能力：assistant、automation、market、portfolio、research、strategy、paper_trading、reporting、administration、notifications |
| `src/platform/` | 与技术相关的基础设施：AI、持久化、行情、事件、调度、通知、可观测、运行时 |
| `src/web/` | 跨模块复用的 HTTP 中间件与响应适配 |
| `packages/` | 可独立复用的 Python 包：行情、Agent runtime、token 计量、工具检索、投资研究 |
| `frontend/src/` | React 页面、组件、Hook、路由与 i18n |
| `frontend/packages/` | 前端共享 API、基础 UI 与业务 UI 包 |
| `prompts/` | 分析流程使用的 Prompt 模板 |
| `tests/` | 后端、集成、架构边界与评测测试 |
| `frontend/tests/` | Vitest 与 Testing Library 测试 |
| `docs/` | 对外文档、开发规范、需求/实施/验收记录、图表与截图 |
| `.agents/skills/` | 项目内 Agent 技能，随仓库分发 |

`foundry.json` 记录项目元信息、技术栈和真实命令；`null` 表示尚未配置，不代表默认通过。

## 常用命令

```bash
make help              # 查看全部开发命令
make setup-backend     # 创建 .venv 并安装后端依赖
make dev-api           # 启动后端（:8000）
make dev-web           # 安装前端依赖并启动前端（:5183）
make check             # 后端编译检查、前端 UI/i18n/市场色检查、git diff --check
make test              # 后端 pytest（默认不实际发送通知）
make verify            # check + 后端测试 + 前端测试 + packages/*/tests
make eval              # Agent 过程评测（chat 用例需要 EVAL_AI_*）
make doctor            # 数据源/AI/通知/DB/磁盘/调度自检
make build VERSION=x   # 构建前端与 Docker 镜像
make install-hooks     # 安装 pre-push 测试钩子
```

`make verify` 通过不等于业务验收完成；真实 UI、外部行情、AI 模型和通知送达需按 [smoke 清单](docs/tests/smoke.md) 单独验证。

## 架构与实现约束

- 依赖方向：`web → modules → platform`。`platform` 不导入 `modules`；模块之间只通过公开 service、DTO 或 event 协作，不直接导入对方的 ORM models、repository 或 router。
- 不得恢复已删除的 `src/collectors/`、`src/models/`、`src/compat/` 或 `src/web/api/` 等旧目录。
- `bootstrap/application.py` 只做装配，不承载领域规则、SQL 或 Agent 执行循环。
- 修改模块边界时必须同步更新 `tests/test_architecture_boundaries.py` 和文档。
- 新增 AI、行情或通知供应商放入对应 `platform/*` adapter；新增业务工作流放入对应 `modules/<domain>` service。
- 前端交互先读 [统一 UI 约定](frontend/UI_GUIDELINES.zh-CN.md)，复用共享组件；用户可见文案同步中英文 i18n 资源。
- 数据库变更先定行为和测试，再注册表并添加可重复执行的新版本迁移；不修改已发布迁移。

## 公共开发技能

根据任务读取对应 `SKILL.md`，不要预先加载全部技能：

| 场景 | 技能 |
|---|---|
| 新需求、需求澄清或变更 | [panwatch-requirements](.agents/skills/panwatch-requirements/SKILL.md) |
| 技术方案、重构或迁移 | [panwatch-design](.agents/skills/panwatch-design/SKILL.md) |
| 实现或修复评审 | [panwatch-code-review](.agents/skills/panwatch-code-review/SKILL.md) |
| 错误、回归或失败测试 | [panwatch-debugging](.agents/skills/panwatch-debugging/SKILL.md) |
| 交付与验收 | [panwatch-delivery-verification](.agents/skills/panwatch-delivery-verification/SKILL.md) |
| 本地隔离 QA、证据报告与 PR 交付 | [panwatch-local-delivery](.agents/skills/panwatch-local-delivery/SKILL.md) |

前五个技能提供通用方法，`panwatch-local-delivery` 负责 PanWatch 的本地隔离实服验收与 PR 报告。用户只要求分析、设计或评审时保持该范围，不自行实现代码或扩大写入范围。

## 执行规则

- 保留用户已有修改。小修复记录范围与验证；普通功能使用 spec + plan；大型任务再增加状态摘要、日志与 brief。
- 验证记录区分 `PASS`、`FAIL`、`未执行`，写明环境、版本、命令、范围和证据。评审通过不等于业务验收完成。
- 不虚构命令、Issue、检查、CI 结果、真实模型调用或通知送达。
- 测试必须模拟网络与外部服务，不依赖付费 API，不实际发送通知；需要真实外部调用时另行取得授权。
- 更新需求/实施索引与当前架构；按开发规范归档已交付、被替代或取消的文档。
- 不提交密钥、私人持仓、本地数据库、生成报告、缓存或 `.env`。对外发送、合并、发布和部署遵循用户授权。
- 多任务并行时明确文件归属、公共文件所有者和集成顺序；最终集成后重跑受影响检查。

`CLAUDE.md` 是本仓库被 `.gitignore` 忽略的本地入口，只引用本文件，不维护第二套规则。
