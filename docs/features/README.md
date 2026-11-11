# 需求索引

本目录维护用户行为、范围和验收条件。实施方案写入 [实施目录](../impls/README.md)，执行事实写入实施日志，不在这里重复。

## 命名与状态

- 文件名：`<编号>-<主题>.md`，编号使用真实 Issue；无 Issue 时使用 `FEAT-001` 等唯一编号。
- 状态：`draft`、`ready`、`in_progress`、`accepted`、`shipped`、`dropped`。
- 验收条件编号为 `AC-01` 等，必须可观察、可验证，避免“工作正常”等模糊表述。
- 一份需求对应一个事实源；范围变化时修订原文件并保留重要变更记录。

## 活跃需求

当前没有登记中的需求文档。新需求从 [feature-spec 样板](../templates/feature-spec.md) 复制后填写，并在下表登记。

| 编号 | 名称 | 状态 | 负责人 | 实施计划 | 更新时间 |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## 归档

已交付、被替代或取消的需求迁入 [archive/](archive/README.md)。仅在代码写完、评审通过或仍待验收时，不得按已交付归档。

## 相关文档

- [产品目标](../product/vision.md)
- [实施索引](../impls/README.md)
- [开发规范](../standards/development.md)
- [人工验收清单](../tests/smoke.md)
