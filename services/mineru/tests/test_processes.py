from __future__ import annotations

import unittest
import subprocess
from unittest.mock import Mock, patch

from paperlens_mineru.processes import terminate_process_tree


class ProcessTests(unittest.TestCase):
    @patch("paperlens_mineru.processes.subprocess.run")
    @patch("paperlens_mineru.processes.os.name", "nt")
    def test_windows_termination_targets_exact_pid_tree(self, run: Mock) -> None:
        process = Mock(pid=43210)
        process.poll.return_value = None
        terminate_process_tree(process)
        run.assert_called_once_with(
            ["taskkill.exe", "/PID", "43210", "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        process.wait.assert_called_once()

    @patch("paperlens_mineru.processes.subprocess.run")
    @patch("paperlens_mineru.processes.os.name", "nt")
    def test_windows_falls_back_to_exact_process_handle(self, run: Mock) -> None:
        process = Mock(pid=43211)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("taskkill", 5), 0]
        terminate_process_tree(process)
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)

    def test_rejects_invalid_pid(self) -> None:
        process = Mock(pid=0)
        process.poll.return_value = None
        with self.assertRaises(ValueError):
            terminate_process_tree(process)


if __name__ == "__main__":
    unittest.main()
