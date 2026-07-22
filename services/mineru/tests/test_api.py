from __future__ import annotations

import asyncio
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from paperlens_mineru.api import create_app
from paperlens_mineru.config import ServiceConfig
from paperlens_mineru.contracts import JobStage, parse_job_result
from paperlens_mineru.normalizer import ProcessedJobResult


TOKEN = "api-test-token-value-with-at-least-32-chars"


class ApiRunner:
    def __init__(self, *, block: bool = False) -> None:
        self.block = block
        self.release = asyncio.Event()
        self.cancelled: list[str] = []

    async def run_job(self, job, report_stage):
        await report_stage(JobStage.PREPARING)
        await report_stage(JobStage.PARSING)
        if self.block:
            await self.release.wait()
        raw = job.directory / "raw"
        raw.mkdir(parents=True, exist_ok=True)
        await report_stage(JobStage.NORMALIZING)
        return raw

    async def cancel_job(self, job_id: str) -> None:
        self.cancelled.append(job_id)
        self.release.set()

    async def close(self) -> None:
        self.release.set()


class ApiProcessor:
    async def process(self, job, raw_output_dir, report_stage):
        await report_stage(JobStage.NORMALIZING)
        crop = job.directory / "crops" / "crop_1.jpg"
        crop.parent.mkdir(parents=True)
        crop.write_bytes(b"crop-bytes")
        result = parse_job_result(
            {
                "schemaVersion": 1,
                "jobId": job.job_id,
                "engine": {"name": "mineru", "version": "3.4.4", "backend": "pipeline"},
                "document": {"pageCount": job.page_count, "displayFormulaCount": 1, "inlineFormulaCount": 3},
                "formulas": [{"id": "formula_1", "latex": "x", "page": 1, "bbox": [1, 2, 3, 4], "cropId": "crop_1"}],
                "warnings": [],
            }
        )
        await report_stage(JobStage.CROPS_READY)
        return ProcessedJobResult(result=result, crops={"crop_1": crop})


