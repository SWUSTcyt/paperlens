from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

from paperlens_mineru.cli import initialize_config
from paperlens_mineru.processes import process_group_options, terminate_process_tree
from smoke_client import run_smoke


def main() -> int:
    parser = argparse.ArgumentParser(description="启动本地服务并运行 A2 真实 PDF 冒烟")
    parser.add_argument("--root", required=True)
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--mineru-config", required=True)
    parser.add_argument("--pdf", action="append", default=[])
    parser.add_argument("--cancel-pdf")
    args = parser.parse_args()
    if not args.pdf and not args.cancel_pdf:
        parser.error("至少提供一个 --pdf 或 --cancel-pdf")

    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    config_path = root / "paperlens-mineru.toml"
    initialize_config(config_path, data_root=root)
    environment = _dedupe_windows_environment(dict(os.environ))
    environment.update(
        {
            "MODELSCOPE_CACHE": str(Path(args.model_cache).resolve()),
            "MINERU_TOOLS_CONFIG_JSON": str(Path(args.mineru_config).resolve()),
            "MINERU_MODEL_SOURCE": "modelscope",
        }
    )
    venv_site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    existing_python_path = environment.get("PYTHONPATH", "")
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(venv_site_packages), existing_python_path) if part
    )
    stdout = (root / "service.stdout.log").open("wb")
    stderr = (root / "service.stderr.log").open("wb")
    managed_python = getattr(sys, "_base_executable", sys.executable)
    service = subprocess.Popen(
        [managed_python, "-m", "paperlens_mineru.cli", "serve", "--config", str(config_path)],
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        cwd=Path.cwd(),
        env=environment,
        shell=False,
        **process_group_options(),
    )
    print(f"servicePid={service.pid}", flush=True)
    try:
        _wait_for_public_health(service)
        print("publicHealth=ready", flush=True)
        for pdf in args.pdf:
            result = run_smoke(config_path, pdf)
            if result["finalState"] != "completed":
                return 1
        if args.cancel_pdf:
            result = run_smoke(config_path, args.cancel_pdf, cancel_on_stage="parsing")
            if result["finalState"] != "cancelled":
                return 1
        return 0
    finally:
        if service.poll() is None:
            terminate_process_tree(service)
        try:
            service.wait(timeout=30)
        except subprocess.TimeoutExpired:
            terminate_process_tree(service)
        stdout.close()
        stderr.close()
        print(f"serviceExit={service.returncode}", flush=True)


def _wait_for_public_health(service: subprocess.Popen, timeout_seconds: float = 60) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if service.poll() is not None:
            raise RuntimeError(f"PaperLens MinerU service exited early: {service.returncode}")
        try:
            response = httpx.get("http://127.0.0.1:17860/v1/health", timeout=2)
            if response.status_code == 200 and response.json().get("status") == "ready":
                return
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("PaperLens MinerU public health timeout")


def _dedupe_windows_environment(environment: dict[str, str]) -> dict[str, str]:
    if os.name != "nt":
        return environment
    deduped: dict[str, tuple[str, str]] = {}
    for key, value in environment.items():
        deduped[key.upper()] = (key, value)
    return {original: value for original, value in deduped.values()}


if __name__ == "__main__":
    raise SystemExit(main())
