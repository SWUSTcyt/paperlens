from __future__ import annotations

import os
import platform
import socket
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Callable, Mapping
from uuid import uuid4

import httpx

from .config import ConfigError, MINERU_VERSION, ServiceConfig, load_config
from .lifecycle import DATA_MARKER_NAME


@dataclass(frozen=True)
class DiagnosticCheck:
    code: str
    state: str
    message: str
    metrics: tuple[tuple[str, int | str], ...] = ()


@dataclass(frozen=True)
class DiagnosticReport:
    checks: tuple[DiagnosticCheck, ...]

    @property
    def ok(self) -> bool:
        return all(check.state != "error" for check in self.checks)


def collect_diagnostics(
    config_path: str | Path,
    *,
    runtime_root: str | Path | None = None,
    check_health: bool = False,
    environ: Mapping[str, str] | None = None,
) -> DiagnosticReport:
    """收集可分享的本机诊断；不输出 token、绝对路径或底层异常。"""

    env = dict(os.environ if environ is None else environ)
    checks = [
        _platform_check(),
        _python_check(),
        _mineru_package_check(),
    ]
    runtime = Path(runtime_root or sys.prefix)
    checks.append(
        DiagnosticCheck(
            "RUNTIME_SIZE",
            "ok",
            "运行时目录可读。",
            (("runtimeBytes", _directory_size(runtime)),),
        )
    )

    path = Path(config_path).expanduser()
    if not path.is_file():
        checks.append(DiagnosticCheck("CONFIG_MISSING", "error", "配置文件不存在。"))
        return DiagnosticReport(tuple(checks))

    try:
        config = load_config(path, environ=env)
    except ConfigError:
        checks.append(DiagnosticCheck("CONFIG_INVALID", "error", "配置文件无效。"))
        return DiagnosticReport(tuple(checks))

    checks.append(
        DiagnosticCheck(
            "CONFIG_VALID",
            "ok",
            "配置有效，token=<redacted>。",
            (("host", config.host), ("port", config.port)),
        )
    )
    checks.append(_storage_check(config))
    checks.append(_model_cache_check(env))
    checks.append(_port_check(config))
    if check_health:
        checks.append(_health_check(config))
    else:
        checks.append(DiagnosticCheck("HEALTH_SKIPPED", "skip", "未请求服务 health 检查。"))
    return DiagnosticReport(tuple(checks))


def format_diagnostics(report: DiagnosticReport) -> str:
    labels = {"ok": "OK", "warning": "WARN", "error": "ERROR", "skip": "SKIP"}
    lines: list[str] = []
    for check in report.checks:
        metrics = " ".join(f"{key}={value}" for key, value in check.metrics)
        suffix = f" {metrics}" if metrics else ""
        lines.append(f"[{labels[check.state]}] {check.code}: {check.message}{suffix}")
    if report.ok:
        lines.append("诊断通过。")
    else:
        error_count = sum(check.state == "error" for check in report.checks)
        lines.append(f"诊断失败：{error_count} 项错误。")
    return "\n".join(lines)


def _platform_check() -> DiagnosticCheck:
    if platform.system() == "Windows":
        return DiagnosticCheck("PLATFORM_WINDOWS", "ok", "Windows 平台。")
    return DiagnosticCheck("PLATFORM_UNSUPPORTED", "error", "C1 安装入口仅支持 Windows。")


def _python_check() -> DiagnosticCheck:
    version = f"{sys.version_info[0]}.{sys.version_info[1]}"
    if sys.version_info[:2] == (3, 12):
        return DiagnosticCheck("PYTHON_VERSION", "ok", "Python 版本符合要求。", (("python", version),))
    return DiagnosticCheck("PYTHON_VERSION", "error", "需要 Python 3.12。", (("python", version),))


def _mineru_package_check() -> DiagnosticCheck:
    try:
        version = metadata.version("mineru")
    except metadata.PackageNotFoundError:
        return DiagnosticCheck("MINERU_MISSING", "error", "未安装 MinerU。")
    if version != MINERU_VERSION:
        return DiagnosticCheck(
            "MINERU_VERSION",
            "error",
            "MinerU 版本不兼容。",
            (("mineru", version),),
        )
    return DiagnosticCheck("MINERU_VERSION", "ok", "MinerU 版本符合要求。", (("mineru", version),))


