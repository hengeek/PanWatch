# 实施索引

本目录维护技术方案、执行日志、状态摘要和可交接 brief。需求行为与验收条件在 [需求目录](../features/README.md)，当前系统结论在 [当前架构](../arch/arch.md)。

## 组织方式

| 任务规模 | 产物 |
|---|---|
| 小修复 | 在 Issue/PR 或原任务记录中写清范围、实现与验证，不强制新建目录 |
| 普通功能 | `docs/impls/<编号>-<主题>.md`，可合并方案、日志和交接字段 |
| 大型需求 | `docs/impls/<编号>-<主题>/`，包含 `README.md`（状态摘要）、`plan.md`、`impl_log.md`，按需增加 `briefs/` 与 `trace.md` |

状态：`proposed`、`ready`、`implementing`、`validating`、`completed`、`superseded`。

## 活跃实施

当前没有登记中的实施文档。新任务从 [implementation-plan 样板](../templates/implementation-plan.md) 复制后填写，并在下表登记。

| 编号 | 名称 | 状态 | 负责人 | 需求 | 更新时间 |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## 模板

- [实施方案](../templates/implementation-plan.md)
- [执行日志](../templates/implementation-log.md)
- [项目状态摘要](../templates/project-status.md)
- [单任务 brief](../templates/phase-brief.md)
- [追溯与归档](../templates/trace-and-archive.md)

## 归档

已交付、被替代或取消的实施文档迁入 [archive/](archive/README.md)。归档不授予合并、发布或部署权限。

## 相关文档

- [开发规范](../standards/development.md)
- [技能索引](../skills.md)
- [人工验收清单](../tests/smoke.md)
