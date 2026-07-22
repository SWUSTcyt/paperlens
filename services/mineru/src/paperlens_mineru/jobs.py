from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, Mapping, Protocol
from uuid import uuid4

from .contracts import CONTRACT_SCHEMA_VERSION, ErrorCode, JobResult, JobStage, JobState
from .errors import ContractError

if TYPE_CHECKING:
    from .normalizer import ProcessedJobResult


StageReporter = Callable[[JobStage], Awaitable[None]]
TERMINAL_STATES = {JobState.COMPLETED, JobState.CANCELLED, JobState.FAILED, JobState.TIMED_OUT}
ACTIVE_STAGES = {
    JobStage.QUEUED,
    JobStage.PREPARING,
    JobStage.LOADING_MODEL,
    JobStage.PARSING,
    JobStage.NORMALIZING,
    JobStage.CROPS_READY,
}


class JobRunner(Protocol):
    async def run_job(self, job: "JobRecord", report_stage: StageReporter) -> Path: ...

    async def cancel_job(self, job_id: str) -> None: ...

    async def close(self) -> None: ...


class JobResultProcessor(Protocol):
    async def process(
        self,
        job: "JobRecord",
        raw_output_dir: Path,
        report_stage: StageReporter,
    ) -> "ProcessedJobResult": ...


@dataclass
class JobRecord:
    job_id: str
    directory: Path
    input_path: Path
    page_count: int
    state: JobState = JobState.ACCEPTED
    stage: JobStage = JobStage.ACCEPTED
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    stage_started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = None
    cancel_requested: bool = False
    error_code: ErrorCode | None = None
    error_message: str | None = None
    raw_output_dir: Path | None = None
    result: JobResult | None = None
    crops: Mapping[str, Path] = field(default_factory=dict)


