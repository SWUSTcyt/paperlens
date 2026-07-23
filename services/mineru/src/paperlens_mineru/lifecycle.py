from __future__ import annotations

import json
import os
import sys
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from uuid import uuid4

import psutil

from .config import ConfigError, ServiceConfig, load_config


DATA_MARKER_NAME = ".paperlens-mineru-data"
DATA_MARKER_VALUE = "paperlens-mineru-data-v1"
SERVICE_STATE_NAME = ".paperlens-mineru-service.json"


@dataclass(frozen=True)
class StopResult:
    stopped: bool


@dataclass(frozen=True)
class ServiceStatus:
    running: bool


def ensure_data_root_marker(data_root: Path) -> Path:
    root = data_root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    marker = root / DATA_MARKER_NAME
    if marker.exists():
        try:
            value = marker.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise ConfigError("DATA_ROOT_UNTRUSTED", "无法验证 PaperLens MinerU 数据目录标记。") from error
        if value != DATA_MARKER_VALUE:
            raise ConfigError("DATA_ROOT_UNTRUSTED", "数据目录含有不受信任的 PaperLens MinerU 标记。")
        return marker
    try:
        marker.write_text(DATA_MARKER_VALUE, encoding="utf-8", newline="\n")
    except OSError as error:
        raise ConfigError("DATA_ROOT_UNWRITABLE", "无法标记 PaperLens MinerU 数据目录。") from error
    return marker


@contextmanager
def service_instance(config: ServiceConfig, config_path: Path) -> Iterator[None]:
    ensure_data_root_marker(config.data_root)
    state_path = config.data_root.resolve() / SERVICE_STATE_NAME
    _reject_live_instance(state_path)
    process = psutil.Process(os.getpid())
    nonce = uuid4().hex
    payload = {
        "schemaVersion": 2,
        "pid": process.pid,
        "createTime": process.create_time(),
        "executable": process.exe(),
        "entrypoint": _current_entrypoint(),
        "configPath": str(config_path.expanduser().resolve()),
        "nonce": nonce,
    }
    try:
        with state_path.open("x", encoding="utf-8", newline="\n") as output:
            json.dump(payload, output, ensure_ascii=False)
    except FileExistsError as error:
        raise ConfigError("SERVICE_ALREADY_RUNNING", "此数据目录刚刚被另一个服务实例占用。") from error
    except OSError as error:
        state_path.unlink(missing_ok=True)
        raise ConfigError("SERVICE_STATE_UNWRITABLE", "无法写入 PaperLens MinerU 服务状态。") from error
    try:
        yield
    finally:
        with suppress(OSError, ValueError, json.JSONDecodeError):
            current = json.loads(state_path.read_text(encoding="utf-8"))
            if current.get("nonce") == nonce:
                state_path.unlink(missing_ok=True)


def stop_service(config_path: Path) -> StopResult:
    resolved_config = config_path.expanduser().resolve()
    config = load_config(resolved_config)
    state_path = config.data_root.resolve() / SERVICE_STATE_NAME
    if not state_path.is_file():
        return StopResult(stopped=False)
    state = _read_state(state_path)
    if Path(state["configPath"]) != resolved_config:
        raise ConfigError("SERVICE_STATE_UNTRUSTED", "服务状态与当前配置不匹配，拒绝终止进程。")
    try:
        process = psutil.Process(state["pid"])
        _verify_owned_process(process, state, resolved_config)
    except psutil.NoSuchProcess:
        state_path.unlink(missing_ok=True)
        return StopResult(stopped=False)
    except (psutil.AccessDenied, OSError) as error:
        raise ConfigError("SERVICE_STOP_DENIED", "无法验证或终止 PaperLens MinerU 服务进程。") from error

    try:
        for child in reversed(process.children(recursive=True)):
            _terminate_process(child)
        _terminate_process(process)
    except (psutil.AccessDenied, OSError) as error:
        raise ConfigError("SERVICE_STOP_DENIED", "无法终止 PaperLens MinerU 服务进程树。") from error
    state_path.unlink(missing_ok=True)
    return StopResult(stopped=True)


def service_status(config_path: Path) -> ServiceStatus:
    """只读确认可信服务是否运行；不会向任何进程发送终止信号。"""

    resolved_config = config_path.expanduser().resolve()
    config = load_config(resolved_config)
    state_path = config.data_root.resolve() / SERVICE_STATE_NAME
    if not state_path.is_file():
        return ServiceStatus(running=False)
    state = _read_state(state_path)
    if Path(state["configPath"]) != resolved_config:
        raise ConfigError("SERVICE_STATE_UNTRUSTED", "服务状态与当前配置不匹配。")
    try:
        process = psutil.Process(state["pid"])
        _verify_owned_process(process, state, resolved_config)
    except psutil.NoSuchProcess:
        state_path.unlink(missing_ok=True)
        return ServiceStatus(running=False)
    except (psutil.AccessDenied, OSError) as error:
        raise ConfigError("SERVICE_STATUS_DENIED", "无法验证 PaperLens MinerU 服务进程。") from error
    return ServiceStatus(running=True)


