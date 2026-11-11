# 工程脚本说明

脚本从项目根目录运行，处理参数、退出码和中断。`Makefile` 是常用任务的统一入口；直接调用脚本时先确认前置依赖。

## 构建与发布

| 脚本 | 职责 | 调用方式与前置条件 |
|---|---|---|
| `build.sh` | 构建前端、复制静态产物并构建 Docker 镜像 | 通过 `make build VERSION=<version>` 调用；需要 Node、pnpm、Docker |
| `build.ps1` | Windows 上执行同等构建流程 | 通过 `make build VERSION=<version>` 调用；需要 PowerShell、Node、pnpm、Docker |
| `docker_smoke.py` | 在镜像内检查导入、PDF 渲染、截图和 HTTP 启动 | 在容器 `/app` 工作目录运行，仓库只读挂载到 `/checks` |
| `pre_release_check.sh` | 运行后端 unittest、`py_compile` 和前端构建，可选触发 Agent smoke | 需要 `rg`、pnpm 和可用的运行服务；`--with-agent-smoke` 会调用 `BASE_URL`（默认 `http://localhost:8000`） |

`pre_release_check.sh` 使用 `unittest` 发现测试，与 CI 和 `make test` 的 pytest 入口不同；发布前仍应以 CI 和 `make verify` 的结果为准。

## 开发与本地验收

| 脚本 | 职责 | 调用方式与前置条件 |
|---|---|---|
| `install-hooks.sh` | 安装仓库 pre-push hook | `make install-hooks`；hook 在推送前运行 `python -m pytest tests/ -x -q` |
| `pre-push` | pre-push hook 实体 | 由 `install-hooks.sh` 复制到 `.git/hooks/` |
| `test_paper_trading_local.py` | 纸面交易通知的本地端到端测试 | 先启动后端，再传入测试用户名和密码 |
| `evaluate-assistant-runtime.py` | 通过真实 HTTP/task/runtime/approval/DB 路径评测助手 | 需要在隔离 QA 环境中配置模型；固定响应必须使用 `--mode replay` |
| `demo_assistant_context.py` | 不连接模型或数据库的上下文工程演示 | 安装 `pan-agent-runtime` 后运行 |
| `install-agent-skills.py` | 将 `.agents/skills` 以 link/hardlink/copy 方式暴露给受支持的 Agent | 不修改用户个人配置；支持 codex、claude、cursor、gemini |
| `agent_skills_tests/` | 技能安装脚本的测试 | 运行对应测试文件 |

## 任务契约

| 任务 | 命令 | 行为 |
|---|---|---|
| help | `make help` | 列出开发命令，不安装依赖 |
| setup | `make setup-backend` + pnpm install | 准备后端和前端依赖，不隐式升级 |
| run | `make dev-api` / `make dev-web` | 启动后端/前端开发服务器 |
| check | `make check` | 编译检查、前端 UI/i18n/市场色检查和空白符检查 |
| test | `make test` | 后端 pytest；默认不实际发送通知 |
| verify | `make verify` | check + 后端/前端/独立包测试 |
| build | `make build VERSION=<version>` | 构建前端和 Docker 镜像 |
| eval | `make eval` | Agent 过程评测 |
| doctor | `make doctor` | 数据源、AI、通知、DB、磁盘和调度自检 |

不存在的任务不提供无条件成功占位。外部发送、发布和部署需要用户授权。