class JobManager:
    def __init__(
        self,
        data_root: Path,
        runner: JobRunner,
        *,
        task_timeout_seconds: float,
        result_ttl_seconds: float,
        max_queued_jobs: int = 1,
        result_processor: JobResultProcessor | None = None,
    ) -> None:
        self.data_root = Path(data_root)
        self.jobs_root = self.data_root / "jobs"
        self.runner = runner
        self.task_timeout_seconds = task_timeout_seconds
        self.result_ttl_seconds = result_ttl_seconds
        self.max_queued_jobs = max_queued_jobs
        self.result_processor = result_processor
        self.jobs: dict[str, JobRecord] = {}
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.dispatcher: asyncio.Task[None] | None = None
        self.current_job_id: str | None = None
        self.started = False
        self.closed = False

    async def start(self) -> None:
        if self.started:
            return
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self._cleanup_orphan_inputs()
        self.started = True
        self.closed = False
        self.dispatcher = asyncio.create_task(self._dispatch(), name="paperlens-mineru-dispatcher")

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.current_job_id is not None:
            await self.cancel(self.current_job_id)
        if self.dispatcher is not None:
            self.dispatcher.cancel()
            try:
                await self.dispatcher
            except asyncio.CancelledError:
                pass
            self.dispatcher = None
        await self.runner.close()
        for job in self.jobs.values():
            self._delete_input(job)
        self.started = False

    def allocate_input_path(self) -> tuple[str, Path]:
        job_id = f"job_{uuid4().hex}"
        directory = self.jobs_root / job_id
        directory.mkdir(parents=True, exist_ok=False)
        return job_id, directory / "input.pdf"

    async def submit(self, job_id: str, input_path: Path, *, page_count: int) -> JobRecord:
        self._require_ready()
        self._validate_allocated_input(job_id, input_path)
        if job_id in self.jobs:
            raise ContractError(ErrorCode.INVALID_REQUEST, "任务 ID 已存在。", http_status=409)
        queued_count = sum(1 for job in self.jobs.values() if job.state is JobState.QUEUED)
        if queued_count >= self.max_queued_jobs:
            self._delete_path(input_path)
            raise ContractError(ErrorCode.QUEUE_FULL, "本地 MinerU 队列已满。", http_status=429)
        if not 1 <= page_count <= 500:
            self._delete_path(input_path)
            raise ContractError(ErrorCode.PDF_TOO_MANY_PAGES, "PDF 页数超出 500 页上限。", http_status=413)

        now = datetime.now(timezone.utc)
        job = JobRecord(
            job_id=job_id,
            directory=input_path.parent,
            input_path=input_path,
            page_count=page_count,
            state=JobState.QUEUED,
            stage=JobStage.QUEUED,
            created_at=now,
            stage_started_at=now,
        )
        self.jobs[job_id] = job
        await self.queue.put(job_id)
        return job

    def get(self, job_id: str) -> JobRecord:
        job = self.jobs.get(job_id)
        if job is None:
            raise ContractError(ErrorCode.JOB_NOT_FOUND, "未找到该任务。", http_status=404)
        return job

    async def cancel(self, job_id: str) -> JobRecord:
        job = self.get(job_id)
        if job.state in TERMINAL_STATES:
            return job
        if job.state is JobState.CANCELLING:
            return job

        job.cancel_requested = True
        self._set_state(job, JobState.CANCELLING, JobStage.CANCELLING)
        if self.current_job_id == job_id:
            await self.runner.cancel_job(job_id)
        else:
            self._finish(job, JobState.CANCELLED, JobStage.CANCELLED)
            self._delete_input(job)
        return job

    def delete(self, job_id: str) -> None:
        job = self.get(job_id)
        if job.state not in TERMINAL_STATES:
            raise ContractError(ErrorCode.INVALID_REQUEST, "运行中的任务必须先取消。", http_status=409)
        self.jobs.pop(job_id, None)
        shutil.rmtree(job.directory, ignore_errors=True)

    def cleanup_expired(self, *, now: datetime | None = None) -> list[str]:
        reference = now or datetime.now(timezone.utc)
        removed: list[str] = []
        for job_id, job in list(self.jobs.items()):
            if job.state not in TERMINAL_STATES or job.completed_at is None:
                continue
            age = (reference - job.completed_at).total_seconds()
            if age < self.result_ttl_seconds:
                continue
            self.jobs.pop(job_id, None)
            shutil.rmtree(job.directory, ignore_errors=True)
            removed.append(job_id)
        return removed

    def status_payload(self, job_id: str) -> dict[str, object]:
        job = self.get(job_id)
        payload: dict[str, object] = {
            "schemaVersion": CONTRACT_SCHEMA_VERSION,
            "jobId": job.job_id,
            "state": job.state.value,
            "stage": job.stage.value,
            "stageStartedAt": job.stage_started_at.isoformat().replace("+00:00", "Z"),
            "elapsedMs": max(0, int((datetime.now(timezone.utc) - job.created_at).total_seconds() * 1000)),
        }
        if job.state is JobState.QUEUED:
            payload["queuePosition"] = self._queue_position(job_id)
        if job.error_code is not None:
            payload["error"] = {
                "code": job.error_code.value,
                "message": job.error_message or "本地 MinerU 任务失败。",
            }
        if job.state is JobState.COMPLETED and job.result is not None:
            payload["result"] = job.result.to_dict()
        return payload

    def crop_path(self, job_id: str, crop_id: str) -> Path:
        job = self.get(job_id)
        if job.state is not JobState.COMPLETED:
            raise ContractError(ErrorCode.INVALID_REQUEST, "任务尚未完成。", http_status=409)
        path = job.crops.get(crop_id)
        if path is None or not path.is_file():
            raise ContractError(ErrorCode.JOB_NOT_FOUND, "未找到该裁剪图。", http_status=404)
        resolved = path.resolve()
        if not resolved.is_relative_to(job.directory.resolve()):
            raise ContractError(ErrorCode.RESULT_INVALID, "裁剪图路径无效。", http_status=502)
        return resolved

    async def _dispatch(self) -> None:
        while True:
            job_id = await self.queue.get()
            try:
                job = self.jobs.get(job_id)
                if job is None or job.state in TERMINAL_STATES:
                    continue
                self.current_job_id = job_id
                await self._run_job(job)
            finally:
                self.current_job_id = None
                self.queue.task_done()

    async def _run_job(self, job: JobRecord) -> None:
        if job.cancel_requested:
            self._finish(job, JobState.CANCELLED, JobStage.CANCELLED)
            self._delete_input(job)
            return
        self._set_state(job, JobState.RUNNING, JobStage.PREPARING)

        async def report_stage(stage: JobStage) -> None:
            if stage not in ACTIVE_STAGES:
                raise ValueError(f"runner 不得报告阶段 {stage.value}")
            if not job.cancel_requested:
                job.stage = stage
                job.stage_started_at = datetime.now(timezone.utc)

        async def execute_pipeline() -> None:
            job.raw_output_dir = await self.runner.run_job(job, report_stage)
            if self.result_processor is None:
                return
            processed = await self.result_processor.process(job, job.raw_output_dir, report_stage)
            if processed.result.job_id != job.job_id:
                raise ContractError(ErrorCode.RESULT_INVALID, "结果任务 ID 不匹配。", http_status=502)
            expected_crop_ids = {formula.crop_id for formula in processed.result.formulas if formula.crop_id is not None}
            if expected_crop_ids != set(processed.crops):
                raise ContractError(ErrorCode.RESULT_INVALID, "结果裁剪图集合不完整。", http_status=502)
            job.result = processed.result
            job.crops = dict(processed.crops)

        try:
            await asyncio.wait_for(execute_pipeline(), timeout=self.task_timeout_seconds)
            if job.cancel_requested:
                self._finish(job, JobState.CANCELLED, JobStage.CANCELLED)
            else:
                self._finish(job, JobState.COMPLETED, JobStage.COMPLETED)
        except asyncio.TimeoutError:
            await self.runner.cancel_job(job.job_id)
            job.error_code = ErrorCode.JOB_TIMED_OUT
            job.error_message = "本地 MinerU 任务超过 30 分钟上限。"
            self._finish(job, JobState.TIMED_OUT, JobStage.TIMED_OUT)
        except asyncio.CancelledError:
            if not self.closed:
                raise
            await self.runner.cancel_job(job.job_id)
            self._finish(job, JobState.CANCELLED, JobStage.CANCELLED)
        except ContractError as error:
            if job.cancel_requested:
                self._finish(job, JobState.CANCELLED, JobStage.CANCELLED)
            else:
                job.error_code = error.code if error.code is ErrorCode.RESULT_INVALID else ErrorCode.JOB_FAILED
                job.error_message = error.safe_message if error.code is ErrorCode.RESULT_INVALID else "本地 MinerU 任务执行失败。"
                self._finish(job, JobState.FAILED, JobStage.FAILED)
        except Exception as error:
            if job.cancel_requested:
                self._finish(job, JobState.CANCELLED, JobStage.CANCELLED)
            else:
                job.error_code = ErrorCode.JOB_FAILED
                job.error_message = "本地 MinerU 任务执行失败。"
                self._finish(job, JobState.FAILED, JobStage.FAILED)
            # 具体异常只留在受控服务日志，绝不进入状态响应。
            _ = error
        finally:
            self._delete_input(job)
            if job.state is not JobState.COMPLETED:
                self._delete_unfinished_outputs(job)

    def _set_state(self, job: JobRecord, state: JobState, stage: JobStage) -> None:
        job.state = state
        job.stage = stage
        job.stage_started_at = datetime.now(timezone.utc)

    def _finish(self, job: JobRecord, state: JobState, stage: JobStage) -> None:
        self._set_state(job, state, stage)
        job.completed_at = datetime.now(timezone.utc)

    def _queue_position(self, job_id: str) -> int:
        queued = [job.job_id for job in self.jobs.values() if job.state is JobState.QUEUED]
        try:
            return queued.index(job_id)
        except ValueError:
            return 0

    def _require_ready(self) -> None:
        if not self.started or self.closed or self.dispatcher is None or self.dispatcher.done():
            raise ContractError(ErrorCode.SERVICE_NOT_READY, "本地任务管理器尚未就绪。", http_status=503)

    def _validate_allocated_input(self, job_id: str, input_path: Path) -> None:
        expected = (self.jobs_root / job_id / "input.pdf").resolve()
        if input_path.resolve() != expected or not job_id.startswith("job_"):
            raise ContractError(ErrorCode.INVALID_REQUEST, "任务输入路径无效。", http_status=400)
        if not input_path.is_file():
            raise ContractError(ErrorCode.PDF_INVALID, "PDF 输入不存在。", http_status=400)

    def _cleanup_orphan_inputs(self) -> None:
        for input_path in self.jobs_root.glob("job_*/input.pdf"):
            self._delete_path(input_path)

    @staticmethod
    def _delete_path(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def _delete_input(self, job: JobRecord) -> None:
        self._delete_path(job.input_path)

    @staticmethod
    def _delete_unfinished_outputs(job: JobRecord) -> None:
        for name in ("raw", "crops"):
            shutil.rmtree(job.directory / name, ignore_errors=True)
        for name in ("result.zip", "result.json"):
            JobManager._delete_path(job.directory / name)
        job.raw_output_dir = None
        job.result = None
        job.crops = {}
