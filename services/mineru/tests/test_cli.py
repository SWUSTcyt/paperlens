from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from paperlens_mineru.cli import default_config_path, initialize_config, main
from paperlens_mineru.config import load_config
from paperlens_mineru.lifecycle import DATA_MARKER_NAME
from paperlens_mineru.updates import UpdateError, UpdateResult


class CliTests(unittest.TestCase):
    def test_default_path_stays_under_local_app_data(self) -> None:
        path = default_config_path({"LOCALAPPDATA": r"C:\Users\Test\AppData\Local"})
        self.assertEqual(path, Path(r"C:\Users\Test\AppData\Local") / "PaperLens" / "MinerU" / "paperlens-mineru.toml")

    def test_init_creates_valid_config_and_never_overwrites_or_reprints_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "config" / "paperlens-mineru.toml"
            first = initialize_config(path, data_root=root / "data")
            first_content = path.read_text(encoding="utf-8")
            second = initialize_config(path, data_root=root / "other")
            config = load_config(path, environ={})
            marker_created = (root / "data" / DATA_MARKER_NAME).is_file()

        self.assertTrue(first.created)
        self.assertIsNotNone(first.token)
        self.assertFalse(second.created)
        self.assertIsNone(second.token)
        self.assertEqual(path.read_text(encoding="utf-8") if path.exists() else first_content, first_content)
        self.assertEqual(config.access_token, first.token)
        self.assertEqual(config.data_root, root / "data")
        self.assertTrue(marker_created)

    def test_cli_init_prints_token_once_and_check_config_is_redacted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "paperlens-mineru.toml"
            first_output = io.StringIO()
            with redirect_stdout(first_output):
                self.assertEqual(main(["init", "--config", str(path)]), 0)
            token = load_config(path, environ={}).access_token
            second_output = io.StringIO()
            with redirect_stdout(second_output):
                self.assertEqual(main(["init", "--config", str(path)]), 0)
            check_output = io.StringIO()
            with redirect_stdout(check_output):
                self.assertEqual(main(["check-config", "--config", str(path)]), 0)

        self.assertIn(token, first_output.getvalue())
        self.assertEqual(second_output.getvalue(), "")
        self.assertNotIn(token, check_output.getvalue())

    def test_version_and_update_commands_return_stable_redacted_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "paperlens-mineru.toml"
            initialize_config(path)
            version_output = io.StringIO()
            with redirect_stdout(version_output):
                self.assertEqual(main(["version"]), 0)
            version_payload = json.loads(version_output.getvalue())
            self.assertEqual(version_payload["schemaVersion"], 1)
            self.assertRegex(version_payload["serviceVersion"], r"^[0-9]+\.[0-9]+\.[0-9]+$")

            update_output = io.StringIO()
            with (
                patch(
                    "paperlens_mineru.cli.check_for_update",
                    return_value=UpdateResult(
                        code="UPDATE_AVAILABLE",
                        current_version="0.1.0",
                        latest_version="0.2.0",
                    ),
                ) as check,
                redirect_stdout(update_output),
            ):
                self.assertEqual(
                    main(["update-check", "--scheduled", "--config", str(path)]),
                    0,
                )
            payload = json.loads(update_output.getvalue())
            self.assertEqual(payload["code"], "UPDATE_AVAILABLE")
            check.assert_called_once()
            combined = version_output.getvalue() + update_output.getvalue()
            self.assertNotIn(str(path), combined)
            self.assertNotIn(load_config(path, environ={}).access_token, combined)

    def test_update_error_prints_only_stable_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "paperlens-mineru.toml"
            initialize_config(path)
            error_output = io.StringIO()
            with (
                patch(
                    "paperlens_mineru.cli.check_for_update",
                    side_effect=UpdateError("UPDATE_NETWORK_FAILED", f"internal {path}"),
                ),
                patch("sys.stderr", error_output),
            ):
                self.assertEqual(main(["update-check", "--config", str(path)]), 2)

        self.assertIn("UPDATE_NETWORK_FAILED", error_output.getvalue())
        self.assertNotIn(str(path), error_output.getvalue())


if __name__ == "__main__":
    unittest.main()
