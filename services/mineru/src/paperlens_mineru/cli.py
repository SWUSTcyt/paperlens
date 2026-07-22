from __future__ import annotations

import argparse
import os
import sys
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from .api import create_app
from .config import ConfigError, ServiceConfig, generate_access_token, load_config
from .diagnostics import collect_diagnostics, format_diagnostics
from .normalizer import MineruResultProcessor
from .upstream import MineruApiSupervisor, MineruUpstreamRunner


@dataclass(frozen=True)
class BootstrapResult:
    path: Path
    created: bool
    token: str | None


def default_config_path(environ: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environ is None else environ
    root = Path(env.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    return root / "PaperLens" / "MinerU" / "paperlens-mineru.toml"


def initialize_config(path: Path, *, data_root: Path | None = None) -> BootstrapResult:
    """首次创建本机配置并返回只展示一次的 token；已有文件绝不覆盖。"""

    path = path.expanduser().resolve()
    if path.exists():
        return BootstrapResult(path=path, created=False, token=None)
    root = (data_root or path.parent).expanduser().resolve()
    token = generate_access_token()
    content = "\n".join(
        [
            "[server]",
            'host = "127.0.0.1"',
            "port = 17860",
            "",
            "[auth]",
            f'token = "{token}"',
            "",
            "[storage]",
            f'root = "{root.as_posix()}"',
            "",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="\n") as output:
            output.write(content)
        with suppress(OSError):
            path.chmod(0o600)
    except FileExistsError:
        return BootstrapResult(path=path, created=False, token=None)
    except OSError as error:
        raise ConfigError("CONFIG_FILE_INVALID", "无法创建本地服务配置文件。") from error
    return BootstrapResult(path=path, created=True, token=token)


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    command = args.command or "serve"
    config_path = Path(args.config).expanduser() if getattr(args, "config", None) else default_config_path()

    try:
        if command == "generate-token":
            print(generate_access_token())
            return 0
        if command == "init":
            result = initialize_config(config_path)
            _print_bootstrap(result)
            return 0
        if command == "check-config":
            config = load_config(config_path)
            print(f"配置有效：{config.host}:{config.port}，MinerU {config.mineru_version}/{config.backend}")
            return 0
        if command == "doctor":
            report = collect_diagnostics(config_path, check_health=args.health)
            print(format_diagnostics(report))
            return 0 if report.ok else 1
        if command == "serve":
            result = initialize_config(config_path)
            _print_bootstrap(result)
            config = load_config(config_path)
            return _serve(config)
    except ConfigError as error:
        print(f"{error.code}: {error}", file=sys.stderr)
        return 2

    parser.error(f"未知命令：{command}")
    return 2


def _serve(config: ServiceConfig) -> int:
    import uvicorn

    supervisor = MineruApiSupervisor(config)
    runner = MineruUpstreamRunner(supervisor)
    app = create_app(config, runner=runner, result_processor=MineruResultProcessor())
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        access_log=False,
        log_level="info",
    )
    return 0


def _print_bootstrap(result: BootstrapResult) -> None:
    if not result.created:
        return
    print(f"已创建配置：{result.path}")
    print("首次访问 token（只显示这一次，请复制到 PaperLens 设置）：")
    print(result.token)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="paperlens-mineru", description="PaperLens 本地 MinerU pipeline 服务")
    parser.add_argument("--config", help="TOML 配置路径；默认位于 LOCALAPPDATA/PaperLens/MinerU")
    subparsers = parser.add_subparsers(dest="command")
    for name in ("serve", "init", "check-config"):
        subparser = subparsers.add_parser(name)
        subparser.add_argument("--config", help="TOML 配置路径")
    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--config", help="TOML 配置路径")
    doctor.add_argument("--health", action="store_true", help="同时验证已启动服务的 schema v1 health")
    subparsers.add_parser("generate-token")
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
