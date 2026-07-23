from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
TASK_SCRIPT = SERVICE_ROOT / "scripts" / "manage-windows-task.ps1"
STARTUP_SCRIPT = SERVICE_ROOT / "scripts" / "startup-windows.ps1"
TOKEN = "windows_task_test_token_1234567890abcdef"


@unittest.skipUnless(os.name == "nt", "Windows 任务计划入口只在 Windows 验证")
class WindowsTaskTests(unittest.TestCase):
    def test_describe_freezes_limited_current_user_task_contract_without_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime, config = _write_runtime(Path(directory), running=False)

            result = _run_task_script("Describe", runtime, config)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["taskName"], "PaperLens MinerU")
            self.assertEqual(payload["trigger"], "Logon")
            self.assertEqual(payload["logonType"], "Interactive")
            self.assertEqual(payload["runLevel"], "Limited")
            self.assertEqual(payload["multipleInstances"], "IgnoreNew")
            self.assertEqual(payload["executionTimeLimitSeconds"], 0)
            self.assertTrue(payload["hidden"])
            self.assertTrue(payload["currentUserOnly"])
            combined = result.stdout + result.stderr
            self.assertNotIn(TOKEN, combined)
            self.assertNotIn(str(runtime), combined)
            self.assertNotIn(str(config), combined)

    def test_describe_rejects_unmarked_runtime_without_leaking_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, config = _write_runtime(root, running=False)
            (runtime / ".paperlens-mineru-runtime").unlink()

            result = _run_task_script("Describe", runtime, config)

            self.assertNotEqual(result.returncode, 0)
            combined = result.stdout + result.stderr
            self.assertIn("RUNTIME_UNTRUSTED", combined)
            self.assertNotIn(TOKEN, combined)
            self.assertNotIn(str(runtime), combined)
            self.assertNotIn(str(config), combined)

    def test_startup_skips_live_service_and_starts_stopped_service(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, config = _write_runtime(root, running=True)

            running = _run_startup(runtime, config)

            self.assertEqual(running.returncode, 0, running.stdout + running.stderr)
            self.assertFalse((runtime / "serve-called.txt").exists())
            self.assertIn("SERVICE_ALREADY_RUNNING", running.stdout)

            (runtime / "running.flag").unlink()
            stopped = _run_startup(runtime, config)

            self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
            self.assertTrue((runtime / "serve-called.txt").is_file())
            combined = stopped.stdout + stopped.stderr
            self.assertNotIn(TOKEN, combined)
            self.assertNotIn(str(runtime), combined)
            self.assertNotIn(str(config), combined)

    def test_startup_continues_existing_service_when_scheduled_update_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime, config = _write_runtime(Path(directory), running=False)
            (runtime / "maintenance" / "update-windows.ps1").write_text(
                "exit 2\r\n",
                encoding="utf-8-sig",
            )

            result = _run_startup(runtime, config)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((runtime / "serve-called.txt").is_file())
            self.assertIn("UPDATE_FAILED_CONTINUING", result.stderr)
            combined = result.stdout + result.stderr
            self.assertNotIn(TOKEN, combined)
            self.assertNotIn(str(runtime), combined)
            self.assertNotIn(str(config), combined)

    @unittest.skipUnless(
        os.environ.get("PAPERLENS_TEST_RUN_SCHEDULED_TASKS") == "1",
        "显式启用后才修改当前用户的任务计划程序",
    )
    def test_real_task_registration_is_idempotent_and_removal_is_complete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime, config = _write_runtime(Path(directory), running=False)
            try:
                first = _run_task_script("Register", runtime, config)
                self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                second = _run_task_script("Register", runtime, config)
                self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
                status = _run_task_script("Status", runtime, config)
                self.assertEqual(status.returncode, 0, status.stdout + status.stderr)
                self.assertTrue(json.loads(status.stdout)["configured"])
            finally:
                removed = _run_task_script("Unregister", runtime, config)
                self.assertEqual(removed.returncode, 0, removed.stdout + removed.stderr)
                removed_again = _run_task_script("Unregister", runtime, config)
                self.assertEqual(removed_again.returncode, 0, removed_again.stdout + removed_again.stderr)


def _run_task_script(
    action: str,
    runtime: Path,
    config: Path,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(TASK_SCRIPT),
            "-Action",
            action,
            "-InstallRoot",
            str(runtime),
            "-ConfigPath",
            str(config),
        ],
        cwd=SERVICE_ROOT.parents[1],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )


def _run_startup(runtime: Path, config: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(STARTUP_SCRIPT),
            "-InstallRoot",
            str(runtime),
            "-ConfigPath",
            str(config),
        ],
        cwd=SERVICE_ROOT.parents[1],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )


def _write_runtime(root: Path, *, running: bool) -> tuple[Path, Path]:
    runtime = root / "runtime"
    maintenance = runtime / "maintenance"
    maintenance.mkdir(parents=True)
    (runtime / ".paperlens-mineru-runtime").write_text(
        "paperlens-mineru-runtime-v1",
        encoding="utf-8",
    )
    (maintenance / "startup-windows.ps1").write_text("# test placeholder\n", encoding="utf-8")
    config = root / "data" / "paperlens-mineru.toml"
    config.parent.mkdir(parents=True)
    config.write_text(f'[auth]\ntoken = "{TOKEN}"\n', encoding="utf-8")
    launcher = runtime / "paperlens-mineru.cmd"
    launcher.write_text(
        "\n".join(
            [
                "@echo off",
                'if "%1"=="status" (',
                f'  if exist "{runtime / "running.flag"}" (',
                '    echo {"schemaVersion":1,"running":true}',
                "  ) else (",
                '    echo {"schemaVersion":1,"running":false}',
                "  )",
                "  exit /b 0",
                ")",
                'if "%1"=="serve" (',
                f'  echo called>"{runtime / "serve-called.txt"}"',
                "  exit /b 0",
                ")",
                "exit /b 2",
            ]
        ),
        encoding="ascii",
    )
    if running:
        (runtime / "running.flag").write_text("running", encoding="utf-8")
    return runtime, config


if __name__ == "__main__":
    unittest.main()
