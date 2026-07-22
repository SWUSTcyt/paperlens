from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from paperlens_mineru.contracts import ErrorCode, JobStage, JobState, parse_job_result
from paperlens_mineru.errors import ContractError
from paperlens_mineru.jobs import JobManager
from paperlens_mineru.normalizer import ProcessedJobResult


class FakeRunner:
    def __init__(self, *, block: bool = False, fail: bool = False) -> None:
        self.block = block
        self.fail = fail
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.running = 0
        self.max_running = 0
        self.cancelled: list[str] = []

    async def run_job(self, job, report_stage):
        self.running += 1
        self.max_running = max(self.max_running, self.running)
        self.started.set()
        try:
            await report_stage(JobStage.PREPARING)
            await report_stage(JobStage.PARSING)
            if self.block:
                await self.release.wait()
            if self.fail:
                raise RuntimeError("worker failed at C:\\private\\input.pdf")
            raw_dir = job.directory / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            await report_stage(JobStage.NORMALIZING)
            return raw_dir
        finally:
            self.running -= 1

    async def cancel_job(self, job_id: str) -> None:
        self.cancelled.append(job_id)
        self.release.set()

    async def close(self) -> None:
        self.release.set()


class DisconnectOnCancelRunner(FakeRunner):
    async def run_job(self, job, report_stage):
        self.running += 1
        self.started.set()
        try:
            await report_stage(JobStage.PARSING)
            await self.release.wait()
            raise ConnectionError(r"upstream closed at C:\private")
        finally:
            self.running -= 1


class SuccessfulProcessor:
    async def process(self, job, raw_output_dir, report_stage):
        await report_stage(JobStage.NORMALIZING)
        crop = job.directory / "crops" / "crop_1.jpg"
        crop.parent.mkdir(parents=True)
        crop.write_bytes(b"fake-image")
        result = parse_job_result(
            {
                "schemaVersion": 1,
                "jobId": job.job_id,
                "engine": {"name": "mineru", "version": "3.4.4", "backend": "pipeline"},
                "document": {"pageCount": job.page_count, "displayFormulaCount": 1, "inlineFormulaCount": 2},
                "formulas": [{"id": "formula_1", "latex": "x", "page": 1, "bbox": [1, 2, 3, 4], "cropId": "crop_1"}],
                "warnings": [],
            }
        )
        await report_stage(JobStage.CROPS_READY)
        return ProcessedJobResult(result=result, crops={"crop_1": crop})


class InvalidProcessor:
    async def process(self, job, raw_output_dir, report_stage):
        await report_stage(JobStage.NORMALIZING)
        partial = job.directory / "crops" / "partial.jpg"
        partial.parent.mkdir(parents=True)
        partial.write_bytes(b"partial")
        raise ContractError(ErrorCode.RESULT_INVALID, "MinerU 返回了不完整或无效的结果。", http_status=502)


async def wait_for_state(manager: JobManager, job_id: str, expected: JobState, timeout: float = 2) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if manager.get(job_id).state is expected:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {job_id} 未进入 {expected.value}，当前 {manager.get(job_id).state.value}")


class JobManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    async def asyncTearDown(self) -> None:
        self.temp.cleanup()

    def make_input(self, manager: JobManager) -> tuple[str, Path]:
        job_id, path = manager.allocate_input_path()
        path.write_bytes(b"%PDF-1.4\n%%EOF")
        return job_id, path

    async def test_completed_job_has_truthful_stages_and_deletes_input(self) -> None:
        runner = FakeRunner()
        manager = JobManager(self.root, runner, task_timeout_seconds=2, result_ttl_seconds=60)
        await manager.start()
        try:
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=3)
            await wait_for_state(manager, job_id, JobState.COMPLETED)
            job = manager.get(job_id)
            self.assertEqual(job.stage, JobStage.COMPLETED)
            self.assertFalse(input_path.exists())
            payload = manager.status_payload(job_id)
            self.assertNotIn("progress", payload)
            self.assertNotIn("currentPage", str(payload))
            self.assertNotIn(str(self.root), str(payload))
        finally:
            await manager.close()

    async def test_result_is_published_only_after_crops_are_ready(self) -> None:
        runner = FakeRunner()
        manager = JobManager(
            self.root,
            runner,
            task_timeout_seconds=2,
            result_ttl_seconds=60,
            result_processor=SuccessfulProcessor(),
        )
        await manager.start()
        try:
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=1)
            await wait_for_state(manager, job_id, JobState.COMPLETED)
            payload = manager.status_payload(job_id)
            self.assertEqual(payload["result"]["document"]["displayFormulaCount"], 1)
            self.assertEqual(manager.crop_path(job_id, "crop_1").read_bytes(), b"fake-image")
            self.assertFalse(input_path.exists())
        finally:
            await manager.close()

    async def test_invalid_partial_result_fails_before_completed_and_deletes_input(self) -> None:
        runner = FakeRunner()
        manager = JobManager(
            self.root,
            runner,
            task_timeout_seconds=2,
            result_ttl_seconds=60,
            result_processor=InvalidProcessor(),
        )
        await manager.start()
        try:
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=1)
            await wait_for_state(manager, job_id, JobState.FAILED)
            payload = manager.status_payload(job_id)
            self.assertEqual(payload["error"]["code"], "RESULT_INVALID")
            self.assertNotIn("result", payload)
            self.assertFalse(input_path.exists())
            self.assertFalse((self.root / "jobs" / job_id / "raw").exists())
            self.assertFalse((self.root / "jobs" / job_id / "crops").exists())
        finally:
            await manager.close()

    async def test_single_concurrency_and_finite_queue(self) -> None:
        runner = FakeRunner(block=True)
        manager = JobManager(self.root, runner, task_timeout_seconds=2, result_ttl_seconds=60, max_queued_jobs=1)
        await manager.start()
        try:
            first_id, first_path = self.make_input(manager)
            second_id, second_path = self.make_input(manager)
            third_id, third_path = self.make_input(manager)
            await manager.submit(first_id, first_path, page_count=1)
            await runner.started.wait()
            await manager.submit(second_id, second_path, page_count=1)
            with self.assertRaises(ContractError) as raised:
                await manager.submit(third_id, third_path, page_count=1)
            self.assertEqual(raised.exception.code, ErrorCode.QUEUE_FULL)
            self.assertEqual(manager.get(second_id).state, JobState.QUEUED)
            self.assertEqual(manager.status_payload(second_id)["queuePosition"], 0)
            runner.release.set()
            await wait_for_state(manager, second_id, JobState.COMPLETED)
            self.assertEqual(runner.max_running, 1)
        finally:
            await manager.close()

    async def test_running_cancel_is_idempotent_and_cleans_input(self) -> None:
        runner = FakeRunner(block=True)
        manager = JobManager(self.root, runner, task_timeout_seconds=5, result_ttl_seconds=60)
        await manager.start()
        try:
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=1)
            await runner.started.wait()
            await manager.cancel(job_id)
            await manager.cancel(job_id)
            await wait_for_state(manager, job_id, JobState.CANCELLED)
            self.assertEqual(runner.cancelled, [job_id])
            self.assertFalse(input_path.exists())
        finally:
            await manager.close()

    async def test_disconnect_caused_by_cancel_is_still_cancelled(self) -> None:
        runner = DisconnectOnCancelRunner(block=True)
        manager = JobManager(self.root, runner, task_timeout_seconds=5, result_ttl_seconds=60)
        await manager.start()
        try:
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=1)
            await runner.started.wait()
            await manager.cancel(job_id)
            await wait_for_state(manager, job_id, JobState.CANCELLED)
            payload = manager.status_payload(job_id)
            self.assertNotIn("error", payload)
            self.assertNotIn("private", str(payload))
            self.assertFalse(input_path.exists())
        finally:
            await manager.close()

    async def test_timeout_cancels_runner_and_cleans_input(self) -> None:
        runner = FakeRunner(block=True)
        manager = JobManager(self.root, runner, task_timeout_seconds=0.05, result_ttl_seconds=60)
        await manager.start()
        try:
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=1)
            await wait_for_state(manager, job_id, JobState.TIMED_OUT)
            self.assertEqual(runner.cancelled, [job_id])
            self.assertFalse(input_path.exists())
        finally:
            await manager.close()

    async def test_worker_failure_is_safe_and_input_is_deleted(self) -> None:
        runner = FakeRunner(fail=True)
        manager = JobManager(self.root, runner, task_timeout_seconds=2, result_ttl_seconds=60)
        await manager.start()
        try:
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=1)
            await wait_for_state(manager, job_id, JobState.FAILED)
            payload = manager.status_payload(job_id)
            self.assertEqual(payload["error"]["code"], "JOB_FAILED")
            self.assertNotIn("C:\\private", str(payload))
            self.assertFalse(input_path.exists())
        finally:
            await manager.close()

    async def test_cleanup_expired_terminal_job_and_orphan_input(self) -> None:
        orphan = self.root / "jobs" / "job_orphan"
        orphan.mkdir(parents=True)
        (orphan / "input.pdf").write_bytes(b"%PDF")
        runner = FakeRunner()
        manager = JobManager(self.root, runner, task_timeout_seconds=2, result_ttl_seconds=0)
        await manager.start()
        try:
            self.assertFalse((orphan / "input.pdf").exists())
            job_id, input_path = self.make_input(manager)
            await manager.submit(job_id, input_path, page_count=1)
            await wait_for_state(manager, job_id, JobState.COMPLETED)
            removed = manager.cleanup_expired()
            self.assertIn(job_id, removed)
            with self.assertRaises(ContractError) as raised:
                manager.get(job_id)
            self.assertEqual(raised.exception.code, ErrorCode.JOB_NOT_FOUND)
        finally:
            await manager.close()


if __name__ == "__main__":
    unittest.main()
