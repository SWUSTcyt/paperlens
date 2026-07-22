"""为 MinerU POC B 生成本地候选/金标对照图，不修改审核结论。"""

from __future__ import annotations

import argparse
import json
import math
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True, type=Path)
    parser.add_argument("--reviews", required=True, type=Path)
    parser.add_argument("--gold-crops", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    predictions = json.loads(args.predictions.read_text(encoding="utf-8"))
    reviews = json.loads(args.reviews.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    by_id = {item["id"]: item for item in predictions["formulas"]}
    gold_crops = index_gold_crops(args.gold_crops)

    by_paper: dict[str, list[dict]] = {}
    for formula in predictions["formulas"]:
        by_paper.setdefault(formula["paperId"], []).append(formula)
    for paper_id, formulas in by_paper.items():
        formulas.sort(key=lambda item: (item["page"], item["bbox"][1], item["bbox"][0]))
        for part, chunk in enumerate(chunks(formulas, 20), start=1):
            cards = [candidate_card(formula) for formula in chunk]
            save_grid(cards, args.output / f"candidates-{paper_id}-{part:02d}.jpg", columns=2)

    match_cards = []
    for assessment in reviews["assessments"]:
        prediction = by_id[assessment["predictionId"]]
        match_cards.append(match_card(
            assessment["goldId"],
            prediction,
            gold_crops.get(assessment["goldId"]),
        ))
    for part, chunk in enumerate(chunks(match_cards, 12), start=1):
        save_grid(chunk, args.output / f"gold-matches-{part:02d}.jpg", columns=1)
    print(f"review sheets: {args.output} ({len(predictions['formulas'])} candidates, {len(match_cards)} matches)")


def index_gold_crops(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            continue
        name = path.name
        if "-contact" in name:
            continue
        # 文件名格式为序号-<gold-id>.png。
        result[name.split("-", 1)[1].rsplit(".", 1)[0]] = path
    return result


def candidate_card(formula: dict) -> Image.Image:
    crop = open_rgb(Path(formula["cropPath"]))
    crop.thumbnail((560, 240), Image.Resampling.LANCZOS)
    lines = [
        f"{formula['id']}  page={formula['page']}",
        *textwrap.wrap(formula["latex"].replace("\n", " "), width=95)[:4],
    ]
    return labeled_images(lines, [crop])


def match_card(gold_id: str, prediction: dict, gold_crop_path: Path | None) -> Image.Image:
    gold_crop = open_rgb(gold_crop_path) if gold_crop_path else missing_image("gold crop missing")
    prediction_crop = open_rgb(Path(prediction["cropPath"]))
    gold_crop.thumbnail((560, 260), Image.Resampling.LANCZOS)
    prediction_crop.thumbnail((560, 260), Image.Resampling.LANCZOS)
    lines = [
        f"{gold_id}  <->  {prediction['id']}",
        *textwrap.wrap(prediction["latex"].replace("\n", " "), width=115)[:4],
    ]
    return labeled_images(lines, [gold_crop, prediction_crop])


def labeled_images(lines: list[str], images: list[Image.Image]) -> Image.Image:
    font = ImageFont.load_default()
    header_height = 18 * len(lines) + 12
    content_height = max(image.height for image in images)
    width = sum(image.width for image in images) + 12 * (len(images) + 1)
    canvas = Image.new("RGB", (max(width, 600), header_height + content_height + 12), "white")
    draw = ImageDraw.Draw(canvas)
    for index, line in enumerate(lines):
        draw.text((10, 8 + index * 18), line, fill="black", font=font)
    x = 12
    for image in images:
        canvas.paste(image, (x, header_height))
        x += image.width + 12
    return canvas


def save_grid(cards: list[Image.Image], path: Path, columns: int) -> None:
    gap = 12
    rows = math.ceil(len(cards) / columns)
    column_width = max(card.width for card in cards)
    row_heights = [
        max(card.height for card in cards[row * columns:(row + 1) * columns])
        for row in range(rows)
    ]
    canvas = Image.new("RGB", (
        columns * column_width + (columns + 1) * gap,
        sum(row_heights) + (rows + 1) * gap,
    ), "#dddddd")
    y = gap
    for row in range(rows):
        x = gap
        for card in cards[row * columns:(row + 1) * columns]:
            canvas.paste(card, (x, y))
            x += column_width + gap
        y += row_heights[row] + gap
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, quality=88, optimize=True)


def chunks(items: list, size: int):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def open_rgb(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGB")


def missing_image(label: str) -> Image.Image:
    image = Image.new("RGB", (320, 80), "#ffeeee")
    ImageDraw.Draw(image).text((10, 30), label, fill="#990000", font=ImageFont.load_default())
    return image


if __name__ == "__main__":
    main()
