from __future__ import annotations

import asyncio
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import zipfile
from contextlib import suppress
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Awaitable, Callable
from uuid import uuid4

import httpx

from .config import ServiceConfig
from .contracts import ErrorCode, JobStage
from .errors import ContractError
from .jobs import JobRecord, StageReporter
from .processes import process_group_options, terminate_process_tree


_UPSTREAM_TASK_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class MineruApiSupervisor:
    """监督唯一的 MinerU API 子进程；正常复用模型，取消时整树重启。"""

    def __init__(
        self,
        config: ServiceConfig,
        *,
        python_executable: str | Path | None = None,
        startup_timeout_seconds: float = 240,
    ) -> None:
        self.config = config
        self.python_executable = str(python_executable or getattr(sys, "_base_executable", sys.executable))
        self.startup_timeout_seconds = startup_timeout_seconds
        self.process: subprocess.Popen[bytes] | None = None
        self.port: int | None = None
        self.output_root: Path | None = None
        self._log_handle = None
        self._lock = asyncio.Lock()

    async def ensure_ready(self, report_stage: StageReporter) -> str:
        if await self._is_healthy():
            return self.base_url
        async with self._lock:
            if await self._is_healthy():
                return self.base_url
            await report_stage(JobStage.LOADING_MODEL)
            await asyncio.to_thread(self._stop_sync)
            await asyncio.to_thread(self._start_sync)
            deadline = asyncio.get_running_loop().time() + self.startup_timeout_seconds
            while asyncio.get_running_loop().time() < deadline:
                if self.process is None or self.process.poll() is not None:
                    await asyncio.to_thread(self._stop_sync)
                    raise ContractError(
                        ErrorCode.SERVICE_NOT_READY,
                        "MinerU 子服务启动失败。",
                        http_status=503,
                    )
                if await self._is_healthy():
                    return self.base_url
                await asyncio.sleep(1)
            await asyncio.to_thread(self._stop_sync)
            raise ContractError(
                ErrorCode.SERVICE_NOT_READY,
                "MinerU 子服务启动超过 240 秒。",
                http_status=503,
            )

    async def restart(self, job_id: str) -> None:
        # job_id 仅用于审计调用边界；绝不拼入命令或文件路径。
        if not job_id.startswith("job_"):
            raise ValueError("无效的 PaperLens job ID。")
        async with self._lock:
            await asyncio.to_thread(self._stop_sync)

    async def close(self) -> None:
        async with self._lock:
            await asyncio.to_thread(self._stop_sync)

    @property
    def base_url(self) -> str:
        if self.port is None:
            raise RuntimeError("MinerU 子服务尚未分配端口。")
        return f"http://127.0.0.1:{self.port}"

    async def _is_healthy(self) -> bool:
        if self.process is None or self.process.poll() is not None or self.port is None:
            return False
        try:
            async with httpx.AsyncClient(timeout=1) as client:
                response = await client.get(f"{self.base_url}/health")
            payload = response.json() if response.status_code == 200 else {}
            return payload.get("status") == "healthy" and payload.get("version") == self.config.mineru_version
        except (httpx.HTTPError, ValueError):
            return False

    def _start_sync(self) -> None:
        self.port = _find_free_loopback_port()
        generation = f"generation_{uuid4().hex}"
        self.output_root = self.config.data_root / "upstream" / generation
        self.output_root.mkdir(parents=True, exist_ok=False)
        logs_root = self.config.data_root / "logs"
        logs_root.mkdir(parents=True, exist_ok=True)
        self._log_handle = (logs_root / f"{generation}.log").open("ab", buffering=0)
        env = build_upstream_environment(self.config, self.output_root)
        env = add_current_python_packages(env)
        command = [
            self.python_executable,
            "-m",
            "mineru.cli.fast_api",
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
        ]
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
            cwd=self.config.data_root,
            env=env,
            shell=False,
            **process_group_options(),
        )

    def _stop_sync(self) -> None:
        process = self.process
        self.process = None
        if process is not None and process.poll() is None:
            terminate_process_tree(process)
            with suppress(subprocess.TimeoutExpired):
                process.wait(timeout=10)
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None
        if self.output_root is not None:
            shutil.rmtree(self.output_root, ignore_errors=True)
        self.output_root = None
        self.port = None


