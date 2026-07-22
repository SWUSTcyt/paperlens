from __future__ import annotations

import os
import re
import secrets
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, cast


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17860
MINERU_VERSION = "3.4.4"
BACKEND = "pipeline"
DEFAULT_MAX_BYTES = 200 * 1024 * 1024
DEFAULT_MAX_PAGES = 500
DEFAULT_TASK_TIMEOUT_SECONDS = 30 * 60
DEFAULT_TTL_SECONDS = 24 * 60 * 60
DEFAULT_MAX_CONCURRENT_JOBS = 1

_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
_SECTIONS = {
    "server": {"host", "port"},
    "auth": {"token"},
    "storage": {"root"},
}
_ENV_KEYS = {
    "PAPERLENS_MINERU_HOST",
    "PAPERLENS_MINERU_PORT",
    "PAPERLENS_MINERU_TOKEN",
    "PAPERLENS_MINERU_DATA_ROOT",
}


class ConfigError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ServiceConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    access_token: str = field(default="", repr=False)
    data_root: Path = field(default_factory=lambda: _default_data_root(os.environ))
    mineru_version: str = MINERU_VERSION
    backend: str = BACKEND
    max_concurrent_jobs: int = DEFAULT_MAX_CONCURRENT_JOBS
    max_pdf_bytes: int = DEFAULT_MAX_BYTES
    max_pdf_pages: int = DEFAULT_MAX_PAGES
    task_timeout_seconds: int = DEFAULT_TASK_TIMEOUT_SECONDS
    result_ttl_seconds: int = DEFAULT_TTL_SECONDS

    def safe_dict(self) -> dict[str, object]:
        return {
            "host": self.host,
            "port": self.port,
            "access_token": "<redacted>",
            "data_root": str(self.data_root),
            "mineru_version": self.mineru_version,
            "backend": self.backend,
            "max_concurrent_jobs": self.max_concurrent_jobs,
            "max_pdf_bytes": self.max_pdf_bytes,
            "max_pdf_pages": self.max_pdf_pages,
            "task_timeout_seconds": self.task_timeout_seconds,
            "result_ttl_seconds": self.result_ttl_seconds,
        }


def generate_access_token() -> str:
    """生成可粘贴到扩展设置中的随机本地访问凭证。"""

    return secrets.token_urlsafe(32)


def load_config(
    config_path: str | Path | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> ServiceConfig:
    """按 默认值 < TOML < 环境变量 加载安全配置。"""

    env = dict(os.environ if environ is None else environ)
    raw: dict[str, object] = {}
    if config_path is not None:
        path = Path(config_path)
        try:
            with path.open("rb") as stream:
                parsed = tomllib.load(stream)
        except (OSError, tomllib.TOMLDecodeError) as error:
            raise ConfigError("CONFIG_FILE_INVALID", "无法读取本地服务配置文件。") from error
        _reject_unknown_config(parsed)
        raw = parsed

    host = _string_value(raw, "server", "host", DEFAULT_HOST)
    port_value: object = _value(raw, "server", "port", DEFAULT_PORT)
    token = _string_value(raw, "auth", "token", "")
    root_value: object = _value(raw, "storage", "root", str(_default_data_root(env)))

    unknown_env = sorted(key for key in env if key.startswith("PAPERLENS_MINERU_") and key not in _ENV_KEYS)
    if unknown_env:
        raise ConfigError("CONFIG_UNKNOWN_KEY", f"不支持的环境变量：{unknown_env[0]}。")

    host = env.get("PAPERLENS_MINERU_HOST", host)
    port_value = env.get("PAPERLENS_MINERU_PORT", port_value)
    token = env.get("PAPERLENS_MINERU_TOKEN", token)
    root_value = env.get("PAPERLENS_MINERU_DATA_ROOT", root_value)

    if host != DEFAULT_HOST:
        raise ConfigError("CONFIG_HOST_FORBIDDEN", "服务只允许绑定 127.0.0.1。")
    port = _parse_port(port_value)
    if not _TOKEN_PATTERN.fullmatch(token):
        raise ConfigError("CONFIG_TOKEN_INVALID", "访问 token 必须是至少 32 位的 URL-safe 随机字符串。")
    if not isinstance(root_value, str) or not root_value.strip():
        raise ConfigError("CONFIG_STORAGE_INVALID", "存储目录必须是非空绝对路径。")
    data_root = Path(root_value).expanduser()
    if not data_root.is_absolute():
        raise ConfigError("CONFIG_STORAGE_INVALID", "存储目录必须是绝对路径。")

    return ServiceConfig(host=host, port=port, access_token=token, data_root=data_root)


def _default_data_root(environ: Mapping[str, str]) -> Path:
    local_app_data = environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "PaperLens" / "MinerU"
    return Path.home() / "AppData" / "Local" / "PaperLens" / "MinerU"


def _reject_unknown_config(raw: object) -> None:
    if not isinstance(raw, dict):
        raise ConfigError("CONFIG_FILE_INVALID", "配置文件根节点必须是 TOML 表。")
    for section, value in raw.items():
        if section not in _SECTIONS:
            raise ConfigError("CONFIG_UNKNOWN_KEY", f"不支持的配置段：{section}。")
        if not isinstance(value, dict):
            raise ConfigError("CONFIG_FILE_INVALID", f"配置段 {section} 必须是 TOML 表。")
        for key in value:
            if key not in _SECTIONS[section]:
                raise ConfigError("CONFIG_UNKNOWN_KEY", f"不支持的配置字段：{section}.{key}。")


def _value(raw: dict[str, object], section: str, key: str, default: object) -> object:
    table = raw.get(section)
    if not isinstance(table, dict):
        return default
    return cast(dict[str, object], table).get(key, default)


def _string_value(raw: dict[str, object], section: str, key: str, default: str) -> str:
    value = _value(raw, section, key, default)
    if not isinstance(value, str):
        raise ConfigError("CONFIG_FILE_INVALID", f"配置字段 {section}.{key} 必须是字符串。")
    return value


def _parse_port(value: object) -> int:
    if isinstance(value, bool):
        raise ConfigError("CONFIG_PORT_INVALID", "端口必须是 1024–65535 的整数。")
    try:
        port = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as error:
        raise ConfigError("CONFIG_PORT_INVALID", "端口必须是 1024–65535 的整数。") from error
    if not 1024 <= port <= 65535:
        raise ConfigError("CONFIG_PORT_INVALID", "端口必须是 1024–65535 的整数。")
    return port
