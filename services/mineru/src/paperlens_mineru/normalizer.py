from __future__ import annotations

import asyncio
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from PIL import Image, UnidentifiedImageError

from .contracts import (
    CONTRACT_SCHEMA_VERSION,
    DocumentInfo,
    EngineInfo,
    ErrorCode,
    FormulaResult,
    JobResult,
    JobStage,
    WarningInfo,
    parse_job_result,
)
from .errors import ContractError
from .jobs import JobRecord, StageReporter


_MAX_JSON_BYTES = 128 * 1024 * 1024
_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_IMAGE_PIXELS = 80_000_000
_DISPLAY_TYPES = {"equation", "equation_interline", "interline_equation"}
_INLINE_TYPES = {"inline_equation", "equation_inline"}
_IMAGE_SUFFIXES = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}


@dataclass(frozen=True)
class ProcessedJobResult:
    result: JobResult
    crops: Mapping[str, Path]


class MineruResultProcessor:
    """把 MinerU 私有输出转成稳定契约，并在任务终态前准备好裁剪图。"""

    async def process(
        self,
        job: JobRecord,
        raw_output_dir: Path,
        report_stage: StageReporter,
    ) -> ProcessedJobResult:
        await report_stage(JobStage.NORMALIZING)
        worker = asyncio.create_task(
            asyncio.to_thread(
                normalize_mineru_output,
                job_id=job.job_id,
                page_count=job.page_count,
                input_path=job.input_path,
                raw_output_dir=raw_output_dir,
                job_directory=job.directory,
            ),
            name=f"paperlens-mineru-normalize-{job.job_id}",
        )
        try:
            processed = await asyncio.shield(worker)
        except asyncio.CancelledError:
            # 等待线程收口后再让上层清理，避免超时/取消后又写回半成品。
            await worker
            raise
        await report_stage(JobStage.CROPS_READY)
        return processed


def normalize_mineru_output(
    *,
    job_id: str,
    page_count: int,
    input_path: Path,
    raw_output_dir: Path,
    job_directory: Path,
) -> ProcessedJobResult:
    content_path = _find_single_output(raw_output_dir, "*_content_list.json", exclude_suffix="_content_list_v2.json")
    middle_path = _find_single_output(raw_output_dir, "*_middle.json")
    content = _read_json(content_path)
    middle = _read_json(middle_path)
    if not isinstance(content, list):
        raise _invalid_result("content_list 顶层不是数组")
    _validate_middle_pages(middle, page_count)

    formulas: list[FormulaResult] = []
    crops: dict[str, Path] = {}
    warnings: list[WarningInfo] = []
    crop_root = job_directory / "crops"
    heading_stack: dict[int, str] = {}
    text_positions = _collect_text_positions(content)
    page_ordinals: dict[int, int] = {}

    for index, item in enumerate(content):
        if not isinstance(item, dict):
            raise _invalid_result(f"content_list[{index}] 不是对象")
        _update_heading_stack(heading_stack, item)
        item_type = item.get("type")
        if item_type not in _DISPLAY_TYPES:
            continue

        page = _page_number(item.get("page_idx"), page_count)
        bbox = _normalize_bbox(item.get("bbox"))
        latex = _normalize_latex(item.get("text"))
        ordinal = page_ordinals.get(page, 0) + 1
        page_ordinals[page] = ordinal
        formula_id = f"formula_p{page:03d}_{ordinal:03d}"
        crop_id = f"crop_p{page:03d}_{ordinal:03d}"
        crop_path = _materialize_crop(
            item=item,
            crop_id=crop_id,
            bbox=bbox,
            page=page,
            raw_output_dir=raw_output_dir,
            input_path=input_path,
            crop_root=crop_root,
        )
        crops[crop_id] = crop_path

        section_path = _section_path(heading_stack)
        context = _formula_context(text_positions, index)
        formulas.append(
            FormulaResult(
                id=formula_id,
                latex=latex,
                page=page,
                bbox=bbox,
                crop_id=crop_id,
                section_path=section_path,
                context=context,
            )
        )

    inline_count = _count_inline_formulas(middle)
    result = JobResult(
        schema_version=CONTRACT_SCHEMA_VERSION,
        job_id=job_id,
        engine=EngineInfo(name="mineru", version="3.4.4", backend="pipeline"),
        document=DocumentInfo(
            page_count=page_count,
            display_formula_count=len(formulas),
            inline_formula_count=inline_count,
        ),
        formulas=tuple(formulas),
        warnings=tuple(warnings),
    )
    # 生成端也走严格解析器，防止内部字段绕开冻结契约。
    result = parse_job_result(result.to_dict())
    return ProcessedJobResult(result=result, crops=crops)


