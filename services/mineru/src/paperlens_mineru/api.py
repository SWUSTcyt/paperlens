from __future__ import annotations

import asyncio
import shutil
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated, Callable
from uuid import uuid4

from fastapi import FastAPI, File, Header, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response

from .auth import require_bearer_token
from .config import ServiceConfig
from .contracts import CONTRACT_SCHEMA_VERSION, ErrorCode, contract_error_payload, ensure_compatible_client
from .errors import ContractError
from .jobs import JobManager, JobResultProcessor, JobRunner


PageCounter = Callable[[Path], int]


def create_app(
    config: ServiceConfig,
    *,
    runner: JobRunner,
    result_processor: JobResultProcessor | None = None,
    page_counter: PageCounter | None = None,
    allowed_hosts: set[str] | None = None,
) -> FastAPI:
    hosts = allowed_hosts or {"127.0.0.1"}
    counter = page_counter or count_pdf_pages
    manager = JobManager(
        config.data_root,
        runner,
        task_timeout_seconds=config.task_timeout_seconds,
        result_ttl_seconds=config.result_ttl_seconds,
        max_queued_jobs=1,
        result_processor=result_processor,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await manager.start()
        app.state.job_manager = manager
        cleanup = asyncio.create_task(_cleanup_loop(manager), name="paperlens-mineru-ttl-cleanup")
        try:
            yield
        finally:
            cleanup.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup
            await manager.close()

    app = FastAPI(
        title="PaperLens MinerU Local Service",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.job_manager = manager

    @app.middleware("http")
    async def enforce_loopback_host(request: Request, call_next):
        request.state.request_id = f"req_{uuid4().hex}"
        host = request.headers.get("host", "").split(":", 1)[0].lower()
        if host not in hosts:
            error = ContractError(ErrorCode.INVALID_REQUEST, "只接受 127.0.0.1 本机请求。", http_status=403)
            return _error_response(request, error)
        return await call_next(request)

    @app.exception_handler(ContractError)
    async def handle_contract_error(request: Request, error: ContractError):
        return _error_response(request, error)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, error: RequestValidationError):
        contract_error = ContractError(
            ErrorCode.INVALID_REQUEST,
            "请求字段不符合 schema v1。",
            http_status=400,
            internal_detail=str(error),
        )
        return _error_response(request, contract_error)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, error: Exception):
        contract_error = ContractError(
            ErrorCode.INTERNAL_ERROR,
            "本地 MinerU 服务发生内部错误。",
            http_status=500,
            internal_detail=str(error),
        )
        return _error_response(request, contract_error)

    async def authorize(
        authorization: str | None,
        schema_version: str | None,
    ) -> None:
        require_bearer_token(authorization, config.access_token)
        try:
            parsed_schema = int(schema_version) if schema_version is not None else None
        except ValueError:
            parsed_schema = None
        ensure_compatible_client(parsed_schema)

    @app.get("/v1/health")
    async def health() -> dict[str, object]:
        return {
            "schemaVersion": CONTRACT_SCHEMA_VERSION,
            "service": "paperlens-mineru",
            "serviceVersion": "0.1.0",
            "status": "ready" if manager.started and not manager.closed else "starting",
            "engine": {"name": "mineru", "version": config.mineru_version, "backend": config.backend},
            "limits": {
                "maxPdfBytes": config.max_pdf_bytes,
                "maxPdfPages": config.max_pdf_pages,
                "maxConcurrentJobs": config.max_concurrent_jobs,
                "taskTimeoutSeconds": config.task_timeout_seconds,
                "resultTtlSeconds": config.result_ttl_seconds,
            },
            "capabilities": {
                "displayFormulas": True,
                "inlineFormulaCount": True,
                "crops": True,
                # MinerU pipeline 3.4.4 没有稳定页级事件，明确声明不可用。
                "truthfulPageProgress": False,
            },
        }

    @app.post("/v1/jobs", status_code=202)
    async def create_job(
        file: Annotated[UploadFile, File()],
        authorization: Annotated[str | None, Header()] = None,
        schema_version: Annotated[str | None, Header(alias="X-PaperLens-Schema-Version")] = None,
    ) -> JSONResponse:
        await authorize(authorization, schema_version)
        job_id, input_path = manager.allocate_input_path()
        try:
            await _save_limited_pdf(file, input_path, max_bytes=config.max_pdf_bytes)
            try:
                pages = await asyncio.to_thread(counter, input_path)
            except Exception as error:
                raise ContractError(
                    ErrorCode.PDF_INVALID,
                    "无法读取 PDF 页数；文件可能已损坏。",
                    http_status=400,
                    internal_detail=str(error),
                ) from error
            if pages > config.max_pdf_pages:
                raise ContractError(
                    ErrorCode.PDF_TOO_MANY_PAGES,
                    "PDF 超过 500 页上限。",
                    http_status=413,
                )
            if pages < 1:
                raise ContractError(ErrorCode.PDF_INVALID, "PDF 不包含有效页面。", http_status=400)
            job = await manager.submit(job_id, input_path, page_count=pages)
            return JSONResponse(status_code=202, content=manager.status_payload(job.job_id))
        except Exception:
            input_path.unlink(missing_ok=True)
            shutil.rmtree(input_path.parent, ignore_errors=True)
            raise
        finally:
            await file.close()

    @app.get("/v1/jobs/{job_id}")
    async def get_job(
        job_id: str,
        authorization: Annotated[str | None, Header()] = None,
        schema_version: Annotated[str | None, Header(alias="X-PaperLens-Schema-Version")] = None,
    ) -> dict[str, object]:
        await authorize(authorization, schema_version)
        return manager.status_payload(job_id)

    @app.get("/v1/jobs/{job_id}/crops/{crop_id}")
    async def get_crop(
        job_id: str,
        crop_id: str,
        authorization: Annotated[str | None, Header()] = None,
        schema_version: Annotated[str | None, Header(alias="X-PaperLens-Schema-Version")] = None,
    ) -> FileResponse:
        await authorize(authorization, schema_version)
        path = manager.crop_path(job_id, crop_id)
        media_types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
        media_type = media_types.get(path.suffix.lower())
        if media_type is None:
            raise ContractError(ErrorCode.RESULT_INVALID, "裁剪图格式无效。", http_status=502)
        return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, no-store"})

    @app.post("/v1/jobs/{job_id}/cancel")
    async def cancel_job(
        job_id: str,
        authorization: Annotated[str | None, Header()] = None,
        schema_version: Annotated[str | None, Header(alias="X-PaperLens-Schema-Version")] = None,
    ) -> dict[str, object]:
        await authorize(authorization, schema_version)
        await manager.cancel(job_id)
        return manager.status_payload(job_id)

    @app.delete("/v1/jobs/{job_id}", status_code=204)
    async def delete_job(
        job_id: str,
        authorization: Annotated[str | None, Header()] = None,
        schema_version: Annotated[str | None, Header(alias="X-PaperLens-Schema-Version")] = None,
    ) -> Response:
        await authorize(authorization, schema_version)
        manager.delete(job_id)
        return Response(status_code=204)

    return app


