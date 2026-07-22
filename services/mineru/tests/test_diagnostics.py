from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from paperlens_mineru.cli import initialize_config, main
from paperlens_mineru.diagnostics import collect_diagnostics, format_diagnostics


class DiagnosticsTests(unittest.TestCase):
    def test_valid_installation_is_share_safe_and_reports_sizes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config" / "paperlens-mineru.toml"
            runtime_root = root / "runtime"
            runtime_root.mkdir()
            (runtime_root / "package.bin").write_bytes(b"runtime")
            bootstrap = initialize_config(config_path, data_root=root / "data")
            assert bootstrap.token is not None
            with (
                patch("paperlens_mineru.diagnostics.platform.system", return_value="Windows"),
                patch("paperlens_mineru.diagnostics.sys.version_info", (3, 12, 9)),
                patch("paperlens_mineru.diagnostics.metadata.version", return_value="3.4.4"),
            ):
                report = collect_diagnostics(config_path, runtime_root=runtime_root, environ={})

        rendered = format_diagnostics(report)
        self.assertTrue(report.ok)
        self.assertIn("runtimeBytes=7", rendered)
        self.assertIn("dataBytes=0", rendered)
        self.assertIn("token=<redacted>", rendered)
        self.assertNotIn(bootstrap.token, rendered)
        self.assertNotIn(str(root), rendered)

    def test_missing_config_has_stable_error_without_absolute_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "secret-user" / "missing.toml"
            with (
                patch("paperlens_mineru.diagnostics.platform.system", return_value="Windows"),
                patch("paperlens_mineru.diagnostics.sys.version_info", (3, 12, 9)),
                patch("paperlens_mineru.diagnostics.metadata.version", return_value="3.4.4"),
            ):
                report = collect_diagnostics(config_path, environ={})

        rendered = format_diagnostics(report)
        self.assertFalse(report.ok)
        self.assertIn("CONFIG_MISSING", rendered)
        self.assertNotIn(str(config_path), rendered)

    def test_health_failure_does_not_echo_exception_or_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "paperlens-mineru.toml"
            bootstrap = initialize_config(config_path, data_root=root / "data")
            assert bootstrap.token is not None
            secret_error = f"Bearer {bootstrap.token} at {root}"
            with (
                patch("paperlens_mineru.diagnostics.platform.system", return_value="Windows"),
                patch("paperlens_mineru.diagnostics.sys.version_info", (3, 12, 9)),
                patch("paperlens_mineru.diagnostics.metadata.version", return_value="3.4.4"),
                patch("paperlens_mineru.diagnostics._fetch_health", side_effect=RuntimeError(secret_error)),
            ):
                report = collect_diagnostics(config_path, check_health=True, environ={})

        rendered = format_diagnostics(report)
        self.assertFalse(report.ok)
        self.assertIn("HEALTH_UNAVAILABLE", rendered)
        self.assertNotIn(bootstrap.token, rendered)
        self.assertNotIn(str(root), rendered)

    def test_cli_doctor_exit_code_tracks_health_gate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "paperlens-mineru.toml"
            initialize_config(path, data_root=Path(directory) / "data")
            output = io.StringIO()
            with (
                patch("paperlens_mineru.diagnostics.platform.system", return_value="Windows"),
                patch("paperlens_mineru.diagnostics.sys.version_info", (3, 12, 9)),
                patch("paperlens_mineru.diagnostics.metadata.version", return_value="3.4.4"),
                patch(
                    "paperlens_mineru.diagnostics._fetch_health",
                    return_value={
                        "schemaVersion": 1,
                        "service": "paperlens-mineru",
                        "status": "ready",
                        "engine": {"name": "mineru", "version": "3.4.4", "backend": "pipeline"},
                    },
                ),
                redirect_stdout(output),
            ):
                exit_code = main(["doctor", "--config", str(path), "--health"])

        self.assertEqual(exit_code, 0)
        self.assertIn("诊断通过", output.getvalue())


if __name__ == "__main__":
    unittest.main()
