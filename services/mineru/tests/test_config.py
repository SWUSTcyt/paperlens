from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from paperlens_mineru.config import (
    BACKEND,
    DEFAULT_HOST,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_PAGES,
    DEFAULT_PORT,
    DEFAULT_TASK_TIMEOUT_SECONDS,
    DEFAULT_TTL_SECONDS,
    MINERU_VERSION,
    ConfigError,
    generate_access_token,
    load_config,
)


TOKEN_A = "a" * 43
TOKEN_B = "b" * 43


class ConfigTests(unittest.TestCase):
    def test_frozen_defaults_are_exact(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = load_config(
                environ={
                    "LOCALAPPDATA": r"C:\Users\Test\AppData\Local",
                    "PAPERLENS_MINERU_TOKEN": TOKEN_A,
                }
            )

        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.port, 17860)
        self.assertEqual(config.backend, "pipeline")
        self.assertEqual(config.mineru_version, "3.4.4")
        self.assertEqual(config.max_concurrent_jobs, 1)
        self.assertEqual(config.max_pdf_bytes, 200 * 1024 * 1024)
        self.assertEqual(config.max_pdf_pages, 500)
        self.assertEqual(config.task_timeout_seconds, 30 * 60)
        self.assertEqual(config.result_ttl_seconds, 24 * 60 * 60)
        self.assertEqual(
            config.data_root,
            Path(r"C:\Users\Test\AppData\Local") / "PaperLens" / "MinerU",
        )
        self.assertEqual(
            (
                DEFAULT_HOST,
                DEFAULT_PORT,
                BACKEND,
                MINERU_VERSION,
                DEFAULT_MAX_BYTES,
                DEFAULT_MAX_PAGES,
                DEFAULT_TASK_TIMEOUT_SECONDS,
                DEFAULT_TTL_SECONDS,
            ),
            ("127.0.0.1", 17860, "pipeline", "3.4.4", 209_715_200, 500, 1800, 86400),
        )

    def test_config_file_then_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "paperlens-mineru.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[server]",
                        'host = "127.0.0.1"',
                        "port = 18000",
                        "[auth]",
                        f'token = "{TOKEN_A}"',
                        "[storage]",
                        f'root = "{(root / "jobs").as_posix()}"',
                    ]
                ),
                encoding="utf-8",
            )
            config = load_config(
                config_path,
                environ={
                    "PAPERLENS_MINERU_PORT": "18001",
                    "PAPERLENS_MINERU_TOKEN": TOKEN_B,
                },
            )

        self.assertEqual(config.port, 18001)
        self.assertEqual(config.access_token, TOKEN_B)
        self.assertEqual(config.data_root, root / "jobs")
        self.assertNotIn(TOKEN_B, repr(config))
        self.assertEqual(config.safe_dict()["access_token"], "<redacted>")

    def test_rejects_remote_host_unknown_keys_and_weak_token(self) -> None:
        cases = [
            ("[server]\nhost='0.0.0.0'\n[auth]\ntoken='" + TOKEN_A + "'", "CONFIG_HOST_FORBIDDEN"),
            ("[server]\nport=17860\nremote_url='https://ocr.example'\n[auth]\ntoken='" + TOKEN_A + "'", "CONFIG_UNKNOWN_KEY"),
            ("[auth]\ntoken='short'", "CONFIG_TOKEN_INVALID"),
        ]
        for content, expected_code in cases:
            with self.subTest(expected_code), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.toml"
                path.write_text(content, encoding="utf-8")
                with self.assertRaises(ConfigError) as raised:
                    load_config(path, environ={})
                self.assertEqual(raised.exception.code, expected_code)
                self.assertNotIn("ocr.example", str(raised.exception))

    def test_rejects_invalid_port_and_relative_storage_path(self) -> None:
        cases = [
            ("[server]\nport=80\n[auth]\ntoken='" + TOKEN_A + "'", "CONFIG_PORT_INVALID"),
            ("[auth]\ntoken='" + TOKEN_A + "'\n[storage]\nroot='relative/jobs'", "CONFIG_STORAGE_INVALID"),
        ]
        for content, expected_code in cases:
            with self.subTest(expected_code), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.toml"
                path.write_text(content, encoding="utf-8")
                with self.assertRaises(ConfigError) as raised:
                    load_config(path, environ={})
                self.assertEqual(raised.exception.code, expected_code)

    def test_generated_token_is_url_safe_and_not_reused(self) -> None:
        first = generate_access_token()
        second = generate_access_token()
        self.assertGreaterEqual(len(first), 43)
        self.assertRegex(first, r"^[A-Za-z0-9_-]+$")
        self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
