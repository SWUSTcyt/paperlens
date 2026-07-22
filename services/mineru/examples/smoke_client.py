from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx

from paperlens_mineru.config import load_config


def run_smoke(config_path: str | Path, pdf_path: str | Path, *, cancel_on_stage: str | None = None) -> dict:
    config = load_config(config_path)
    base_url = f"http://127.0.0.1:{config.port}"
    headers = {
        "Authorization": f"Bearer {config.access_token}",
        "X-PaperLens-Schema-Version": "1",
    }
    pdf_path = Path(pdf_path)
    with httpx.Client(base_url=base_url, timeout=httpx.Timeout(connect=3, read=60, write=60, pool=3)) as client:
        health = client.get("/v1/health")
        health.raise_for_status()
        started = time.monotonic()
        with pdf_path.open("rb") as source:
            created = client.post(
                "/v1/jobs",
                headers=headers,
                files={"file": (pdf_path.name, source, "application/pdf")},
            )
        created.raise_for_status()
        job_id = created.json()["jobId"]
        last_stage = None
        while True:
            status = client.get(f"/v1/jobs/{job_id}", headers=headers)
            status.raise_for_status()
            payload = status.json()
            if payload["stage"] != last_stage:
                print(json.dumps({"jobId": job_id, "state": payload["state"], "stage": payload["stage"], "elapsedMs": payload["elapsedMs"]}))
                last_stage = payload["stage"]
            if cancel_on_stage and payload["stage"] == cancel_on_stage:
                cancelled = client.post(f"/v1/jobs/{job_id}/cancel", headers=headers)
                cancelled.raise_for_status()
                cancel_on_stage = None
            if payload["state"] in {"completed", "cancelled", "failed", "timed-out"}:
                final = {
                    "jobId": job_id,
                    "finalState": payload["state"],
                    "durationMs": round((time.monotonic() - started) * 1000),
                }
                print(json.dumps(final))
                return final
            time.sleep(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="PaperLens MinerU A2 本地服务冒烟客户端")
    parser.add_argument("--config", required=True)
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--cancel-on-stage")
    args = parser.parse_args()

    result = run_smoke(args.config, args.pdf, cancel_on_stage=args.cancel_on_stage)
    return 0 if result["finalState"] in {"completed", "cancelled"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
