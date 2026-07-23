from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SCRIPT = SERVICE_ROOT / "scripts" / "install-windows.ps1"
UNINSTALL_SCRIPT = SERVICE_ROOT / "scripts" / "uninstall-windows.ps1"
TOKEN = "test_windows_installer_token_1234567890abcd"


@unittest.skipUnless(os.name == "nt", "Windows 安装入口只在 Windows 验证")
class WindowsInstallTests(unittest.TestCase):
    def test_first_install_reinstall_and_failed_reinstall_are_safe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            runtime = root / "runtime"
            config = root / "user-data" / "paperlens-mineru.toml"
            _write_fake_package(source, version="0.0.0")

            first = _run_installer(source, runtime, config)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertTrue((runtime / ".paperlens-mineru-runtime").is_file())
            self.assertTrue((runtime / "paperlens-mineru.cmd").is_file())
            self.assertTrue((runtime / "maintenance" / "manage-windows-task.ps1").is_file())
            self.assertTrue((runtime / "maintenance" / "startup-windows.ps1").is_file())
            self.assertTrue((runtime / "maintenance" / "update-windows.ps1").is_file())
            self.assertTrue((runtime / "maintenance" / "install-windows.ps1").is_file())
            self.assertTrue((runtime / "maintenance" / "uninstall-windows.ps1").is_file())
            launcher = (runtime / "paperlens-mineru.cmd").read_text(encoding="ascii")
            self.assertIn("PL_MINERU_GENERATION", launcher)
            self.assertNotIn("PAPERLENS_MINERU_GENERATION", launcher)
            self.assertIn(TOKEN, first.stdout)
            original_config = config.read_text(encoding="utf-8")
            first_generation = (runtime / "current.txt").read_text(encoding="utf-8").strip()

            stale_runtime_file = runtime / "versions" / first_generation / "stale.txt"
            stale_runtime_file.write_text("replace me", encoding="utf-8")
            _write_fake_package(source, version="0.0.1")
            second = _run_installer(source, runtime, config)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertFalse(stale_runtime_file.exists())
            self.assertEqual(config.read_text(encoding="utf-8"), original_config)
            self.assertNotIn(TOKEN, second.stdout)
            second_generation = (runtime / "current.txt").read_text(encoding="utf-8").strip()
            self.assertNotEqual(second_generation, first_generation)
            self.assertEqual(_installed_version(runtime), "0.0.1")

            repair = _run_installer(source, runtime, config)
            self.assertEqual(repair.returncode, 0, repair.stdout + repair.stderr)
            repair_generation = (runtime / "current.txt").read_text(encoding="utf-8").strip()
            self.assertNotEqual(repair_generation, second_generation)
            self.assertEqual(_installed_version(runtime), "0.0.1")

            preserved = runtime / "versions" / repair_generation / "preserved-on-failure.txt"
            preserved.write_text("keep", encoding="utf-8")
            versions_before = sorted(path.name for path in (runtime / "versions").iterdir())
            broken_source = root / "broken-source"
            broken_source.mkdir()
            failed = _run_installer(broken_source, runtime, config)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(preserved.read_text(encoding="utf-8"), "keep")
            self.assertEqual(config.read_text(encoding="utf-8"), original_config)
            self.assertEqual((runtime / "current.txt").read_text(encoding="utf-8").strip(), repair_generation)
            self.assertEqual(sorted(path.name for path in (runtime / "versions").iterdir()), versions_before)

    def test_refuses_to_replace_unmarked_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            runtime = root / "runtime"
            runtime.mkdir()
            user_file = runtime / "user-file.txt"
            user_file.write_text("must survive", encoding="utf-8")
            _write_fake_package(source, version="0.0.0")

            result = _run_installer(source, runtime, root / "config.toml")

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(user_file.read_text(encoding="utf-8"), "must survive")

    def test_default_uninstall_preserves_data_and_reinstall_then_purge_requires_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            runtime = root / "runtime"
            data = root / "user-data"
            config = data / "paperlens-mineru.toml"
            _write_fake_package(source, version="0.0.1")
            installed = _run_installer(source, runtime, config)
            self.assertEqual(installed.returncode, 0, installed.stdout + installed.stderr)
            original_config = config.read_text(encoding="utf-8")
            (data / "tasks").mkdir()
            (data / "tasks" / "saved.json").write_text("task", encoding="utf-8")
            (data / "models").mkdir()
            (data / "models" / "weights.bin").write_bytes(b"model")

            preserved = _run_uninstaller(runtime, config)
            self.assertEqual(preserved.returncode, 0, preserved.stdout + preserved.stderr)
            self.assertFalse(runtime.exists())
            self.assertEqual(config.read_text(encoding="utf-8"), original_config)
            self.assertTrue((data / "tasks" / "saved.json").is_file())
            self.assertTrue((data / "models" / "weights.bin").is_file())

            reinstalled = _run_installer(source, runtime, config)
            self.assertEqual(reinstalled.returncode, 0, reinstalled.stdout + reinstalled.stderr)
            self.assertEqual(config.read_text(encoding="utf-8"), original_config)

            refused = _run_uninstaller(runtime, config, purge=True, confirmation="DELETE")
            self.assertNotEqual(refused.returncode, 0)
            self.assertTrue(runtime.is_dir())
            self.assertTrue(config.is_file())
            self.assertTrue((data / "models" / "weights.bin").is_file())

            purged = _run_uninstaller(
                runtime,
                config,
                purge=True,
                confirmation="DELETE PAPERLENS MINERU DATA",
            )
            self.assertEqual(purged.returncode, 0, purged.stdout + purged.stderr)
            self.assertFalse(runtime.exists())
            self.assertFalse(data.exists())

    def test_uninstall_refuses_when_data_root_is_inside_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            runtime = root / "runtime"
            data = root / "user-data"
            config = data / "paperlens-mineru.toml"
            _write_fake_package(source, version="0.0.1")
            installed = _run_installer(source, runtime, config)
            self.assertEqual(installed.returncode, 0, installed.stdout + installed.stderr)
            (data / "data-root-override.txt").write_text(str(runtime), encoding="utf-8")
            protected = runtime / "must-survive.txt"
            protected.write_text("user data", encoding="utf-8")

            refused = _run_uninstaller(runtime, config)

            self.assertNotEqual(refused.returncode, 0)
            self.assertEqual(protected.read_text(encoding="utf-8"), "user data")


