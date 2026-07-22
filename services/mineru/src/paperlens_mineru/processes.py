from __future__ import annotations

import os
import signal
import subprocess
from typing import Protocol


class ProcessLike(Protocol):
    pid: int

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def kill(self) -> None: ...


def terminate_process_tree(process: ProcessLike, *, grace_seconds: float = 5.0) -> None:
    """只终止显式传入 PID 对应的进程树，不扫描或匹配其他进程。"""

    pid = process.pid
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError("拒绝终止无效 PID。")
    if process.poll() is not None:
        return

    if os.name == "nt":
        subprocess.run(
            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        try:
            process.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            # taskkill 在受限 Job Object/重定向解释器环境中可能返回但未杀死目标；
            # 使用已持有的精确进程句柄兜底，不能把仍在运行的推理伪装成已取消。
            process.kill()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError(f"无法终止受监管进程 PID {pid}。") from error
        return

    try:
        os.killpg(pid, signal.SIGTERM)
        process.wait(timeout=grace_seconds)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def process_group_options() -> dict[str, object]:
    """创建可被整树终止的隐藏子进程参数。"""

    if os.name == "nt":
        return {
            "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP,
            "startupinfo": _hidden_startup_info(),
        }
    return {"start_new_session": True}


def _hidden_startup_info() -> subprocess.STARTUPINFO:
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    return startup
