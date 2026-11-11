# PanWatch 当前架构

状态：active  
更新时间：2026-11-11  
详细后端规则：[src/ARCHITECTURE.md](../../src/ARCHITECTURE.md)

本文说明当前系统的组成、边界和部署形态。模块级依赖规则、HTTP router 归属和持久化细节以后端架构文档为准，本文不重复。

## 系统形态

PanWatch 是**模块化单体 + 独立前端 + 可复用 Python 包**：

```text
浏览器 / PWA
    │  HTTP / SSE
    ▼
FastAPI 应用（server.py → src/bootstrap）
    ├── src/modules/<domain>   产品业务能力
    ├── src/platform/*         技术基础设施
    └── packages/*             可独立复用的 Python 包
    │
    ├── SQLite（data/ 目录）
    ├── AI 供应商 / 本地 Ollama
    ├── 行情数据供应商
    └── 通知渠道
```

前端构建产物由后端作为静态资源提供，因此生产环境是单个 Docker 容器；前后端也可以分别启动用于开发。

## 仓库组成

| 位置 | 当前职责 |
|---|---|
| `server.py` | 进程入口：初始化数据库、调度器、通知和 FastAPI 应用，启动 Uvicorn |
| `src/bootstrap/application.py` | 唯一创建 `FastAPI` 实例并注册 router 的位置 |
| `src/modules/` | assistant、automation、market、portfolio、research、strategy、paper_trading、reporting、administration、notifications |
| `src/platform/` | persistence、ai、marketdata、events、scheduling、notifications、observability、runtime |
| `src/web/` | 跨模块复用的 HTTP 中间件与响应包装 |
| `packages/marketdata` | 多市场行情抓取、数据源主备故障转移、类型化行情值对象 |
| `packages/pan-agent-runtime` | 与业务无关的 Agent 执行内核：工具循环、审批、暂停/恢复、事件与资源限制 |
| `packages/pan-agent-token-meter` | token 预估与供应商 usage 归一化 |
| `packages/pan-agent-tool-research` | 工具数量增长时的渐进式工具发现 |
| `packages/pan-investment-research` | 基于 LangGraph 的多角色投资研究工作流 |
| `frontend/src/` | React 页面、路由、Hook、i18n 与样式 |
| `frontend/packages/api` | 前端 API 客户端与共享类型 |
| `frontend/packages/base-ui` | 基础 UI 组件 |
| `frontend/packages/biz-ui` | 业务共享 UI 组件 |
| `prompts/` | 分析和 Agent 流程的 Prompt 模板 |
| `tests/`、`frontend/tests/` | 后端/集成/架构/评测测试与前端测试 |

## 后端依赖方向

```text
web ───────────────► modules ───────────────► platform
 │                    │                         │
 │                    └─ public service / DTO ──┘
 └────────────────────────► platform
```

- `platform` 不导入 `modules`，不承载产品或投资决策。
- `modules` 可使用 `platform`，但不能直接导入另一个模块的 ORM models、repository 或 router。
- 跨模块协作通过拥有模块公开的 service、DTO 或 event。
- `web` 只做 HTTP 输入输出映射与服务装配。
- `bootstrap` 只负责启动期装配。
- `tests/test_architecture_boundaries.py` 守卫这些规则。

## 关键运行流程

### 导航级助手

```text
/assistant 页面
  → /api/assistant router
  → AssistantService
  → AgentRuntime（packages/pan-agent-runtime）
  → ModelPort + 已批准 ToolRegistry
  → runtime events → 任务持久化 + SSE → UI
```

`pan_agent` 不得导入 FastAPI、SQLAlchemy、`src.*` 或 LangChain；PanWatch 的适配器、工具和持久化位于 `src/modules/assistant`。

### 定时 Agent

```text
AgentScheduler
  → 交易所日历与 cron/interval 过滤
  → automation agent（盘前/盘中/收盘/TradingAgents）
  → 行情、新闻、上下文与模型调用
  → 运行记录 + 通知渠道
```

### 行情与提醒

```text
modules/market
  → packages/marketdata（供应商路由、主备故障转移、缓存）
  → 采集结果归一化
  → 价格提醒调度器 / 机会与发现
```

## 数据与配置

- SQLite 数据库、日志、截图、Playwright 浏览器和运行时文件位于数据目录（容器内默认 `/app/data`）。
- 全部 SQLAlchemy 表注册在 `src/platform/persistence/models.py`；engine、Session 和 `get_db` 在 `database.py`；版本迁移在 `migrations.py`。
- 配置来自环境变量、`.env`（本地）和应用设置页面；不得把真实密钥提交到仓库。
- 调度与通知静默时段使用进程时区（默认 `Asia/Shanghai`，Docker 需显式设置 `TZ`）；界面展示和提醒到期输入使用浏览器时区。

## 部署与构建

- 生产：多阶段 `Dockerfile` 构建前端和 Python 依赖，最终镜像以 Python 3.11 运行，暴露 `:8000`。
- 本地开发：`make dev-api`（:8000）+ `make dev-web`（:5183，Vite 代理 `/api`）。
- 构建：`make build VERSION=<version>` 调用 `build.sh`（Windows 为 `scripts/build.ps1`），生成 Docker 镜像。
- 发布与镜像工作流见 `.github/workflows/release.yml` 和 `docker-image.yml`。

## 当前架构决定

1. 保持模块化单体，不按领域拆微服务；以模块边界和架构测试控制复杂度。
2. Agent 执行内核、行情层和投资研究流程独立成包，避免与宿主应用、数据库和 Web 框架耦合。
3. 行情抓取只有一条路径：全部经由 `packages/marketdata`，不保留旧采集器的灰度或回退分支。
4. 前端共享组件和 UI 约定优先于页面内重复实现；用户可见文案必须国际化。
5. 数据库 schema 变更只追加可重复执行的新版本迁移，不修改已发布迁移。
6. 真实外部副作用（通知发送、模型计费、发布、部署）必须由用户明确授权。