class MineruUpstreamRunner:
    def __init__(
        self,
        supervisor: MineruApiSupervisor,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        poll_interval_seconds: float = 1,
    ) -> None:
        self.supervisor = supervisor
        self.transport = transport
        self.poll_interval_seconds = poll_interval_seconds

    async def run_job(self, job: JobRecord, report_stage: StageReporter) -> Path:
        base_url = await self.supervisor.ensure_ready(report_stage)
        timeout = httpx.Timeout(connect=10, read=60, write=60, pool=10)
        async with httpx.AsyncClient(base_url=base_url, transport=self.transport, timeout=timeout) as client:
            upstream_task_id = await self._submit(client, job.input_path)
            try:
                await report_stage(JobStage.QUEUED)
                await self._wait_for_completion(client, upstream_task_id, report_stage)
                await report_stage(JobStage.NORMALIZING)
                raw_dir = await self._download_and_extract(client, upstream_task_id, job.directory)
                return raw_dir
            finally:
                self._cleanup_upstream_task(upstream_task_id)

    async def cancel_job(self, job_id: str) -> None:
        await self.supervisor.restart(job_id)

    async def close(self) -> None:
        await self.supervisor.close()

    async def _submit(self, client: httpx.AsyncClient, input_path: Path) -> str:
        form = {
            "lang_list": "ch",
            "backend": "pipeline",
            "effort": "high",
            "parse_method": "auto",
            "formula_enable": "true",
            "table_enable": "true",
            "image_analysis": "true",
            "return_md": "false",
            "return_middle_json": "true",
            "return_model_output": "false",
            "return_content_list": "true",
            "return_images": "true",
            "response_format_zip": "true",
            "return_original_file": "false",
            "client_side_output_generation": "false",
            "start_page_id": "0",
            "end_page_id": "99999",
        }
        try:
            with input_path.open("rb") as input_stream:
                response = await client.post(
                    "/tasks",
                    data=form,
                    files={"files": ("paper.pdf", input_stream, "application/pdf")},
                )
        except (OSError, httpx.HTTPError) as error:
            raise ContractError(
                ErrorCode.JOB_FAILED,
                "无法向 MinerU 子服务提交任务。",
                http_status=502,
                internal_detail=str(error),
            ) from error
        if response.status_code != 202:
            raise ContractError(ErrorCode.JOB_FAILED, "MinerU 子服务拒绝了任务。", http_status=502)
        try:
            payload = response.json()
        except ValueError as error:
            raise ContractError(ErrorCode.RESULT_INVALID, "MinerU 子服务返回了无效响应。", http_status=502) from error
        return validate_upstream_task_id(payload.get("task_id"))

    async def _wait_for_completion(
        self,
        client: httpx.AsyncClient,
        task_id: str,
        report_stage: StageReporter,
    ) -> None:
        # 提交成功后调用方已报告 queued，避免第一次 pending 轮询重复刷新阶段起始时间。
        last_stage: JobStage | None = JobStage.QUEUED
        while True:
            try:
                response = await client.get(f"/tasks/{task_id}")
            except httpx.HTTPError as error:
                raise ContractError(
                    ErrorCode.JOB_FAILED,
                    "无法查询 MinerU 子任务状态。",
                    http_status=502,
                    internal_detail=str(error),
                ) from error
            if response.status_code != 200:
                raise ContractError(ErrorCode.JOB_FAILED, "MinerU 子任务状态不可用。", http_status=502)
            try:
                payload = response.json()
            except ValueError as error:
                raise ContractError(ErrorCode.RESULT_INVALID, "MinerU 子任务状态无效。", http_status=502) from error
            status = payload.get("status")
            if status == "pending":
                stage = JobStage.QUEUED
            elif status == "processing":
                stage = JobStage.PARSING
            elif status == "completed":
                return
            else:
                raise ContractError(ErrorCode.JOB_FAILED, "MinerU 子任务执行失败。", http_status=502)
            if stage is not last_stage:
                await report_stage(stage)
                last_stage = stage
            await asyncio.sleep(self.poll_interval_seconds)

    async def _download_and_extract(self, client: httpx.AsyncClient, task_id: str, job_dir: Path) -> Path:
        archive_path = job_dir / "result.zip"
        raw_dir = job_dir / "raw"
        try:
            async with client.stream("GET", f"/tasks/{task_id}/result") as response:
                if response.status_code != 200 or "application/zip" not in response.headers.get("content-type", ""):
                    raise ContractError(ErrorCode.RESULT_INVALID, "MinerU 结果包不可用。", http_status=502)
                with archive_path.open("wb") as output:
                    async for chunk in response.aiter_bytes():
                        output.write(chunk)
            await asyncio.to_thread(safe_extract_zip, archive_path, raw_dir)
            return raw_dir
        except OSError as error:
            raise ContractError(
                ErrorCode.RESULT_INVALID,
                "无法保存 MinerU 结果包。",
                http_status=502,
                internal_detail=str(error),
            ) from error
        finally:
            archive_path.unlink(missing_ok=True)

    def _cleanup_upstream_task(self, task_id: str) -> None:
        output_root = self.supervisor.output_root
        if output_root is None:
            return
        task_path = (output_root / validate_upstream_task_id(task_id)).resolve()
        root = output_root.resolve()
        if root not in task_path.parents:
            raise ContractError(ErrorCode.RESULT_INVALID, "MinerU 子任务路径无效。", http_status=502)
        shutil.rmtree(task_path, ignore_errors=True)


