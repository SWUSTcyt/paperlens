from __future__ import annotations

from typing import Any


class ContractError(ValueError):
    """可安全返回给本机客户端的稳定契约错误。"""

    def __init__(
        self,
        code: Any,
        message: str,
        *,
        http_status: int = 400,
        internal_detail: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.http_status = http_status
        # 仅供服务端诊断；序列化函数绝不输出该字段。
        self.internal_detail = internal_detail