def auth_headers(*, host: str = "testserver", schema: str = "1") -> dict[str, str]:
    return {
        "Host": host,
        "Authorization": f"Bearer {TOKEN}",
        "X-PaperLens-Schema-Version": schema,
    }


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = ServiceConfig(access_token=TOKEN, data_root=self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def create_client(
        self,
        runner: ApiRunner | None = None,
        *,
        config: ServiceConfig | None = None,
        page_count=1,
        result_processor=None,
    ):
        app = create_app(
            config or self.config,
            runner=runner or ApiRunner(),
            result_processor=result_processor,
            page_counter=lambda _: page_count,
            allowed_hosts={"127.0.0.1", "testserver"},
        )
        return TestClient(app), app

    def test_health_is_minimal_unauthenticated_and_matches_frozen_contract(self) -> None:
        client, _ = self.create_client()
        with client:
            response = client.get("/v1/health", headers={"Host": "testserver"})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["engine"], {"name": "mineru", "version": "3.4.4", "backend": "pipeline"})
        self.assertEqual(payload["limits"]["maxPdfBytes"], 200 * 1024 * 1024)
        self.assertFalse(payload["capabilities"]["truthfulPageProgress"])
        self.assertNotIn("token", str(payload).lower())
        self.assertNotIn(str(self.root), str(payload))

    def test_submit_poll_complete_and_delete_without_path_leak(self) -> None:
        client, app = self.create_client()
        with client:
            response = client.post(
                "/v1/jobs",
                headers=auth_headers(),
                files={"file": ("secret-name.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")},
            )
            self.assertEqual(response.status_code, 202, response.text)
            job_id = response.json()["jobId"]
            deadline = time.time() + 2
            payload = {}
            while time.time() < deadline:
                payload = client.get(f"/v1/jobs/{job_id}", headers=auth_headers()).json()
                if payload["state"] == "completed":
                    break
                time.sleep(0.01)
            self.assertEqual(payload["state"], "completed")
            self.assertNotIn("progress", payload)
            self.assertNotIn("secret-name", str(payload))
            self.assertNotIn(str(self.root), str(payload))
            self.assertFalse(app.state.job_manager.get(job_id).input_path.exists())
            deleted = client.delete(f"/v1/jobs/{job_id}", headers=auth_headers())
            self.assertEqual(deleted.status_code, 204)
            missing = client.get(f"/v1/jobs/{job_id}", headers=auth_headers())
            self.assertEqual(missing.status_code, 404)

    def test_cancel_is_idempotent_and_returns_terminal_status(self) -> None:
        runner = ApiRunner(block=True)
        client, _ = self.create_client(runner)
        with client:
            created = client.post(
                "/v1/jobs",
                headers=auth_headers(),
                files={"file": ("paper.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")},
            )
            job_id = created.json()["jobId"]
            first = client.post(f"/v1/jobs/{job_id}/cancel", headers=auth_headers())
            second = client.post(f"/v1/jobs/{job_id}/cancel", headers=auth_headers())
            self.assertEqual(first.status_code, 200)
            self.assertEqual(second.status_code, 200)
            self.assertIn(second.json()["state"], {"cancelling", "cancelled"})

    def test_auth_schema_and_host_failures_are_stable(self) -> None:
        client, _ = self.create_client()
        with client:
            missing_auth = client.get("/v1/jobs/not-found", headers={"Host": "testserver", "X-PaperLens-Schema-Version": "1"})
            wrong_schema = client.get("/v1/jobs/not-found", headers=auth_headers(schema="2"))
            remote_host = client.get("/v1/health", headers={"Host": "ocr.example"})
        self.assertEqual(missing_auth.status_code, 401)
        self.assertEqual(missing_auth.json()["error"]["code"], "AUTH_REQUIRED")
        self.assertEqual(wrong_schema.status_code, 409)
        self.assertEqual(wrong_schema.json()["error"]["code"], "VERSION_INCOMPATIBLE")
        self.assertEqual(remote_host.status_code, 403)
        self.assertEqual(remote_host.json()["error"]["code"], "INVALID_REQUEST")

    def test_completed_result_and_crop_require_auth_and_never_expose_paths(self) -> None:
        client, _ = self.create_client(result_processor=ApiProcessor())
        with client:
            created = client.post(
                "/v1/jobs",
                headers=auth_headers(),
                files={"file": ("paper.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")},
            )
            job_id = created.json()["jobId"]
            deadline = time.time() + 2
            payload = {}
            while time.time() < deadline:
                payload = client.get(f"/v1/jobs/{job_id}", headers=auth_headers()).json()
                if payload["state"] == "completed":
                    break
                time.sleep(0.01)
            self.assertEqual(payload["result"]["formulas"][0]["cropId"], "crop_1")
            crop = client.get(f"/v1/jobs/{job_id}/crops/crop_1", headers=auth_headers())
            self.assertEqual(crop.status_code, 200)
            self.assertEqual(crop.content, b"crop-bytes")
            self.assertEqual(crop.headers["content-type"], "image/jpeg")
            self.assertEqual(crop.headers["cache-control"], "private, no-store")
            unauthenticated = client.get(
                f"/v1/jobs/{job_id}/crops/crop_1",
                headers={"Host": "testserver", "X-PaperLens-Schema-Version": "1"},
            )
            missing = client.get(f"/v1/jobs/{job_id}/crops/missing", headers=auth_headers())
        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(missing.status_code, 404)
        self.assertNotIn(str(self.root), str(payload))

    def test_rejects_bad_signature_size_and_page_limit_and_cleans_upload(self) -> None:
        cases = [
            (self.config, b"not-a-pdf", 1, "PDF_INVALID"),
            (replace(self.config, max_pdf_bytes=8), b"%PDF-1.4\n%%EOF", 1, "PDF_TOO_LARGE"),
            (self.config, b"%PDF-1.4\n%%EOF", 501, "PDF_TOO_MANY_PAGES"),
        ]
        for config, content, pages, code in cases:
            with self.subTest(code=code):
                client, _ = self.create_client(config=config, page_count=pages)
                with client:
                    response = client.post(
                        "/v1/jobs",
                        headers=auth_headers(),
                        files={"file": ("paper.pdf", content, "application/pdf")},
                    )
                self.assertIn(response.status_code, {400, 413})
                self.assertEqual(response.json()["error"]["code"], code)
                self.assertEqual(list((self.root / "jobs").glob("job_*/input.pdf")), [])


if __name__ == "__main__":
    unittest.main()