def _find_single_output(root: Path, pattern: str, *, exclude_suffix: str | None = None) -> Path:
    root = root.resolve()
    matches = [
        path
        for path in root.rglob(pattern)
        if path.is_file() and (exclude_suffix is None or not path.name.endswith(exclude_suffix))
    ]
    if len(matches) != 1:
        raise _invalid_result(f"需要且只能有一个 {pattern}，实际 {len(matches)} 个")
    resolved = matches[0].resolve()
    if not resolved.is_relative_to(root):
        raise _invalid_result("MinerU 输出路径越界")
    return resolved


def _read_json(path: Path) -> object:
    try:
        if path.stat().st_size > _MAX_JSON_BYTES:
            raise _invalid_result("MinerU JSON 输出过大")
        return json.loads(path.read_text(encoding="utf-8"))
    except ContractError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise _invalid_result("MinerU JSON 输出无法读取", detail=str(error)) from error


def _collect_text_positions(content: Sequence[object]) -> list[tuple[int, str]]:
    result: list[tuple[int, str]] = []
    for index, item in enumerate(content):
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        text = _clean_text(item.get("text"))
        if text:
            result.append((index, text))
    return result


def _validate_middle_pages(middle: object, page_count: int) -> None:
    if not isinstance(middle, dict) or not isinstance(middle.get("pdf_info"), list):
        raise _invalid_result("middle 缺少 pdf_info 页数组")
    if len(middle["pdf_info"]) != page_count:
        raise _invalid_result("middle 页数与上传 PDF 不一致")


def _update_heading_stack(stack: dict[int, str], item: Mapping[str, object]) -> None:
    if item.get("type") != "text" or type(item.get("text_level")) is not int:
        return
    level = int(item["text_level"])
    if not 1 <= level <= 20:
        return
    text = _clean_text(item.get("text"))
    if not text:
        return
    for existing in tuple(stack):
        if existing >= level:
            stack.pop(existing)
    stack[level] = text[:250]


def _section_path(stack: Mapping[int, str]) -> str | None:
    if not stack:
        return None
    value = " > ".join(stack[level] for level in sorted(stack))
    return value[:500] or None


def _formula_context(text_positions: Sequence[tuple[int, str]], formula_index: int) -> str | None:
    before: str | None = None
    after: str | None = None
    for index, text in text_positions:
        if index < formula_index:
            before = text
        elif index > formula_index:
            after = text
            break
    parts = []
    if before:
        parts.append(before[-900:])
    if after:
        parts.append(after[:900])
    value = "\n".join(parts).strip()
    return value[:2000] or None


def _page_number(value: object, page_count: int) -> int:
    if type(value) is not int or not 0 <= value < page_count:
        raise _invalid_result("公式页码越界")
    return value + 1


def _normalize_bbox(value: object) -> tuple[int, int, int, int]:
    if not isinstance(value, list) or len(value) != 4:
        raise _invalid_result("公式 bbox 无效")
    if any(type(number) not in (int, float) or not math.isfinite(number) for number in value):
        raise _invalid_result("公式 bbox 含非有限数值")
    numbers = [float(number) for number in value]
    if all(0 <= number <= 1 for number in numbers):
        numbers = [number * 1000 for number in numbers]
    if any(number < 0 or number > 1000 for number in numbers):
        raise _invalid_result("公式 bbox 越界")
    bbox = tuple(round(number) for number in numbers)
    x0, y0, x1, y1 = bbox
    if x0 >= x1 or y0 >= y1:
        raise _invalid_result("公式 bbox 顺序无效")
    return bbox


