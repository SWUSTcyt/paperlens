from __future__ import annotations

import io
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import httpx

from paperlens_mineru.contracts import ErrorCode, JobStage
from paperlens_mineru.errors import ContractError
from paperlens_mineru.config import ServiceConfig
from paperlens_mineru.upstream import (
    MineruUpstreamRunner,
    add_current_python_packages,
    build_upstream_environment,
    safe_extract_zip,
    validate_upstream_task_id,
)


class FakeSupervisor:
    def __init__(self, root: Path) -> None:
        self.output_root = root / "upstream"
        self.output_root.mkdir()
        self.cancelled: list[str] = []

    async def ensure_ready(self, report_stage) -> str:
        await report_stage(JobStage.LOADING_MODEL)
        return "http://127.0.0.1:19000"

    async def restart(self, job_id: str) -> None:
        self.cancelled.append(job_id)

    async def close(self) -> None:
        pass


class FakeJob:
    def __init__(self, root: Path) -> None:
        self.job_id = "job_0123456789abcdef0123456789abcdef"
        self.directory = root / self.job_id
        self.directory.mkdir()
        self.input_path = self.directory / "input.pdf"
        self.input_path.write_bytes(b"%PDF-1.4\n%%EOF")


class UpstreamTests(unittest.TestCase):
    def test_upstream_environment_does_not_inherit_paperlens_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = ServiceConfig(access_token="s" * 43, data_root=root)
            with patch.dict(
                "os.environ",
                {
                    "PAPERLENS_MINERU_TOKEN": "must-not-leak",
                    "PAPERLENS_MINERU_PORT": "17860",
                    "MINERU_MODEL_SOURCE": "huggingface",
                },
                clear=True,
            ):
                environment = build_upstream_environment(config, root / "upstream")
            self.assertNotIn("PAPERLENS_MINERU_TOKEN", environment)
            self.assertNotIn("PAPERLENS_MINERU_PORT", environment)
            self.assertEqual(environment["MINERU_MODEL_SOURCE"], "huggingface")
            self.assertEqual(environment["MINERU_API_MAX_CONCURRENT_REQUESTS"], "1")

    def test_base_python_environment_keeps_current_venv_packages(self) -> None:
        environment = add_current_python_packages({"PYTHONPATH": "F:/custom"})
        paths = environment["PYTHONPATH"].split(os.pathsep)
        self.assertIn("F:/custom", paths)
        self.assertTrue(any(path.endswith("site-packages") for path in paths))

    def test_safe_zip_extracts_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "result.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("paper/auto/paper_content_list.json", "[]")
            destination = root / "raw"
            safe_extract_zip(archive, destination)
            self.assertEqual((destination / "paper/auto/paper_content_list.json").read_text(), "[]")

    def test_safe_zip_rejects_traversal_links_and_oversize(self) -> None:
        payloads = ["../escape.txt", "/absolute.txt", "C:/drive.txt"]
        for member in payloads:
            with self.subTest(member=member), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "result.zip"
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr(member, "bad")
                with self.assertRaises(ContractError) as raised:
                    safe_extract_zip(archive, Path(directory) / "raw")
                self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)

        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "result.zip"
            with zipfile.ZipFile(archive, "w") as output:
                info = zipfile.ZipInfo("link")
                info.external_attr = 0o120777 << 16
                output.writestr(info, "target")
            with self.assertRaises(ContractError):
                safe_extract_zip(archive, Path(directory) / "raw")

    def test_upstream_task_id_is_opaque_and_path_safe(self) -> None:
        self.assertEqual(validate_upstream_task_id("7a9d2c3e-78c4-44ac-bbd1-eebea54ff123"), "7a9d2c3e-78c4-44ac-bbd1-eebea54ff123")
        for value in ("../task", "C:\\task", "task/child", ""):
            with self.subTest(value=value), self.assertRaises(ContractError):
                validate_upstream_task_id(value)


class UpstreamRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_maps_real_upstream_states_and_extracts_zip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            supervisor = FakeSupervisor(root)
            job = FakeJob(root)
            stages: list[JobStage] = []
            statuses = iter(["pending", "processing", "completed"])
            archive_buffer = io.BytesIO()
            with zipfile.ZipFile(archive_buffer, "w") as output:
                output.writestr("paper/auto/paper_content_list.json", "[]")

            async def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST" and request.url.path == "/tasks":
                    body = await request.aread()
                    self.assertIn(b'name="backend"', body)
                    self.assertIn(b"pipeline", body)
                    self.assertIn(b'name="formula_enable"', body)
                    return httpx.Response(202, json={"task_id": "7a9d2c3e-78c4-44ac-bbd1-eebea54ff123"})
                if request.method == "GET" and request.url.path.endswith("/result"):
                    return httpx.Response(200, content=archive_buffer.getvalue(), headers={"content-type": "application/zip"})
                if request.method == "GET" and request.url.path.startswith("/tasks/"):
                    return httpx.Response(200, json={"status": next(statuses), "queued_ahead": 0})
                return httpx.Response(404)

            runner = MineruUpstreamRunner(
                supervisor,
                transport=httpx.MockTransport(handler),
                poll_interval_seconds=0,
            )
            raw = await runner.run_job(job, lambda stage: _append_stage(stages, stage))
            self.assertEqual(
                stages,
                [JobStage.LOADING_MODEL, JobStage.QUEUED, JobStage.PARSING, JobStage.NORMALIZING],
            )
            self.assertTrue((raw / "paper/auto/paper_content_list.json").is_file())
            self.assertFalse((job.directory / "result.zip").exists())

    async def test_cancel_restarts_owned_upstream_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            supervisor = FakeSupervisor(Path(directory))
            runner = MineruUpstreamRunner(supervisor, transport=httpx.MockTransport(lambda _: httpx.Response(500)))
            await runner.cancel_job("job_safe")
            self.assertEqual(supervisor.cancelled, ["job_safe"])

    async def test_rejects_failed_or_malformed_upstream_without_leaking_detail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            supervisor = FakeSupervisor(root)
            job = FakeJob(root)

            async def handler(request: httpx.Request) -> httpx.Response:
                if request.method == "POST":
                    return httpx.Response(202, json={"task_id": "../private"})
                return httpx.Response(500, text=r"C:\\secret")

            runner = MineruUpstreamRunner(supervisor, transport=httpx.MockTransport(handler), poll_interval_seconds=0)
            with self.assertRaises(ContractError) as raised:
                await runner.run_job(job, lambda stage: _append_stage([], stage))
            self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)
            self.assertNotIn("secret", str(raised.exception))


async def _append_stage(stages: list[JobStage], stage: JobStage) -> None:
    stages.append(stage)


if __name__ == "__main__":
    unittest.main()