async def _save_limited_pdf(file: UploadFile, destination: Path, *, max_bytes: int) -> None:
    size = 0
    prefix = bytearray()
    try:
        with destination.open("xb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise ContractError(
                        ErrorCode.PDF_TOO_LARGE,
                        "PDF 超过 200 MiB 上限。",
                        http_status=413,
                    )
                if len(prefix) < 1024:
                    prefix.extend(chunk[: 1024 - len(prefix)])
                output.write(chunk)
        if size == 0 or b"%PDF-" not in bytes(prefix):
            raise ContractError(ErrorCode.PDF_INVALID, "上传内容不是有效 PDF。", http_status=400)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def count_pdf_pages(path: Path) -> int:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    try:
        return len(document)
    finally:
        document.close()


async def _cleanup_loop(manager: JobManager) -> None:
    interval = max(30.0, min(300.0, manager.result_ttl_seconds / 4))
    while True:
        await asyncio.sleep(interval)
        manager.cleanup_expired()


def _error_response(request: Request, error: ContractError) -> JSONResponse:
    request_id = getattr(request.state, "request_id", f"req_{uuid4().hex}")
    return JSONResponse(
        status_code=error.http_status,
        content=contract_error_payload(error, request_id=request_id),
        headers={"Cache-Control": "no-store"},
    )
