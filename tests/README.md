# 后端测试说明

测试使用 pytest，默认从项目根目录运行。测试必须模拟网络、AI、行情和通知调用，不依赖付费 API，不实际发送通知。

## 常用命令

```bash
make test                                   # tests/ 全部用例，默认不发通知
.venv/bin/python -m pytest tests/test_xxx.py -v
.venv/bin/python -m pytest tests/ -q --notify   # 实际发送通知，需明确授权
make eval                                   # Agent 过程评测
```

`pyproject.toml` 指定 `testpaths = ["tests"]`、文件 `test_*.py`、类 `Test*`、函数 `test_*`。

## 目录约定

| 位置 | 内容 |
|---|---|
| `tests/test_architecture_boundaries.py` | 模块依赖边界守卫；修改模块结构时同步更新 |
| `tests/test_*.py` | 后端、集成、API、持久化、调度、通知和评测用例 |
| `tests/eval/` | Agent 过程评测脚本与用例 |
| `packages/*/tests/` | 独立包的测试，由 `make verify` 和 CI 一并执行 |
| `frontend/tests/` | 前端 Vitest 与 Testing Library 测试，不属于 pytest |

## 编写要求

- 断言真实行为，不为通过而跳过断言、吞掉异常或删除用例。
- 外部调用使用可控的假实现或 fixture；需要真实模型、行情或通知时单独标记并取得授权。
- 数据库测试使用隔离的临时库，不写入用户数据目录。
- 涉及迁移时验证可重复执行和旧版本兼容。
- 前端用户可见行为变化时，同时补对应 Vitest 用例并更新中英文资源。
