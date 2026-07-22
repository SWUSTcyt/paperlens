from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping, Sequence

from .errors import ContractError


CONTRACT_SCHEMA_VERSION = 1
_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ErrorCode(str, Enum):
    AUTH_REQUIRED = "AUTH_REQUIRED"
    AUTH_INVALID = "AUTH_INVALID"
    CONFIG_INVALID = "CONFIG_INVALID"
    VERSION_INCOMPATIBLE = "VERSION_INCOMPATIBLE"
    INVALID_REQUEST = "INVALID_REQUEST"
    PDF_INVALID = "PDF_INVALID"
    PDF_TOO_LARGE = "PDF_TOO_LARGE"
    PDF_TOO_MANY_PAGES = "PDF_TOO_MANY_PAGES"
    SERVICE_NOT_READY = "SERVICE_NOT_READY"
    QUEUE_FULL = "QUEUE_FULL"
    JOB_NOT_FOUND = "JOB_NOT_FOUND"
    JOB_FAILED = "JOB_FAILED"
    JOB_CANCELLED = "JOB_CANCELLED"
    JOB_TIMED_OUT = "JOB_TIMED_OUT"
    RESULT_INVALID = "RESULT_INVALID"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class JobState(str, Enum):
    ACCEPTED = "accepted"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    FAILED = "failed"
    TIMED_OUT = "timed-out"


class JobStage(str, Enum):
    ACCEPTED = "accepted"
    QUEUED = "queued"
    PREPARING = "preparing"
    LOADING_MODEL = "loading-model"
    PARSING = "parsing"
    NORMALIZING = "normalizing"
    CROPS_READY = "crops-ready"
    COMPLETED = "completed"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    FAILED = "failed"
    TIMED_OUT = "timed-out"


@dataclass(frozen=True)
class EngineInfo:
    name: str
    version: str
    backend: str

    def to_dict(self) -> dict[str, object]:
        return {"name": self.name, "version": self.version, "backend": self.backend}


@dataclass(frozen=True)
class DocumentInfo:
    page_count: int
    display_formula_count: int
    inline_formula_count: int

    def to_dict(self) -> dict[str, int]:
        return {
            "pageCount": self.page_count,
            "displayFormulaCount": self.display_formula_count,
            "inlineFormulaCount": self.inline_formula_count,
        }


@dataclass(frozen=True)
class FormulaResult:
    id: str
    latex: str
    page: int
    bbox: tuple[int, int, int, int]
    crop_id: str | None = None
    section_path: str | None = None
    context: str | None = None

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "id": self.id,
            "latex": self.latex,
            "page": self.page,
            "bbox": list(self.bbox),
        }
        if self.crop_id is not None:
            result["cropId"] = self.crop_id
        if self.section_path is not None:
            result["sectionPath"] = self.section_path
        if self.context is not None:
            result["context"] = self.context
        return result


@dataclass(frozen=True)
class WarningInfo:
    code: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class JobResult:
    schema_version: int
    job_id: str
    engine: EngineInfo
    document: DocumentInfo
    formulas: tuple[FormulaResult, ...]
    warnings: tuple[WarningInfo, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "jobId": self.job_id,
            "engine": self.engine.to_dict(),
            "document": self.document.to_dict(),
            "formulas": [formula.to_dict() for formula in self.formulas],
            "warnings": [warning.to_dict() for warning in self.warnings],
        }


def ensure_compatible_client(schema_version: object) -> None:
    if type(schema_version) is not int or schema_version != CONTRACT_SCHEMA_VERSION:
        raise ContractError(
            ErrorCode.VERSION_INCOMPATIBLE,
            f"仅支持 schema v{CONTRACT_SCHEMA_VERSION}。",
            http_status=409,
        )


