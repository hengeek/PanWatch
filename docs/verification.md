# 框架落地验证记录

日期：2026-11-11  
范围：将 code-foundry 0.1.1 的项目规范、Agent 入口、文档骨架和通用技能接入 PanWatch  
分支/基线：`anglerfish` / `97f1813`；本次改动尚未提交  
环境：macOS Darwin 25.3.0；Python 3.11.12（`.venv`）；Node.js 24.14.0（fnm）；pnpm 9.15.9；GNU Make 3.81

本记录覆盖本次文档、技能和 `Makefile` 任务入口的接入及本地可执行检查。没有修改业务代码，也没有执行真实 UI、AI 模型、行情供应商、通知送达或 Docker 镜像验收。

## 执行结果

| 检查 | 命令/方式 | 结果 | 说明 |
|---|---|---|---|
| `foundry.json` 结构 | `python3 -c "import json; json.load(open('foundry.json'))"` | PASS | JSON 可解析，模板版本和实际命令字段存在 |
| 帮助入口 | `make help` | PASS | 列出新增的 `check`、`verify` 与原有命令 |
| 后端语法编译 | `python3 -m compileall -q src server.py packages tests` | PASS | 使用系统 Python 3.11，未导入业务依赖 |
| 空白符/冲突标记 | `git diff --check` | PASS | 无输出 |
| 相对链接 | 自建 Python 链接检查（32 个文件，215 个本地链接） | PASS | 覆盖新增/修改的 Markdown 和六个技能 |
| 技能 frontmatter | 自建 Python 检查 | PASS | 6 个技能 `name` 与目录一致，无重名 |
| 依赖安装 | `python3 -m venv .venv`；`uv pip install -r requirements.txt`；`pnpm install --frozen-lockfile` | PASS | 后端含 TradingAgents v0.7.0 和本地 editable 包；前端 384 个包 |
| `make check` | 整目标 | PASS | 编译、前端 UI/i18n/市场色检查和 `git diff --check` 全部通过 |
| 前端 UI/i18n/市场色检查 | `pnpm check:ui && pnpm check:i18n && pnpm check:market-colors` | PASS | UI primitive、146 个迁移文件的 i18n key、市场颜色检查通过 |
| 后端测试 | `make test`（由 `make verify` 执行） | PASS | 1363 passed，3 skipped，12 warnings，62.18s |
| 前端测试 | `pnpm exec vitest run` | PASS | 72 个测试文件，338 passed，13.38s |
| 独立包测试 | `packages/*/tests`（由 `make verify` 执行） | PASS | marketdata 190、runtime 43、token-meter 3、tool-research 8、investment-research 117，共 361 passed |
| 前端生产构建 | `pnpm build` | PASS | `tsc -b` 与 Vite 构建成功，1934 modules，3.08s |
| 聚合验证 | `make verify` | PASS | 依次完成 check、后端测试、前端测试和五个独立包测试 |
| 构建镜像 | `make build VERSION=<version>` | 未执行 | 本机未执行 Docker 构建 |
| 系统自检 | `make doctor` | 未执行 | 未准备运行数据库和外部服务配置 |
| 真实 UI/外部集成 | 按 [smoke 清单](tests/smoke.md) | 未执行 | 本次未启动服务，也未调用真实模型、行情或通知渠道 |

`make verify` 的 12 条 pytest warning 和前端 React Router/act/browserslist 提示均为非失败告警；没有测试失败。

## 失败与修复

- 首次相对链接检查发现 `docs/verification.md` 尚未创建，创建本文件后复查通过；这不是运行时缺陷。
- 首次后台安装依赖时工作目录停留在 `frontend/`，`uv` 未找到 `requirements.txt`，并误建了 `frontend/.venv`。确认该目录是空 venv 后删除，在仓库根重新创建 `.venv` 并安装成功。
- 后端测试、前端测试和独立包测试均无失败。

## 改动边界

- 新增项目元信息、Agent 入口、开发规范、产品/架构说明、需求/实施/验收文档骨架、文档样板、技能索引和六个项目技能。
- 为 `Makefile` 增加 `check` 与 `verify` 聚合入口，复用现有 pytest、pnpm、compileall 和 `git diff --check`；没有新增隐藏行为或自动提交/发布。
- 在 README、中文 README 和中英文贡献指南中增加文档入口链接。
- 消歧 `panwatch-local-delivery` 对 `AGENTS.md` 的提交限制（版本 1.3.1）：根 `AGENTS.md` 是可提交的项目入口，隔离 QA run 内生成的临时 `AGENTS.md` 不提交。隔离导出脚本继续排除 `AGENTS.md`，避免 QA 环境继承本地规则。
- `CLAUDE.md` 被仓库 `.gitignore` 忽略，仅作为本地入口存在，不进入版本库。

## 未执行项的补齐条件

1. 需要发布或镜像改动时，运行 `make build VERSION=<version>` 和 [Docker smoke](tests/smoke.md#9-docker-与镜像产物)。
2. 需要运行态自检时，配置测试数据库和外部服务后运行 `make doctor`。
3. 需要业务验收时，按 [smoke 清单](tests/smoke.md) 启动真实服务，并单独记录真实模型、行情、通知和 UI 结果。
4. 远程 GitHub Actions 结果需在推送后按实际 run 记录，不能用本地结果代替。

本记录不代表业务功能已验收，也不代表远程 CI 已通过。
