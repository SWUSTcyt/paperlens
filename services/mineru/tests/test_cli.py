from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from paperlens_mineru.cli import default_config_path, initialize_config, main
from paperlens_mineru.config import load_config


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

        self.assertTrue(first.created)
        self.assertIsNotNone(first.token)
        self.assertFalse(second.created)
        self.assertIsNone(second.token)
        self.assertEqual(path.read_text(encoding="utf-8") if path.exists() else first_content, first_content)
        self.assertEqual(config.access_token, first.token)
        self.assertEqual(config.data_root, root / "data")

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


if __name__ == "__main__":
    unittest.main()
