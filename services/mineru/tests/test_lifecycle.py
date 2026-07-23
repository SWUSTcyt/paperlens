from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import psutil

from paperlens_mineru.config import ConfigError, ServiceConfig
from paperlens_mineru.lifecycle import (
    DATA_MARKER_NAME,
    SERVICE_STATE_NAME,
    service_instance,
    stop_service,
)


TOKEN = "lifecycle_test_token_1234567890abcdef"


class LifecycleTests(unittest.TestCase):
    def test_service_instance_marks_data_root_and_never_persists_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "paperlens-mineru.toml"
            config = ServiceConfig(access_token=TOKEN, data_root=root / "data")
            process = Mock(pid=1234)
            process.create_time.return_value = 456.25
            process.exe.return_value = str(root / "runtime" / "python.exe")

            with patch("paperlens_mineru.lifecycle.psutil.Process", return_value=process):
                with service_instance(config, config_path):
                    state_path = config.data_root / SERVICE_STATE_NAME
                    payload = state_path.read_text(encoding="utf-8")
                    self.assertNotIn(TOKEN, payload)
                    self.assertEqual(json.loads(payload)["pid"], 1234)
                    self.assertTrue((config.data_root / DATA_MARKER_NAME).is_file())
                self.assertFalse(state_path.exists())

    def test_refuses_second_live_instance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = ServiceConfig(access_token=TOKEN, data_root=root)
            state = {
                "schemaVersion": 1,
                "pid": 4321,
                "createTime": 99.5,
                "executable": str(root / "python.exe"),
                "configPath": str(root / "config.toml"),
                "nonce": "old",
            }
            root.mkdir(parents=True, exist_ok=True)
            (root / SERVICE_STATE_NAME).write_text(json.dumps(state), encoding="utf-8")
            existing = Mock()
            existing.create_time.return_value = 99.5

            with patch("paperlens_mineru.lifecycle.psutil.Process", return_value=existing):
                with self.assertRaises(ConfigError) as raised:
                    with service_instance(config, root / "config.toml"):
                        pass

        self.assertEqual(raised.exception.code, "SERVICE_ALREADY_RUNNING")

    def test_atomic_claim_refuses_instance_created_after_stale_check(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = ServiceConfig(access_token=TOKEN, data_root=root)

            def win_race(state_path: Path) -> None:
                state_path.write_text('{"created":"by-other-instance"}', encoding="utf-8")

            process = Mock(pid=1234)
            process.create_time.return_value = 1.0
            process.exe.return_value = str(root / "python.exe")
            with (
                patch("paperlens_mineru.lifecycle._reject_live_instance", side_effect=win_race),
                patch("paperlens_mineru.lifecycle.psutil.Process", return_value=process),
                self.assertRaises(ConfigError) as raised,
            ):
                with service_instance(config, root / "config.toml"):
                    pass

        self.assertEqual(raised.exception.code, "SERVICE_ALREADY_RUNNING")

    def test_stop_requires_exact_owned_process_and_terminates_children_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "paperlens-mineru.toml"
            _write_config(config_path, root)
            executable = root / "runtime" / "python.exe"
            state = {
                "schemaVersion": 1,
                "pid": 4321,
                "createTime": 99.5,
                "executable": str(executable),
                "configPath": str(config_path.resolve()),
                "nonce": "owned",
            }
            (root / SERVICE_STATE_NAME).write_text(json.dumps(state), encoding="utf-8")
            child = Mock()
            process = Mock()
            process.create_time.return_value = 99.5
            process.exe.return_value = str(executable)
            process.cmdline.return_value = [
                str(executable),
                "-m",
                "paperlens_mineru.cli",
                "serve",
                "--config",
                str(config_path.resolve()),
            ]
            process.children.return_value = [child]
            process.wait.return_value = 0

            with patch("paperlens_mineru.lifecycle.psutil.Process", return_value=process):
                result = stop_service(config_path)

            child.terminate.assert_called_once_with()
            process.terminate.assert_called_once_with()
            self.assertTrue(result.stopped)
            self.assertFalse((root / SERVICE_STATE_NAME).exists())

    def test_stop_rejects_forged_state_without_touching_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "paperlens-mineru.toml"
            _write_config(config_path, root)
            state = {
                "schemaVersion": 1,
                "pid": 4321,
                "createTime": 99.5,
                "executable": str(root / "expected.exe"),
                "configPath": str(config_path.resolve()),
                "nonce": "forged",
            }
            (root / SERVICE_STATE_NAME).write_text(json.dumps(state), encoding="utf-8")
            process = Mock()
            process.create_time.return_value = 99.5
            process.exe.return_value = str(root / "other.exe")

            with patch("paperlens_mineru.lifecycle.psutil.Process", return_value=process):
                with self.assertRaises(ConfigError) as raised:
                    stop_service(config_path)

            process.terminate.assert_not_called()
            self.assertTrue((root / SERVICE_STATE_NAME).exists())

        self.assertEqual(raised.exception.code, "SERVICE_STATE_UNTRUSTED")

    def test_stop_maps_process_tree_access_denied_to_stable_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "paperlens-mineru.toml"
            _write_config(config_path, root)
            executable = root / "python.exe"
            state = {
                "schemaVersion": 1,
                "pid": 4321,
                "createTime": 99.5,
                "executable": str(executable),
                "configPath": str(config_path.resolve()),
                "nonce": "owned",
            }
            (root / SERVICE_STATE_NAME).write_text(json.dumps(state), encoding="utf-8")
            process = Mock()
            process.create_time.return_value = 99.5
            process.exe.return_value = str(executable)
            process.cmdline.return_value = [
                str(executable), "-m", "paperlens_mineru.cli", "serve", "--config", str(config_path.resolve()),
            ]
            process.children.side_effect = psutil.AccessDenied(pid=4321)

            with patch("paperlens_mineru.lifecycle.psutil.Process", return_value=process):
                with self.assertRaises(ConfigError) as raised:
                    stop_service(config_path)

        self.assertEqual(raised.exception.code, "SERVICE_STOP_DENIED")


def _write_config(path: Path, data_root: Path) -> None:
    path.write_text(
        "\n".join(
            [
                "[server]",
                'host = "127.0.0.1"',
                "port = 17860",
                "",
                "[auth]",
                f'token = "{TOKEN}"',
                "",
                "[storage]",
                f'root = "{data_root.as_posix()}"',
                "",
            ]
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    unittest.main()