def lifecycle_info(config_path: Path) -> dict[str, object]:
    resolved_config = config_path.expanduser().resolve()
    config = load_config(resolved_config)
    marker = config.data_root.resolve() / DATA_MARKER_NAME
    try:
        marker_valid = marker.is_file() and marker.read_text(encoding="utf-8").strip() == DATA_MARKER_VALUE
    except OSError as error:
        raise ConfigError("DATA_ROOT_UNTRUSTED", "无法验证 PaperLens MinerU 数据目录标记。") from error
    return {
        "schemaVersion": 1,
        "configPath": str(resolved_config),
        "dataRoot": str(config.data_root.resolve()),
        "dataMarkerValid": marker_valid,
        "port": config.port,
    }


def _reject_live_instance(state_path: Path) -> None:
    if not state_path.is_file():
        return
    state = _read_state(state_path)
    try:
        process = psutil.Process(state["pid"])
        if abs(process.create_time() - state["createTime"]) < 0.01:
            raise ConfigError("SERVICE_ALREADY_RUNNING", "此数据目录已有 PaperLens MinerU 服务在运行。")
    except psutil.NoSuchProcess:
        pass
    except psutil.AccessDenied as error:
        raise ConfigError("SERVICE_ALREADY_RUNNING", "无法确认已有 PaperLens MinerU 服务是否退出。") from error
    state_path.unlink(missing_ok=True)


def _read_state(state_path: Path) -> dict[str, object]:
    try:
        value = json.loads(state_path.read_text(encoding="utf-8"))
        schema_version = value.get("schemaVersion") if isinstance(value, dict) else None
        if (
            not isinstance(value, dict)
            or schema_version not in (1, 2)
            or not isinstance(value.get("pid"), int)
            or value["pid"] <= 0
            or not isinstance(value.get("createTime"), (int, float))
            or not isinstance(value.get("executable"), str)
            or not isinstance(value.get("configPath"), str)
            or not isinstance(value.get("nonce"), str)
            or (
                schema_version == 2
                and (
                    not isinstance(value.get("entrypoint"), str)
                    or not value["entrypoint"]
                )
            )
        ):
            raise ValueError("invalid state")
        return value
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ConfigError("SERVICE_STATE_UNTRUSTED", "PaperLens MinerU 服务状态文件无效。") from error


def _verify_owned_process(process: psutil.Process, state: dict[str, object], config_path: Path) -> None:
    executable = str(state["executable"])
    if abs(process.create_time() - float(state["createTime"])) >= 0.01:
        raise ConfigError("SERVICE_STATE_UNTRUSTED", "服务 PID 已被其他进程复用，拒绝终止。")
    if os.path.normcase(process.exe()) != os.path.normcase(executable):
        raise ConfigError("SERVICE_STATE_UNTRUSTED", "服务可执行文件不匹配，拒绝终止。")
    command = process.cmdline()
    normalized = [os.path.normcase(item) for item in command]
    if state["schemaVersion"] == 2:
        entrypoint = str(state["entrypoint"])
        entrypoint_matches = (
            entrypoint == "paperlens_mineru.cli"
            and "paperlens_mineru.cli" in command
        ) or os.path.normcase(entrypoint) in normalized
    else:
        entrypoint_matches = "paperlens_mineru.cli" in command or any(
            Path(item).name.lower() == "paperlens-mineru.exe"
            for item in command
        )
    if (
        not entrypoint_matches
        or "serve" not in command
        or os.path.normcase(str(config_path)) not in normalized
    ):
        raise ConfigError("SERVICE_STATE_UNTRUSTED", "服务启动参数不匹配，拒绝终止。")


def _current_entrypoint() -> str:
    original = list(getattr(sys, "orig_argv", ()))
    for item in original[1:]:
        if Path(item).name.lower() == "paperlens-mineru.exe":
            return str(Path(item).expanduser().resolve())
    for index, item in enumerate(original[:-1]):
        if item == "-m" and original[index + 1] == "paperlens_mineru.cli":
            return "paperlens_mineru.cli"
    return str(Path(sys.argv[0]).expanduser().resolve())


def _terminate_process(process: psutil.Process) -> None:
    try:
        process.terminate()
        process.wait(timeout=10)
    except psutil.NoSuchProcess:
        return
    except psutil.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=10)
        except psutil.TimeoutExpired as error:
            raise ConfigError("SERVICE_STOP_FAILED", "PaperLens MinerU 服务进程未能退出。") from error
