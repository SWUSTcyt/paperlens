from __future__ import annotations

import json
import unittest
from pathlib import Path

from paperlens_mineru.contracts import (
    CONTRACT_SCHEMA_VERSION,
    ErrorCode,
    JobStage,
    JobState,
    contract_error_payload,
    ensure_compatible_client,
    parse_job_result,
)
from paperlens_mineru.config import (
    BACKEND,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_CONCURRENT_JOBS,
    DEFAULT_MAX_PAGES,
    DEFAULT_TASK_TIMEOUT_SECONDS,
    DEFAULT_TTL_SECONDS,
    MINERU_VERSION,
)
from paperlens_mineru.errors import ContractError


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
SCHEMAS = ROOT / "schemas" / "v1"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class ContractTests(unittest.TestCase):
    def test_accepts_complete_result_and_normalizes_immutable_model(self) -> None:
        result = parse_job_result(load_fixture("job-result.valid.json"))
        self.assertEqual(result.schema_version, 1)
        self.assertEqual(result.engine.version, "3.4.4")
        self.assertEqual(result.engine.backend, "pipeline")
        self.assertEqual(result.document.display_formula_count, 1)
        self.assertEqual(result.document.inline_formula_count, 58)
        self.assertEqual(result.formulas[0].bbox, (100, 210, 900, 320))
        self.assertNotIn("localPath", result.to_dict()["formulas"][0])

    def test_zero_display_formulas_is_a_valid_completed_result(self) -> None:
        result = parse_job_result(load_fixture("job-result.zero-display.json"))
        self.assertEqual(result.document.display_formula_count, 0)
        self.assertEqual(result.document.inline_formula_count, 58)
        self.assertEqual(result.formulas, ())

    def test_rejects_invalid_bbox_page_count_and_path_fields(self) -> None:
        base = load_fixture("job-result.valid.json")
        cases = []

        invalid_bbox = json.loads(json.dumps(base))
        invalid_bbox["formulas"][0]["bbox"] = [100, 210, 1001, 320]
        cases.append(invalid_bbox)

        invalid_page = json.loads(json.dumps(base))
        invalid_page["formulas"][0]["page"] = 17
        cases.append(invalid_page)

        mismatched_count = json.loads(json.dumps(base))
        mismatched_count["document"]["displayFormulaCount"] = 2
        cases.append(mismatched_count)

        leaked_path = json.loads(json.dumps(base))
        leaked_path["formulas"][0]["localPath"] = r"C:\secret\crop.png"
        cases.append(leaked_path)

        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(ContractError) as raised:
                parse_job_result(payload)
            self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)
            self.assertNotIn("C:\\secret", str(raised.exception))

    def test_version_incompatibility_has_stable_error(self) -> None:
        ensure_compatible_client(CONTRACT_SCHEMA_VERSION)
        with self.assertRaises(ContractError) as raised:
            ensure_compatible_client(2)
        self.assertEqual(raised.exception.code, ErrorCode.VERSION_INCOMPATIBLE)
        self.assertEqual(raised.exception.http_status, 409)

    def test_error_payload_never_reflects_secrets_or_internal_details(self) -> None:
        error = ContractError(
            ErrorCode.AUTH_INVALID,
            "访问凭证无效。",
            http_status=401,
            internal_detail="Bearer top-secret at C:\\private",
        )
        payload = contract_error_payload(error, request_id="req_abc")
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["error"]["code"], "AUTH_INVALID")
        self.assertEqual(payload["requestId"], "req_abc")
        self.assertNotIn("top-secret", serialized)
        self.assertNotIn("C:\\private", serialized)

    def test_schema_documents_are_strict_and_synced_with_enums(self) -> None:
        result_schema = json.loads((SCHEMAS / "job-result.schema.json").read_text(encoding="utf-8"))
        status_schema = json.loads((SCHEMAS / "job-status.schema.json").read_text(encoding="utf-8"))
        error_schema = json.loads((SCHEMAS / "error.schema.json").read_text(encoding="utf-8"))
        health_schema = json.loads((SCHEMAS / "health.schema.json").read_text(encoding="utf-8"))

        self.assertFalse(result_schema["additionalProperties"])
        self.assertFalse(status_schema["additionalProperties"])
        self.assertEqual(set(status_schema["properties"]["state"]["enum"]), {item.value for item in JobState})
        self.assertEqual(set(status_schema["properties"]["stage"]["enum"]), {item.value for item in JobStage})
        self.assertEqual(
            set(error_schema["$defs"]["error"]["properties"]["code"]["enum"]),
            {item.value for item in ErrorCode},
        )
        engine = health_schema["properties"]["engine"]["properties"]
        limits = health_schema["properties"]["limits"]["properties"]
        self.assertEqual((engine["version"]["const"], engine["backend"]["const"]), (MINERU_VERSION, BACKEND))
        self.assertEqual(
            (
                limits["maxPdfBytes"]["const"],
                limits["maxPdfPages"]["const"],
                limits["maxConcurrentJobs"]["const"],
                limits["taskTimeoutSeconds"]["const"],
                limits["resultTtlSeconds"]["const"],
            ),
            (
                DEFAULT_MAX_BYTES,
                DEFAULT_MAX_PAGES,
                DEFAULT_MAX_CONCURRENT_JOBS,
                DEFAULT_TASK_TIMEOUT_SECONDS,
                DEFAULT_TTL_SECONDS,
            ),
        )


if __name__ == "__main__":
    unittest.main()