def parse_job_result(payload: object) -> JobResult:
    """严格解析完整结果；任何未知或越界字段都会拒绝整份结果。"""

    try:
        root = _mapping(payload, "result")
        _exact_keys(root, {"schemaVersion", "jobId", "engine", "document", "formulas", "warnings"})
        ensure_compatible_client(root["schemaVersion"])
        job_id = _identifier(root["jobId"], "jobId")

        engine_raw = _mapping(root["engine"], "engine")
        _exact_keys(engine_raw, {"name", "version", "backend"})
        engine = EngineInfo(
            name=_exact_string(engine_raw["name"], "engine.name", "mineru"),
            version=_exact_string(engine_raw["version"], "engine.version", "3.4.4"),
            backend=_exact_string(engine_raw["backend"], "engine.backend", "pipeline"),
        )

        document_raw = _mapping(root["document"], "document")
        _exact_keys(document_raw, {"pageCount", "displayFormulaCount", "inlineFormulaCount"})
        document = DocumentInfo(
            page_count=_integer(document_raw["pageCount"], "document.pageCount", minimum=1, maximum=500),
            display_formula_count=_integer(
                document_raw["displayFormulaCount"], "document.displayFormulaCount", minimum=0, maximum=100_000
            ),
            inline_formula_count=_integer(
                document_raw["inlineFormulaCount"], "document.inlineFormulaCount", minimum=0, maximum=1_000_000
            ),
        )

        formulas_raw = _sequence(root["formulas"], "formulas")
        formulas = tuple(_parse_formula(item, document.page_count) for item in formulas_raw)
        if document.display_formula_count != len(formulas):
            raise ValueError("display formula count mismatch")
        if len({formula.id for formula in formulas}) != len(formulas):
            raise ValueError("duplicate formula id")

        warnings_raw = _sequence(root["warnings"], "warnings")
        warnings = tuple(_parse_warning(item) for item in warnings_raw)
        return JobResult(
            schema_version=CONTRACT_SCHEMA_VERSION,
            job_id=job_id,
            engine=engine,
            document=document,
            formulas=formulas,
            warnings=warnings,
        )
    except ContractError:
        raise
    except (KeyError, TypeError, ValueError) as error:
        raise ContractError(
            ErrorCode.RESULT_INVALID,
            "MinerU 返回结果不符合 schema v1。",
            http_status=502,
            internal_detail=str(error),
        ) from error


def contract_error_payload(error: ContractError, *, request_id: str) -> dict[str, object]:
    code = error.code.value if isinstance(error.code, Enum) else str(error.code)
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "requestId": request_id,
        "error": {"code": code, "message": error.safe_message},
    }


def _parse_formula(payload: object, page_count: int) -> FormulaResult:
    item = _mapping(payload, "formula")
    allowed = {"id", "latex", "page", "bbox", "cropId", "sectionPath", "context"}
    required = {"id", "latex", "page", "bbox"}
    _keys(item, required, allowed)
    bbox_values = _sequence(item["bbox"], "formula.bbox")
    if len(bbox_values) != 4:
        raise ValueError("bbox length")
    bbox = tuple(_integer(value, "formula.bbox", minimum=0, maximum=1000) for value in bbox_values)
    x0, y0, x1, y1 = bbox
    if x0 >= x1 or y0 >= y1:
        raise ValueError("bbox order")
    return FormulaResult(
        id=_identifier(item["id"], "formula.id"),
        latex=_bounded_string(item["latex"], "formula.latex", minimum=1, maximum=200_000),
        page=_integer(item["page"], "formula.page", minimum=1, maximum=page_count),
        bbox=(x0, y0, x1, y1),
        crop_id=_optional_identifier(item.get("cropId"), "formula.cropId"),
        section_path=_optional_bounded_string(item.get("sectionPath"), "formula.sectionPath", 500),
        context=_optional_bounded_string(item.get("context"), "formula.context", 2000),
    )


def _parse_warning(payload: object) -> WarningInfo:
    item = _mapping(payload, "warning")
    _exact_keys(item, {"code", "message"})
    return WarningInfo(
        code=_identifier(item["code"], "warning.code"),
        message=_bounded_string(item["message"], "warning.message", minimum=1, maximum=1000),
    )


def _mapping(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be object")
    return value


def _sequence(value: object, name: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be array")
    return value


def _exact_keys(value: Mapping[str, Any], expected: set[str]) -> None:
    _keys(value, expected, expected)


def _keys(value: Mapping[str, Any], required: set[str], allowed: set[str]) -> None:
    keys = set(value)
    if not required.issubset(keys) or not keys.issubset(allowed):
        raise ValueError("object keys mismatch")


def _identifier(value: object, name: str) -> str:
    if not isinstance(value, str) or not _ID_PATTERN.fullmatch(value):
        raise ValueError(f"{name} invalid")
    return value


def _optional_identifier(value: object, name: str) -> str | None:
    return None if value is None else _identifier(value, name)


def _bounded_string(value: object, name: str, *, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        raise ValueError(f"{name} invalid")
    return value


def _optional_bounded_string(value: object, name: str, maximum: int) -> str | None:
    if value is None:
        return None
    return _bounded_string(value, name, minimum=1, maximum=maximum)


def _integer(value: object, name: str, *, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} invalid")
    return value


def _exact_string(value: object, name: str, expected: str) -> str:
    if value != expected or not isinstance(value, str):
        raise ValueError(f"{name} invalid")
    return value