def _run_installer(source: Path, runtime: Path, config: Path) -> subprocess.CompletedProcess[str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("PAPERLENS_MINERU_")
    }
    environment["UV_CACHE_DIR"] = str(
        SERVICE_ROOT.parents[1] / "local-artifacts" / "pdf-ocr-poc" / "mineru-3.4.4" / "uv-cache"
    )
    environment["UV_PYTHON_INSTALL_DIR"] = str(
        SERVICE_ROOT.parents[1] / "local-artifacts" / "pdf-ocr-poc" / "mineru-3.4.4" / "python"
    )
    return subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(INSTALL_SCRIPT),
            "-SourceRoot",
            str(source),
            "-InstallRoot",
            str(runtime),
            "-ConfigPath",
            str(config),
            "-SkipStartupTask",
        ],
        cwd=SERVICE_ROOT.parents[1],
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        check=False,
    )


def _run_uninstaller(
    runtime: Path,
    config: Path,
    *,
    purge: bool = False,
    confirmation: str = "",
) -> subprocess.CompletedProcess[str]:
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(UNINSTALL_SCRIPT),
        "-InstallRoot",
        str(runtime),
        "-ConfigPath",
        str(config),
    ]
    if purge:
        command.extend(["-PurgeData", "-ConfirmPurge", confirmation])
    return subprocess.run(
        command,
        cwd=SERVICE_ROOT.parents[1],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )


