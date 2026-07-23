from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from services.mineru.tests.test_windows_install import (
    SERVICE_ROOT,
    _installed_version,
    _run_installer,
    _write_fake_package,
)


UPDATE_SCRIPT_NAME = "update-windows.ps1"
PACKAGE_SCRIPT = SERVICE_ROOT / "scripts" / "package-windows-release.ps1"


@unittest.skipUnless(os.name == "nt", "Windows 自动更新入口只在 Windows 验证")
class WindowsUpdateTests(unittest.TestCase):
    def test_release_packager_writes_versioned_zip_and_matching_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "release"
            result = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(PACKAGE_SCRIPT),
                    "-OutputDirectory",
                    str(output),
                ],
                cwd=SERVICE_ROOT.parents[1],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            archive = output / "paperlens-mineru-windows-0.1.0.zip"
            checksum = output / "paperlens-mineru-windows-0.1.0.zip.sha256"
            self.assertTrue(archive.is_file())
            self.assertTrue(checksum.is_file())
            expected_line = f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}"
            self.assertEqual(checksum.read_text(encoding="ascii").strip(), expected_line)
            with zipfile.ZipFile(archive) as package:
                names = package.namelist()
            self.assertTrue(names)
            self.assertTrue(all(name.startswith("paperlens-mineru/") for name in names))
            self.assertIn("paperlens-mineru/scripts/update-windows.ps1", names)
            self.assertNotIn("paperlens-mineru/.env", names)
            self.assertFalse(any("__pycache__" in name for name in names))
            self.assertFalse(any(name.endswith((".pyc", ".pyo")) for name in names))

    def test_running_service_skips_before_checking_or_installing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, config, update_source = _installed_fixture(root)
            (config.parent / "running.flag").write_text("running", encoding="utf-8")
            (config.parent / "update-source.txt").write_text(str(update_source), encoding="utf-8")

            result = _run_update("UpdateNow", runtime, config)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("UPDATE_SKIPPED_SERVICE_RUNNING", result.stdout)
            self.assertEqual(_installed_version(runtime), "0.0.1")

    def test_stale_update_lock_is_recovered_and_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, config, update_source = _installed_fixture(root)
            (config.parent / "update-source.txt").write_text(str(update_source), encoding="utf-8")
            updates = config.parent / "updates"
            updates.mkdir()
            lock = updates / ".paperlens-mineru-update.lock"
            lock.write_text("owned-by-first-updater", encoding="utf-8")

            result = _run_update("CheckOnly", runtime, config)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("UPDATE_AVAILABLE", result.stdout)
            self.assertFalse(lock.exists())
            self.assertEqual(_installed_version(runtime), "0.0.1")

    def test_live_update_lock_is_not_removed_by_second_updater(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, config, update_source = _installed_fixture(root)
            (config.parent / "update-source.txt").write_text(str(update_source), encoding="utf-8")
            updates = config.parent / "updates"
            updates.mkdir()
            lock = updates / ".paperlens-mineru-update.lock"
            holder_script = root / "hold-lock.ps1"
            holder_script.write_text(
                "\n".join(
                    [
                        "param([string]$Path)",
                        "$stream = New-Object System.IO.FileStream(",
                        "  $Path,",
                        "  [System.IO.FileMode]::OpenOrCreate,",
                        "  [System.IO.FileAccess]::ReadWrite,",
                        "  [System.IO.FileShare]::None",
                        ")",
                        '[Console]::Out.WriteLine("ready")',
                        "[Console]::Out.Flush()",
                        "[Console]::In.ReadLine() | Out-Null",
                        "$stream.Dispose()",
                    ]
                ),
                encoding="utf-8-sig",
            )
            holder = subprocess.Popen(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(holder_script),
                    "-Path",
                    str(lock),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            try:
                self.assertEqual(holder.stdout.readline().strip(), "ready")
                result = _run_update("CheckOnly", runtime, config)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("UPDATE_SKIPPED_BUSY", result.stdout)
                self.assertTrue(lock.exists())
            finally:
                if holder.stdin:
                    holder.stdin.write("\n")
                    holder.stdin.flush()
                holder.wait(timeout=10)
                for stream in (holder.stdin, holder.stdout, holder.stderr):
                    if stream:
                        stream.close()

    def test_check_only_reports_update_without_installing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, config, update_source = _installed_fixture(root)
            (config.parent / "update-source.txt").write_text(str(update_source), encoding="utf-8")
            (config.parent / "running.flag").write_text("running", encoding="utf-8")

            result = _run_update("CheckOnly", runtime, config)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("UPDATE_AVAILABLE", result.stdout)
            self.assertEqual(_installed_version(runtime), "0.0.1")

    def test_update_now_switches_valid_candidate_and_failed_candidate_rolls_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, config, update_source = _installed_fixture(root)
            source_pointer = config.parent / "update-source.txt"
            source_pointer.write_text(str(update_source), encoding="utf-8")

            updated = _run_update("UpdateNow", runtime, config)

            self.assertEqual(updated.returncode, 0, updated.stdout + updated.stderr)
            self.assertIn("UPDATE_APPLIED", updated.stdout)
            self.assertEqual(_installed_version(runtime), "0.0.2")
            applied_state = json.loads(
                (config.parent / "updates" / "update-state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(applied_state["code"], "UPDATE_APPLIED")

            broken = root / "broken-update"
            _write_fake_package(broken, version="0.0.3", fail_doctor=True)
            source_pointer.write_text(str(broken), encoding="utf-8")
            generation_before = (runtime / "current.txt").read_text(encoding="utf-8")

            failed = _run_update("UpdateNow", runtime, config)

            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("UPDATE_INSTALL_FAILED", failed.stderr)
            self.assertEqual((runtime / "current.txt").read_text(encoding="utf-8"), generation_before)
            self.assertEqual(_installed_version(runtime), "0.0.2")
            failed_state = json.loads(
                (config.parent / "updates" / "update-state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(failed_state["code"], "UPDATE_INSTALL_FAILED")


def _installed_fixture(root: Path) -> tuple[Path, Path, Path]:
    source = root / "source"
    update_source = root / "update-source"
    runtime = root / "runtime"
    config = root / "data" / "paperlens-mineru.toml"
    _write_fake_package(source, version="0.0.1")
    _write_fake_package(update_source, version="0.0.2")
    installed = _run_installer(source, runtime, config)
    if installed.returncode != 0:
        raise AssertionError(installed.stdout + installed.stderr)
    return runtime, config, update_source


def _run_update(
    action: str,
    runtime: Path,
    config: Path,
) -> subprocess.CompletedProcess[str]:
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
            str(runtime / "maintenance" / UPDATE_SCRIPT_NAME),
            "-Action",
            action,
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


if __name__ == "__main__":
    unittest.main()
