"""跨模块复用的请求认证上下文。

认证本身由 ``modules/administration/api/auth.py`` 负责。业务模块不应直接导入
另一个模块的 ``api`` 包，因此这里只暴露一个读取请求状态的轻量依赖。
"""

from __future__ import annotations

from fastapi import Request


def get_current_actor(request: Request) -> str | None:
    """返回已通过认证的调用者标识；未启用认证时为 ``None``。"""
    return getattr(request.state, "user", None)