def _installed_version(runtime: Path) -> str:
    generation = (runtime / "current.txt").read_text(encoding="utf-8").strip()
    result = subprocess.run(
        [
            str(runtime / "versions" / generation / "Scripts" / "python.exe"),
            "-c",
            "import importlib.metadata; print(importlib.metadata.version('paperlens-mineru'))",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return result.stdout.strip()


def _write_fake_package(root: Path, *, version: str, fail_doctor: bool = False) -> None:
    package = root / "src" / "paperlens_fake"
    package.mkdir(parents=True, exist_ok=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "cli.py").write_text(
        textwrap.dedent(
            f'''\
            from __future__ import annotations

            import json
            import shutil
            import sys
            import tomllib
            from pathlib import Path

            TOKEN = "{TOKEN}"
            VERSION = "{version}"
            FAIL_DOCTOR = {fail_doctor!r}

            def main() -> int:
                command = sys.argv[1]
                if command == "version":
                    print(json.dumps({{"schemaVersion": 1, "serviceVersion": VERSION}}))
                    return 0
                config = Path(sys.argv[sys.argv.index("--config") + 1])
                if command == "init":
                    if config.exists():
                        return 0
                    config.parent.mkdir(parents=True, exist_ok=True)
                    config.write_text(f'[auth]\\ntoken = "{{TOKEN}}"\\n', encoding="utf-8")
                    (config.parent / ".paperlens-mineru-data").write_text(
                        "paperlens-mineru-data-v1", encoding="utf-8"
                    )
                    print(TOKEN)
                    return 0
                if command == "check-config":
                    return 0 if config.is_file() else 2
                if command == "doctor":
                    print("诊断通过。 token=<redacted>")
                    return 2 if FAIL_DOCTOR else 0
                if command == "status":
                    print(json.dumps({{
                        "schemaVersion": 1,
                        "running": (config.parent / "running.flag").exists(),
                    }}))
                    return 0
                if command == "stop":
                    print("PaperLens MinerU 服务未运行。")
                    return 0
                if command == "lifecycle-info":
                    override = config.parent / "data-root-override.txt"
                    data_root = Path(override.read_text(encoding="utf-8")) if override.exists() else config.parent
                    print(json.dumps({{
                        "schemaVersion": 1,
                        "configPath": str(config.resolve()),
                        "dataRoot": str(data_root.resolve()),
                        "dataMarkerValid": True,
                        "port": 17860,
                    }}))
                    return 0
                if command in ("update-check", "update-prepare"):
                    source_file = config.parent / "update-source.txt"
                    if not source_file.is_file():
                        print(json.dumps({{
                            "schemaVersion": 1,
                            "code": "UPDATE_CURRENT",
                            "currentVersion": VERSION,
                            "latestVersion": VERSION,
                        }}))
                        return 0
                    source = Path(source_file.read_text(encoding="utf-8"))
                    metadata = tomllib.loads((source / "pyproject.toml").read_text(encoding="utf-8"))
                    latest = metadata["project"]["version"]
                    code = "UPDATE_AVAILABLE"
                    if command == "update-prepare":
                        destination = Path(sys.argv[sys.argv.index("--destination") + 1])
                        shutil.copytree(source, destination / "paperlens-mineru")
                        code = "UPDATE_PREPARED"
                    print(json.dumps({{
                        "schemaVersion": 1,
                        "code": code,
                        "currentVersion": VERSION,
                        "latestVersion": latest,
                    }}))
                    return 0
                return 2
            '''
        ),
        encoding="utf-8",
    )
    (root / "pyproject.toml").write_text(
        textwrap.dedent(
            f'''\
            [build-system]
            requires = ["hatchling>=1.27,<2"]
            build-backend = "hatchling.build"

            [project]
            name = "paperlens-mineru"
            version = "{version}"
            requires-python = ">=3.12,<3.13"

            [project.scripts]
            paperlens-mineru = "paperlens_fake.cli:main"

            [tool.hatch.build.targets.wheel]
            packages = ["src/paperlens_fake"]
            '''
        ),
        encoding="utf-8",
    )
    scripts = root / "scripts"
    scripts.mkdir(exist_ok=True)
    for name in (
        "install-windows.ps1",
        "uninstall-windows.ps1",
        "manage-windows-task.ps1",
        "startup-windows.ps1",
        "update-windows.ps1",
    ):
        shutil.copyfile(SERVICE_ROOT / "scripts" / name, scripts / name)


if __name__ == "__main__":
    unittest.main()
