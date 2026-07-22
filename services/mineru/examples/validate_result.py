from __future__ import annotations

import json
import sys
from pathlib import Path

from paperlens_mineru.contracts import parse_job_result


def main() -> int:
    if len(sys.argv) != 2:
        print("用法：python validate_result.py <job-result.json>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    result = parse_job_result(json.loads(path.read_text(encoding="utf-8")))
    print(
        f"job={result.job_id} pages={result.document.page_count} "
        f"display={result.document.display_formula_count} inline={result.document.inline_formula_count}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