def _storage_check(config: ServiceConfig) -> DiagnosticCheck:
    root = config.data_root
    probe = root / f".doctor-{uuid4().hex}.tmp"
    try:
        root.mkdir(parents=True, exist_ok=True)
        with probe.open("x", encoding="utf-8") as output:
            output.write("paperlens-mineru-doctor")
        probe.unlink()
    except OSError:
        probe.unlink(missing_ok=True)
        return DiagnosticCheck("STORAGE_UNWRITABLE", "error", "任务存储目录不可写。")
    data_bytes = _directory_size(root)
    marker = root / DATA_MARKER_NAME
    if marker.is_file():
        try:
            data_bytes = max(0, data_bytes - marker.stat().st_size)
        except OSError:
            pass
    return DiagnosticCheck(
        "STORAGE_WRITABLE",
        "ok",
        "任务存储目录可写。",
        (("dataBytes", data_bytes),),
    )


def _model_cache_check(environ: Mapping[str, str]) -> DiagnosticCheck:
    candidates = _model_cache_roots(environ)
    total = sum(_directory_size(path) for path in candidates)
    existing = sum(path.is_dir() for path in candidates)
    return DiagnosticCheck(
        "MODEL_CACHE",
        "ok" if existing else "warning",
        "已统计模型缓存。" if existing else "尚未发现模型缓存；首次任务会下载模型。",
        (("modelCacheBytes", total), ("modelCacheRoots", existing)),
    )


def _model_cache_roots(environ: Mapping[str, str]) -> tuple[Path, ...]:
    home = Path(environ.get("USERPROFILE") or Path.home())
    values = (
        Path(environ.get("MODELSCOPE_CACHE") or home / ".cache" / "modelscope"),
        Path(environ.get("HF_HOME") or home / ".cache" / "huggingface"),
    )
    unique: list[Path] = []
    for value in values:
        expanded = value.expanduser()
        if expanded not in unique:
            unique.append(expanded)
    return tuple(unique)


def _port_check(config: ServiceConfig) -> DiagnosticCheck:
    try:
        with socket.create_connection(("127.0.0.1", config.port), timeout=0.5):
            return DiagnosticCheck("PORT_LISTENING", "ok", "配置端口已有本机服务监听。")
    except OSError:
        return DiagnosticCheck("PORT_AVAILABLE", "ok", "配置端口当前可用于启动服务。")


def _health_check(config: ServiceConfig) -> DiagnosticCheck:
    try:
        payload = _fetch_health(config)
    except Exception:
        return DiagnosticCheck("HEALTH_UNAVAILABLE", "error", "服务 health 不可用。")
    engine = payload.get("engine")
    compatible = (
        payload.get("schemaVersion") == 1
        and payload.get("service") == "paperlens-mineru"
        and payload.get("status") == "ready"
        and isinstance(engine, dict)
        and engine.get("name") == "mineru"
        and engine.get("version") == MINERU_VERSION
        and engine.get("backend") == "pipeline"
    )
    if not compatible:
        return DiagnosticCheck("HEALTH_INCOMPATIBLE", "error", "服务 health 与 schema v1 不兼容。")
    return DiagnosticCheck("HEALTH_READY", "ok", "服务 health ready。")


def _fetch_health(config: ServiceConfig) -> dict[str, object]:
    response = httpx.get(f"http://127.0.0.1:{config.port}/v1/health", timeout=3)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("invalid health payload")
    return payload


def _directory_size(root: Path, *, max_entries: int = 500_000) -> int:
    if not root.is_dir():
        return 0
    total = 0
    entries = 0
    pending = [root]
    while pending and entries < max_entries:
        current = pending.pop()
        try:
            with os.scandir(current) as children:
                for child in children:
                    entries += 1
                    if entries > max_entries:
                        break
                    try:
                        if child.is_dir(follow_symlinks=False):
                            pending.append(Path(child.path))
                        elif child.is_file(follow_symlinks=False):
                            total += child.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total
