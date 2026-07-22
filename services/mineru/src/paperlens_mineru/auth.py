from __future__ import annotations

import secrets

from .contracts import ErrorCode
from .errors import ContractError


def require_bearer_token(authorization: str | None, expected_token: str) -> None:
    """使用常量时间比较验证本地服务凭证，错误消息不反射输入。"""

    if not authorization or not authorization.startswith("Bearer "):
        raise ContractError(ErrorCode.AUTH_REQUIRED, "需要本地服务访问凭证。", http_status=401)
    supplied = authorization.removeprefix("Bearer ")
    if not supplied or not secrets.compare_digest(supplied, expected_token):
        raise ContractError(ErrorCode.AUTH_INVALID, "本地服务访问凭证无效。", http_status=401)