def build_upstream_environment(config: ServiceConfig, output_root: Path) -> dict[str, str]:
    source = {key: value for key, value in os.environ.items() if not key.startswith("PAPERLENS_MINERU_")}
    if os.name == "nt":
        deduped: dict[str, tuple[str, str]] = {}
        for key, value in source.items():
            deduped[key.upper()] = (key, value)
        env = {original: value for original, value in deduped.values()}
    else:
        env = source
    env.update(
        {
            "MINERU_API_OUTPUT_ROOT": str(output_root),
            "MINERU_API_MAX_CONCURRENT_REQUESTS": "1",
            "MINERU_PROCESSING_WINDOW_SIZE": "4",
            "MINERU_API_TASK_RETENTION_SECONDS": str(config.result_ttl_seconds),
            "MINERU_API_DISABLE_ACCESS_LOG": "1",
            "MINERU_API_ENABLE_FASTAPI_DOCS": "0",
        }
    )
    env.setdefault("MINERU_MODEL_SOURCE", "modelscope")
    return env


def add_current_python_packages(environment: dict[str, str]) -> dict[str, str]:
    """用 base Python 承载进程时，显式保留当前 uv venv 的依赖搜索路径。"""

    candidates = [
        Path(sys.prefix) / "Lib" / "site-packages",
        *(Path(item) for item in sys.path if item and item.endswith("site-packages")),
    ]
    existing = environment.get("PYTHONPATH", "")
    parts: list[str] = []
    for candidate in candidates:
        value = str(candidate)
        if candidate.is_dir() and value not in parts:
            parts.append(value)
    for value in existing.split(os.pathsep):
        if value and value not in parts:
            parts.append(value)
    updated = dict(environment)
    updated["PYTHONPATH"] = os.pathsep.join(parts)
    return updated


def _find_free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def validate_upstream_task_id(value: object) -> str:
    if not isinstance(value, str) or not _UPSTREAM_TASK_ID.fullmatch(value):
        raise ContractError(
            ErrorCode.RESULT_INVALID,
            "MinerU 上游任务标识无效。",
            http_status=502,
        )
    return value


def safe_extract_zip(
    archive_path: Path,
    destination: Path,
    *,
    max_files: int = 20_000,
    max_uncompressed_bytes: int = 2 * 1024 * 1024 * 1024,
) -> None:
    """受限解包 MinerU 结果，拒绝绝对路径、穿越、链接和压缩炸弹。"""

    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if len(members) > max_files or sum(member.file_size for member in members) > max_uncompressed_bytes:
                raise ValueError("archive limit")
            destination.mkdir(parents=True, exist_ok=True)
            root = destination.resolve()
            for member in members:
                _validate_zip_member(member)
                relative = PurePosixPath(member.filename)
                target = destination.joinpath(*relative.parts)
                resolved = target.resolve()
                if resolved != root and root not in resolved.parents:
                    raise ValueError("archive traversal")
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member, "r") as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        shutil.rmtree(destination, ignore_errors=True)
        raise ContractError(
            ErrorCode.RESULT_INVALID,
            "MinerU 结果压缩包不安全或已损坏。",
            http_status=502,
            internal_detail=str(error),
        ) from error


def _validate_zip_member(member: zipfile.ZipInfo) -> None:
    name = member.filename.replace("\\", "/")
    posix = PurePosixPath(name)
    windows = PureWindowsPath(name)
    if not name or posix.is_absolute() or windows.is_absolute() or windows.drive or ".." in posix.parts:
        raise ValueError("unsafe archive path")
    mode = member.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise ValueError("archive link")
