# 项目技能索引

版本：0.1.0。以下技能是随仓库分发的项目级工作指南，位于 `.agents/skills/`，不需要安装到个人全局目录，也不需要额外账号或运行环境。前五个技能改编自 code-foundry 的通用开发方法，并按 PanWatch 的架构、命令和文档路径落地；第六个是 PanWatch 原有的本地隔离验收与交付技能。

## 能力与入口

| 场景 | 技能 | 主要结果落点 |
|---|---|---|
| 新功能、需求澄清或需求变更 | [panwatch-requirements](../.agents/skills/panwatch-requirements/SKILL.md) | `docs/features/` 的需求与验收条件 |
| 技术方案、重构或迁移设计 | [panwatch-design](../.agents/skills/panwatch-design/SKILL.md) | `docs/impls/` 的方案，实施后更新架构 |
| 审查实现或修复的差异 | [panwatch-code-review](../.agents/skills/panwatch-code-review/SKILL.md) | 任务、PR 或实施日志中的 findings |
| 错误、回归或失败测试定位 | [panwatch-debugging](../.agents/skills/panwatch-debugging/SKILL.md) | 任务或实施日志中的复现、证据与修复结果 |
| 任务交付、修复完成或验收 | [panwatch-delivery-verification](../.agents/skills/panwatch-delivery-verification/SKILL.md) | spec/实施记录/PR 中的验收映射与真实结果 |
| 本地隔离实服验收、证据报告与 PR 交付 | [panwatch-local-delivery](../.agents/skills/panwatch-local-delivery/SKILL.md) | 隔离 QA 环境、脱敏报告 ZIP、PR 附件 |

技能目录统一为 `.agents/skills/<技能名>/SKILL.md`。`panwatch-` 前缀用于区分其他项目的同名技能。

## 使用方式

支持项目技能发现的 Agent 可按其实际能力选择技能；不同工具和版本的自动发现与快捷调用方式不作保证。需要把技能暴露给 Codex、Claude、Cursor 或 Gemini 时，可使用 [技能安装脚本](../scripts/install-agent-skills.py)。

通用方式是让 Agent 读取根 `AGENTS.md`，再按本索引读取所需的 `SKILL.md`。可以直接使用下列提示：

- “阅读 `.agents/skills/panwatch-requirements/SKILL.md`，分析这个功能，先给出范围和验收条件。”
- “阅读 `.agents/skills/panwatch-design/SKILL.md`，结合已有需求和代码给出实施方案，暂不实现。”
- “阅读 `.agents/skills/panwatch-code-review/SKILL.md`，评审当前差异，先报告缺陷和依据，不修改代码。”
- “阅读 `.agents/skills/panwatch-debugging/SKILL.md`，定位这个错误，先确认复现和原因。”
- “阅读 `.agents/skills/panwatch-delivery-verification/SKILL.md`，对照验收条件检查当前交付，列明实际执行与未执行项。”
- “阅读 `.agents/skills/panwatch-local-delivery/SKILL.md`，完成本地隔离验收并生成 PR 测试报告。”

新功能通常按需求 → 方案 → 实现 → 评审 → 验证推进。故障可直接进入定位，验证时复用原需求；小修复按实际范围简化，不要求每次调用五个技能。

用户只要求分析、设计或评审时，输出相应结果；不要仅因技能包含文档落点就自行实现代码或扩大写入范围。用户已授权实现或维护文档时，在范围内推进，不增加重复审批环节。

## 与规范、样板和交付技能的关系

- [开发规范](standards/development.md) 定义必须满足的要求。
- [PR 规范](pr-policy.zh-CN.md) 定义贡献范围、证据和自动关闭规则。
- Skills 提供特定任务的方法和证据要求。
- [文档样板](templates/README.md) 承载分析、计划、日志和追溯结果。
- `panwatch-local-delivery` 负责真实本地隔离验收和 PR 报告；前五个技能不替代它的环境隔离、证据打包和附件交付流程。

同一事实保留一处维护：需求在 spec、方案在 plan、执行事实在日志、当前系统结论在架构。技能不能把提案登记为已实施，也不能替代真实测试、人工接受或发布授权。

项目实际代码、命令、用户明确选择和已确认约束是执行依据。发现技能与实际项目不符时按任务范围调整并说明，不隐式替换技术栈、创建不存在的命令或增加外部操作。

## 复制与维护

复制技能时必须保留 `.agents/skills/` 与 `docs/` 的相对位置；技能中的相对链接以所在 `SKILL.md` 为基准。仅复制 `SKILL.md` 到全局目录会使这些项目内链接失效。

后续仅在真实使用发现缺口时调整技能，保留 `name` 和 `description` 的准确触发范围。新增语言或框架的专项技能另行选择，不向通用技能加入具体工具链偏好。

## 当前验证边界

技能已进行结构、命名、相对链接和内容一致性检查；这不证明它们在所有 Agent 中都能自动发现，也不代表真实业务执行或验收通过。详见 [框架落地验证](verification.md)。