def _normalize_latex(value: object) -> str:
    if not isinstance(value, str):
        raise _invalid_result("公式 LaTeX 缺失")
    latex = value.strip()
    if latex.startswith("$$") and latex.endswith("$$") and len(latex) >= 4:
        latex = latex[2:-2].strip()
    elif latex.startswith("\\[") and latex.endswith("\\]") and len(latex) >= 4:
        latex = latex[2:-2].strip()
    if not latex:
        raise _invalid_result("公式 LaTeX 为空")
    return latex


def _count_inline_formulas(value: object) -> int:
    count = 0
    if isinstance(value, list):
        for item in value:
            count += _count_inline_formulas(item)
    elif isinstance(value, dict):
        if value.get("type") in _INLINE_TYPES:
            count += 1
        for item in value.values():
            count += _count_inline_formulas(item)
    return count


def _materialize_crop(
    *,
    item: Mapping[str, object],
    crop_id: str,
    bbox: tuple[int, int, int, int],
    page: int,
    raw_output_dir: Path,
    input_path: Path,
    crop_root: Path,
) -> Path:
    source_value = item.get("img_path") or item.get("image_path")
    crop_root.mkdir(parents=True, exist_ok=True)
    if source_value is not None:
        source = _safe_image_source(raw_output_dir, source_value)
        image_format = _validate_image(source)
        destination = crop_root / f"{crop_id}{_IMAGE_SUFFIXES[image_format]}"
        shutil.copyfile(source, destination)
        return destination
    return _render_pdf_crop(input_path, crop_root / f"{crop_id}.jpg", page, bbox)


def _safe_image_source(raw_output_dir: Path, value: object) -> Path:
    if not isinstance(value, str) or not value or "\\" in value:
        raise _invalid_result("公式图片路径无效")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise _invalid_result("公式图片路径越界")
    root = raw_output_dir.resolve()
    matches = [path.resolve() for path in root.rglob(relative.as_posix()) if path.is_file()]
    if len(matches) != 1 or not matches[0].is_relative_to(root):
        raise _invalid_result("公式图片不存在或不唯一")
    return matches[0]


def _validate_image(path: Path) -> str:
    try:
        if path.stat().st_size <= 0 or path.stat().st_size > _MAX_IMAGE_BYTES:
            raise _invalid_result("公式图片大小无效")
        with Image.open(path) as image:
            image_format = image.format
            width, height = image.size
            if image_format not in _IMAGE_SUFFIXES or width <= 0 or height <= 0 or width * height > _MAX_IMAGE_PIXELS:
                raise _invalid_result("公式图片格式或尺寸无效")
            image.verify()
        return image_format
    except ContractError:
        raise
    except (OSError, UnidentifiedImageError) as error:
        raise _invalid_result("公式图片损坏", detail=str(error)) from error


def _render_pdf_crop(
    input_path: Path,
    destination: Path,
    page: int,
    bbox: tuple[int, int, int, int],
) -> Path:
    try:
        import pypdfium2 as pdfium

        document = pdfium.PdfDocument(str(input_path))
        try:
            rendered = document[page - 1].render(scale=2).to_pil()
            width, height = rendered.size
            x0, y0, x1, y1 = bbox
            crop = rendered.crop(
                (
                    max(0, int(width * x0 / 1000)),
                    max(0, int(height * y0 / 1000)),
                    min(width, int(math.ceil(width * x1 / 1000))),
                    min(height, int(math.ceil(height * y1 / 1000))),
                )
            )
            if crop.width <= 0 or crop.height <= 0:
                raise ValueError("empty crop")
            crop.convert("RGB").save(destination, format="JPEG", quality=92)
        finally:
            document.close()
        return destination
    except Exception as error:
        raise _invalid_result("无法生成公式裁剪图", detail=str(error)) from error


def _clean_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def _invalid_result(message: str, *, detail: str | None = None) -> ContractError:
    return ContractError(
        ErrorCode.RESULT_INVALID,
        "MinerU 返回了不完整或无效的结果。",
        http_status=502,
        internal_detail=detail or message,
    )
