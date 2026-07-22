from __future__ import annotations

import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SCRIPT = SERVICE_ROOT / "scripts" / "install-windows.ps1"
TOKEN = "test_windows_installer_token_1234567890abcd"


@unittest.skipUnless(os.name == "nt", "Windows 安装入口只在 Windows 验证")
class WindowsInstallTests(unittest.TestCase):
    def test_first_install_reinstall_and_failed_reinstall_are_safe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            runtime = root / "runtime"
            config = root / "user-data" / "paperlens-mineru.toml"
            _write_fake_package(source)

            first = _run_installer(source, runtime, config)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertTrue((runtime / ".paperlens-mineru-runtime").is_file())
            self.assertTrue((runtime / "paperlens-mineru.cmd").is_file())
            launcher = (runtime / "paperlens-mineru.cmd").read_text(encoding="ascii")
            self.assertIn("PL_MINERU_GENERATION", launcher)
            self.assertNotIn("PAPERLENS_MINERU_GENERATION", launcher)
            self.assertIn(TOKEN, first.stdout)
            original_config = config.read_text(encoding="utf-8")
            first_generation = (runtime / "current.txt").read_text(encoding="utf-8").strip()

            stale_runtime_file = runtime / "versions" / first_generation / "stale.txt"
            stale_runtime_file.write_text("replace me", encoding="utf-8")
            second = _run_installer(source, runtime, config)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertFalse(stale_runtime_file.exists())
            self.assertEqual(config.read_text(encoding="utf-8"), original_config)
            self.assertNotIn(TOKEN, second.stdout)
            second_generation = (runtime / "current.txt").read_text(encoding="utf-8").strip()
            self.assertNotEqual(second_generation, first_generation)

            preserved = runtime / "versions" / second_generation / "preserved-on-failure.txt"
            preserved.write_text("keep", encoding="utf-8")
            versions_before = sorted(path.name for path in (runtime / "versions").iterdir())
            broken_source = root / "broken-source"
            broken_source.mkdir()
            failed = _run_installer(broken_source, runtime, config)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(preserved.read_text(encoding="utf-8"), "keep")
            self.assertEqual(config.read_text(encoding="utf-8"), original_config)
            self.assertEqual((runtime / "current.txt").read_text(encoding="utf-8").strip(), second_generation)
            self.assertEqual(sorted(path.name for path in (runtime / "versions").iterdir()), versions_before)

    def test_refuses_to_replace_unmarked_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            runtime = root / "runtime"
            runtime.mkdir()
            user_file = runtime / "user-file.txt"
            user_file.write_text("must survive", encoding="utf-8")
            _write_fake_package(source)

            result = _run_installer(source, runtime, root / "config.toml")

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(user_file.read_text(encoding="utf-8"), "must survive")


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


def _write_fake_package(root: Path) -> None:
    package = root / "src" / "paperlens_fake"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "cli.py").write_text(
        textwrap.dedent(
            f'''\
            from __future__ import annotations

            import sys
            from pathlib import Path

            TOKEN = "{TOKEN}"

            def main() -> int:
                command = sys.argv[1]
                config = Path(sys.argv[sys.argv.index("--config") + 1])
                if command == "init":
                    if config.exists():
                        return 0
                    config.parent.mkdir(parents=True, exist_ok=True)
                    config.write_text(f'[auth]\\ntoken = "{{TOKEN}}"\\n', encoding="utf-8")
                    print(TOKEN)
                    return 0
                if command == "check-config":
                    return 0 if config.is_file() else 2
                if command == "doctor":
                    print("诊断通过。 token=<redacted>")
                    return 0
                return 2
            '''
        ),
        encoding="utf-8",
    )
    (root / "pyproject.toml").write_text(
        textwrap.dedent(
            '''\
            [build-system]
            requires = ["hatchling>=1.27,<2"]
            build-backend = "hatchling.build"

            [project]
            name = "paperlens-mineru"
            version = "0.0.0"
            requires-python = ">=3.12,<3.13"

            [project.scripts]
            paperlens-mineru = "paperlens_fake.cli:main"

            [tool.hatch.build.targets.wheel]
            packages = ["src/paperlens_fake"]
            '''
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    unittest.main()
