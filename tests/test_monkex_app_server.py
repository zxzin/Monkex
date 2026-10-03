from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from twin_shell.app_server import AppServerClient, AppServerError, CodexNotFoundError
from twin_shell.orchestrator import WorkTwinShell


class AppServerStartupTests(unittest.TestCase):
    def test_connection_timeout_shows_retry_guidance_and_retains_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=MagicMock(running=False))
            shell.feed.collect = MagicMock(side_effect=AppServerError("timeout-private-sentinel"))
            shell._feed_snapshot = {"threads": [{"id": "previous-observation"}], "loading": True}
            shell._stop_event = MagicMock()
            shell._stop_event.is_set.side_effect = [False, True]
            shell._feed_loop()
            self.assertIn("重试", shell._feed_snapshot["error"])
            self.assertNotIn("请安装", shell._feed_snapshot["error"])
            self.assertNotIn("private-sentinel", shell._feed_snapshot["error"])
            self.assertEqual(shell._feed_snapshot["threads"], [{"id": "previous-observation"}])
            self.assertFalse(shell._feed_snapshot["loading"])
            shell._stop_event.wait.assert_called_once_with(8)

    def test_missing_executable_shows_installation_guidance(self):
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=MagicMock(running=False))
            shell.feed.collect = MagicMock(side_effect=CodexNotFoundError())
            shell._stop_event = MagicMock()
            shell._stop_event.is_set.side_effect = [False, True]
            shell._feed_loop()
            self.assertIn("请安装并登录", shell._feed_snapshot["error"])
            self.assertFalse(shell._feed_snapshot["loading"])

    def test_refresh_rediscovers_current_cli_even_when_old_file_remains(self):
        with tempfile.TemporaryDirectory() as temporary:
            old, new = Path(temporary) / "old-codex", Path(temporary) / "new-codex"
            old.touch()
            new.touch()
            processes = [MagicMock(), MagicMock()]
            for process in processes:
                process.poll.return_value = None
            with (
                patch("twin_shell.app_server.codex_executable", side_effect=[old, old, new]),
                patch("twin_shell.app_server.subprocess.Popen", side_effect=processes) as launch,
                patch("twin_shell.app_server.threading.Thread"),
            ):
                client = AppServerClient()
                client.request = MagicMock(return_value={"result": {}})
                client.notify = MagicMock()
                client.start()
                client.close()
                client.start()
                self.assertEqual([call.args[0][0] for call in launch.call_args_list], [str(old), str(new)])
                client.close()

    def test_explicit_cli_stays_pinned(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "specified-codex"
            executable.touch()
            process = MagicMock()
            process.poll.return_value = None
            with (
                patch("twin_shell.app_server.codex_executable") as discover,
                patch("twin_shell.app_server.subprocess.Popen", return_value=process) as launch,
                patch("twin_shell.app_server.threading.Thread"),
            ):
                client = AppServerClient(codex_cli=executable)
                client.request = MagicMock(return_value={"result": {}})
                client.notify = MagicMock()
                client.start()
                discover.assert_not_called()
                self.assertEqual(launch.call_args.args[0][0], str(executable))
                client.close()

    def test_missing_explicit_cli_preserves_isolated_user_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch("twin_shell.app_server.codex_executable") as discover:
                client = AppServerClient(codex_cli=Path(temporary) / "missing-codex")
                with self.assertRaises(AppServerError):
                    client.start()
                discover.assert_not_called()
                self.assertFalse(client.running)

    def test_initialization_failure_cleans_process_and_allows_retry(self):
        for failure in ({"error": {"code": -1}}, AppServerError("timeout")):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                executable = Path(temporary) / "codex"
                executable.touch()
                processes = [MagicMock(), MagicMock()]
                for process in processes:
                    process.poll.return_value = None
                with (
                    patch("twin_shell.app_server.subprocess.Popen", side_effect=processes),
                    patch("twin_shell.app_server.threading.Thread"),
                ):
                    client = AppServerClient(codex_cli=executable)
                    client.request = MagicMock(side_effect=[failure, {"result": {}}])
                    client.notify = MagicMock()
                    with self.assertRaises(AppServerError):
                        client.start()
                    self.assertFalse(client.running, "failed initialization leaves no live uninitialized session")
                    processes[0].terminate.assert_called_once()
                    client.start()
                    self.assertTrue(client.running)
                    client.close()


if __name__ == "__main__":
    unittest.main()
