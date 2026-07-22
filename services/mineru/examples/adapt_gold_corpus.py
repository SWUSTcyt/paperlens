from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from paperlens_mineru.normalizer import normalize_mineru_output


def main() -> int:
    parser = argparse.ArgumentParser(description="用薄服务规范化器重放 MinerU POC 金标语料")
    parser.add_argument("--run", type=Path, required=True, help="包含 run-manifest.json 和 output/ 的 POC 运行目录")
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--normalized-root", type=Path)
    parser.add_argument("--reference-predictions", type=Path)
    args = parser.parse_args()

    run_root = args.run.resolve()
    corpus = _read_json(args.corpus.resolve())
    manifest = _read_json(run_root / "run-manifest.json")
    normalized_root = (args.normalized_root or run_root / "thin-normalized").resolve()
    output_root = (run_root / manifest.get("outputRoot", "output")).resolve()
    run_by_id = {item["id"]: item for item in manifest["papers"]}
    papers: list[dict[str, object]] = []
    formulas: list[dict[str, object]] = []

    for paper in corpus["papers"]:
        paper_id = paper["id"]
        paper_run = run_by_id.get(paper_id, {})
        try:
            job_directory = normalized_root / paper_id
            raw_root = output_root / paper_id
            processed = normalize_mineru_output(
                job_id=f"job_{paper_id.replace('.', '_')}",
                page_count=paper["pages"],
                input_path=run_root.parent.parent / "pdfs" / f"{paper_id}.pdf",
                raw_output_dir=raw_root,
                job_directory=job_directory,
            )
            papers.append(
                {
                    "id": paper_id,
                    "status": "completed",
                    "durationMs": paper_run.get("durationMs", 0),
                    "inlineFormulaCount": processed.result.document.inline_formula_count,
                    "warningCount": len(processed.result.warnings),
                }
            )
            for index, formula in enumerate(processed.result.formulas, start=1):
                crop_path = processed.crops[formula.crop_id] if formula.crop_id else None
                formulas.append(
                    {
                        "id": f"mineru-{paper_id}-p{formula.page:02d}-e{index}",
                        "paperId": paper_id,
                        "page": formula.page,
                        "bbox": list(formula.bbox),
                        "latex": formula.latex,
                        "display": True,
                        "cropPath": crop_path.resolve().as_posix() if crop_path else None,
                        "sourceBackend": "pipeline",
                    }
                )
        except Exception as error:
            papers.append(
                {
                    "id": paper_id,
                    "status": "failed",
                    "durationMs": paper_run.get("durationMs", 0),
                    "error": str(error),
                }
            )

    predictions = {
        "schemaVersion": 1,
        "engine": "mineru-3.4.4/pipeline-thin-normalizer",
        "evaluationMode": {
            "texSourceShortcut": False,
            "inlineFormulaPolicy": "count-only",
            "formulaListScope": "display-and-numbered",
        },
        "environment": manifest.get("environment", {}),
        "papers": papers,
        "formulas": formulas,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(predictions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    completed = sum(paper["status"] == "completed" for paper in papers)
    print(f"薄服务规范化完成：{completed}/{len(papers)} 篇，{len(formulas)} 条展示公式。")
    if args.reference_predictions:
        _compare_predictions(predictions, _read_json(args.reference_predictions.resolve()))
        print("与冻结 POC B 的公式字段、行内计数及裁剪图字节完全一致。")
    return 0 if completed == len(papers) else 1


def _compare_predictions(actual: dict[str, object], reference: dict[str, object]) -> None:
    actual_papers = [
        (item["id"], item["status"], item.get("inlineFormulaCount"), item.get("warningCount"))
        for item in actual["papers"]
    ]
    reference_papers = [
        (item["id"], item["status"], item.get("inlineFormulaCount"), item.get("warningCount"))
        for item in reference["papers"]
    ]
    if actual_papers != reference_papers:
        raise RuntimeError("文档状态或行内公式计数与冻结 POC B 不一致")
    if len(actual["formulas"]) != len(reference["formulas"]):
        raise RuntimeError("展示公式数量与冻结 POC B 不一致")
    keys = ("id", "paperId", "page", "bbox", "latex", "display", "sourceBackend")
    for index, (left, right) in enumerate(zip(actual["formulas"], reference["formulas"], strict=True)):
        if any(left.get(key) != right.get(key) for key in keys):
            raise RuntimeError(f"第 {index + 1} 条公式与冻结 POC B 不一致")
        if _sha256(Path(left["cropPath"])) != _sha256(Path(right["cropPath"])):
            raise RuntimeError(f"第 {index + 1} 条裁剪图与冻结 POC B 不一致")


def _read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
