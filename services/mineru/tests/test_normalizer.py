from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from paperlens_mineru.contracts import ErrorCode
from paperlens_mineru.errors import ContractError
from paperlens_mineru.normalizer import normalize_mineru_output


class NormalizerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.job = self.root / "job_safe"
        self.raw = self.job / "raw" / "paper" / "auto"
        self.images = self.raw / "images"
        self.images.mkdir(parents=True)
        self.input_path = self.job / "input.pdf"
        self.input_path.write_bytes(b"%PDF-1.4\n%%EOF")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_image(self, name: str, color: str = "white") -> None:
        Image.new("RGB", (120, 40), color).save(self.images / name, format="JPEG")

    def write_outputs(self, content: object, middle: object) -> None:
        (self.raw / "paper_content_list.json").write_text(json.dumps(content), encoding="utf-8")
        (self.raw / "paper_middle.json").write_text(json.dumps(middle), encoding="utf-8")

    def normalize(self, *, page_count: int = 2):
        return normalize_mineru_output(
            job_id="job_safe",
            page_count=page_count,
            input_path=self.input_path,
            raw_output_dir=self.job / "raw",
            job_directory=self.job,
        )

    def test_normalizes_display_formulas_context_headings_inline_count_and_crops(self) -> None:
        self.write_image("first.jpg")
        self.write_image("second.jpg", "gray")
        self.write_outputs(
            [
                {"type": "text", "text": "3 Methods", "text_level": 1, "page_idx": 0},
                {"type": "text", "text": "Before the equation.", "page_idx": 0},
                {
                    "type": "equation",
                    "text": "$$\nE = mc^2\\tag{1}\n$$",
                    "bbox": [100, 200, 800, 300],
                    "page_idx": 0,
                    "img_path": "images/first.jpg",
                },
                {"type": "text", "text": "After the equation.", "page_idx": 0},
                {"type": "text", "text": "3.1 Detail", "text_level": 2, "page_idx": 1},
                {
                    "type": "interline_equation",
                    "text": "\\[x+y=z\\]",
                    "bbox": [0.2, 0.3, 0.7, 0.4],
                    "page_idx": 1,
                    "img_path": "images/second.jpg",
                },
            ],
            {
                "pdf_info": [
                    {"para_blocks": [{"type": "inline_equation"}, {"type": "text"}]},
                    {"para_blocks": [{"nested": {"type": "equation_inline"}}]},
                ]
            },
        )

        processed = self.normalize()
        result = processed.result
        self.assertEqual(result.document.display_formula_count, 2)
        self.assertEqual(result.document.inline_formula_count, 2)
        self.assertEqual([formula.id for formula in result.formulas], ["formula_p001_001", "formula_p002_001"])
        self.assertEqual(result.formulas[0].latex, "E = mc^2\\tag{1}")
        self.assertEqual(result.formulas[1].bbox, (200, 300, 700, 400))
        self.assertEqual(result.formulas[1].section_path, "3 Methods > 3.1 Detail")
        self.assertIn("Before the equation.", result.formulas[0].context or "")
        self.assertIn("After the equation.", result.formulas[0].context or "")
        self.assertEqual(set(processed.crops), {"crop_p001_001", "crop_p002_001"})
        self.assertTrue(all(path.is_file() and path.is_relative_to(self.job) for path in processed.crops.values()))

    def test_zero_display_formulas_is_valid_and_inline_is_only_counted(self) -> None:
        self.write_outputs(
            [{"type": "text", "text": "No display math", "page_idx": 0}],
            {"pdf_info": [{"children": [{"type": "inline_equation"}]}]},
        )
        processed = self.normalize(page_count=1)
        self.assertEqual(processed.result.document.display_formula_count, 0)
        self.assertEqual(processed.result.document.inline_formula_count, 1)
        self.assertEqual(processed.result.formulas, ())
        self.assertEqual(processed.crops, {})

    def test_partial_or_ambiguous_outputs_fail_instead_of_completing(self) -> None:
        (self.raw / "paper_content_list.json").write_text("[]", encoding="utf-8")
        with self.assertRaises(ContractError) as raised:
            self.normalize(page_count=1)
        self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)

    def test_rejects_missing_pages_and_out_of_range_bbox(self) -> None:
        self.write_image("formula.jpg")
        self.write_outputs([], {"pdf_info": [{}]})
        with self.assertRaises(ContractError) as raised:
            self.normalize(page_count=2)
        self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)

        self.write_outputs(
            [
                {
                    "type": "equation",
                    "text": "$$x$$",
                    "bbox": [-1, 100, 200, 300],
                    "page_idx": 0,
                    "img_path": "images/formula.jpg",
                }
            ],
            {"pdf_info": [{}]},
        )
        with self.assertRaises(ContractError) as raised:
            self.normalize(page_count=1)
        self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)

        (self.raw / "paper_middle.json").write_text("{}", encoding="utf-8")
        (self.raw / "other_content_list.json").write_text("[]", encoding="utf-8")
        with self.assertRaises(ContractError) as raised:
            self.normalize(page_count=1)
        self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)

    def test_rejects_crop_path_traversal(self) -> None:
        self.write_outputs(
            [
                {
                    "type": "equation",
                    "text": "$$x$$",
                    "bbox": [100, 100, 200, 200],
                    "page_idx": 0,
                    "img_path": "../secret.jpg",
                }
            ],
            {"pdf_info": [{}]},
        )
        with self.assertRaises(ContractError) as raised:
            self.normalize(page_count=1)
        self.assertEqual(raised.exception.code, ErrorCode.RESULT_INVALID)
        self.assertNotIn(str(self.root), raised.exception.safe_message)


if __name__ == "__main__":
    unittest.main()
