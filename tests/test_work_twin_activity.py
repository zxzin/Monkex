from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from twin_shell.orchestrator import WorkTwinShell, WorkTwinShellError
from twin_shell.task_view import describe


def turn(tid="turn-a", status="completed", text="本地测试通过，尚未发布。"):
    return {"id": tid, "status": status, "items": [
        {"type": "userMessage", "content": [{"type": "text", "text": "检查这个应用的界面和按钮"}]},
        {"type": "agentMessage", "phase": "final_answer", "text": text},
    ]}


class FeedClient:
    running = True

    def __init__(self, root):
        self.root = root
        self.calls = []
        self.turns = [turn()]
        self.fail_send = False
        self.many = False
        self.on_message = None

    def request(self, method, params=None, **kwargs):
        self.calls.append((method, deepcopy(params)))
        if method == "thread/read":
            return {"result": {"thread": {"id": params["threadId"], "name": "示例产品", "cwd": str(self.root), "updatedAt": 10, "status": {"type": "idle"}}}}
        if method == "thread/turns/list":
            return {"result": {"data": list(reversed(self.turns))}}
        if method == "thread/list":
            page = 1 if params.get("cursor") else 0
            ids = range(page * 100, 105 if page else (100 if self.many else 1))
            return {"result": {"data": [{"id": f"thread-{i}", "name": "示例产品", "updatedAt": 500-i, "cwd": str(self.root)} for i in ids], "nextCursor": "next" if self.many and not page else None}}
        if method in {"turn/start", "turn/steer"}:
            if self.fail_send:
                raise TimeoutError("模拟回执超时")
            return {"result": {"turn": {"id": "sent-turn", "status": "inProgress"}, "turnId": "sent-turn"}}
        return {"result": {}}


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.client = FeedClient(self.root)
        self.shell = WorkTwinShell(state_path=self.root / "state.json", client=self.client)

    def tearDown(self):
        self.tmp.cleanup()

    def owned(self):
        self.shell._connected_threads.add("thread-0")
        return self.shell.read_thread("thread-0")["card"]

    def send(self, card, request="request-0001", text="请复核界面", **extra):
        return self.shell.send_message("thread-0", text, request_id=request, context_version=card["context_version"], **extra)

    def test_completed_turn_is_result_not_acceptance(self):
        card = self.shell.read_thread("thread-0")["card"]
        self.assertEqual(card["status"], "result_ready")
        self.assertIn("尚未验收", card["stage"])
        self.assertFalse(card["can_send"])

    def test_external_in_progress_is_not_confirmed_live(self):
        card = describe({"status": {"type": "notLoaded"}}, [{"id": "t", "status": "inProgress", "items": []}], owned=False)
        self.assertEqual(card["status"], "unknown")

    def test_result_retained_during_next_turn_and_after_restart(self):
        first = self.shell.read_thread("thread-0")["card"]
        self.client.turns.append({"id": "turn-b", "status": "inProgress", "items": []})
        running = self.shell.read_thread("thread-0")["card"]
        self.assertEqual(running["result_version"], first["result_version"])
        self.assertTrue(running["unread"])
        restored = WorkTwinShell(state_path=self.shell.state_path, client=self.client)
        current = restored.read_thread("thread-0")["card"]
        restored.acknowledge_result("thread-0", current["pending_result_version"])
        self.assertFalse(restored.read_thread("thread-0")["card"]["unread"])

    def test_older_pending_result_can_be_acknowledged(self):
        self.shell.read_thread("thread-0")
        self.client.turns = [{"id": "turn-c", "status": "inProgress", "items": []}]
        card = self.shell.read_thread("thread-0")["card"]
        self.assertIsNone(card["result_version"])
        self.assertTrue(card["unread"])
        self.shell.acknowledge_result("thread-0", card["pending_result_version"])

    def test_new_result_invalidates_old_ack(self):
        first = self.shell.read_thread("thread-0")["card"]
        self.client.turns = [turn("turn-b", text="新的核验结果")]
        second = self.shell.read_thread("thread-0")["card"]
        self.assertNotEqual(first["result_version"], second["result_version"])
        with self.assertRaises(ValueError):
            self.shell.acknowledge_result("thread-0", first["result_version"])

    def test_pagination_and_state_db_time_are_preserved(self):
        self.client.many = True
        feed = self.shell.feed.collect()
        self.assertEqual(len(feed["threads"]), 105)
        self.assertEqual(feed["threads"][0]["updated_at"], 500)
        self.assertTrue(feed["coverage"]["complete_listing"])

    def test_seven_day_window_hydrates_beyond_first_forty(self):
        self.client.many = True
        original = self.client.request
        def recent_request(method, params=None, **kwargs):
            result = original(method, params, **kwargs)
            if method == "thread/list":
                import time
                for row in result["result"]["data"]:
                    row["updatedAt"] = int(time.time()) - int(row["id"].split("-")[1]) * 60
            return result
        self.client.request = recent_request
        feed = self.shell.feed.collect()
        tail = next(t for t in feed["threads"] if t["id"] == "thread-104")
        self.assertTrue(tail["unread"])
        self.assertTrue(tail["has_result"])

    def test_exact_typed_message_and_duplicate_send(self):
        card = self.owned()
        text = "这是我的输入，请核对当前界面按钮。"
        first = self.send(card, text=text)
        second = self.send(card, text=text)
        self.assertTrue(first["accepted"] and second["duplicate"])
        sends = [p for m, p in self.client.calls if m == "turn/start"]
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0]["input"][0]["text"], text)
        stored = self.shell.state_path.read_text()
        for private in [text, "示例产品", "本地测试通过"]:
            self.assertNotIn(private, stored)

    def test_external_task_send_blocked(self):
        card = self.shell.read_thread("thread-0")["card"]
        with self.assertRaisesRegex(WorkTwinShellError, "桌面原任务"):
            self.send(card)
        self.assertFalse(any(m == "turn/start" for m, _ in self.client.calls))

    def test_codex_jump_uses_exact_target_without_resuming(self):
        with mock.patch("twin_shell.orchestrator.open_codex_thread") as run:
            result=self.shell.open_thread("thread-0")
        self.assertTrue(result["ok"])
        run.assert_called_once_with("thread-0")
        self.assertFalse(any(m in {"turn/start","thread/resume"} for m, _ in self.client.calls))
        with self.assertRaises(WorkTwinShellError):
            self.shell.open_thread("thread-0?other=1")

    def test_stale_context_and_retired_suggestion_blocked(self):
        card = self.owned()
        for suggestion_id in ["verify", "handoff", "missing", "", False]:
            with self.assertRaisesRegex(WorkTwinShellError, "推荐已移除"):
                self.send(card, suggestion_id=suggestion_id)
        self.assertFalse(any(m in {"turn/start", "turn/steer"} for m, _ in self.client.calls))
        self.assertEqual(self.shell._state["outbox"], {})
        self.client.turns = [turn("new")]
        with self.assertRaisesRegex(WorkTwinShellError, "新变化"):
            self.send(card)

    def test_timeout_locks_retry_even_with_new_request_id(self):
        card = self.owned()
        self.client.fail_send = True
        with self.assertRaises(TimeoutError):
            self.send(card)
        with self.assertRaisesRegex(WorkTwinShellError, "待核对"):
            self.send(card, request="request-0002")
        self.assertEqual(len([1 for m, _ in self.client.calls if m == "turn/start"]), 1)

    def test_running_message_steers_exact_turn(self):
        card = self.owned()
        self.shell._active_turns["thread-0"] = "active-turn"
        self.send(card)
        params = next(p for m, p in self.client.calls if m == "turn/steer")
        self.assertEqual(params["expectedTurnId"], "active-turn")
        self.assertFalse(any(m == "turn/start" for m, _ in self.client.calls))

    def test_restart_does_not_recover_control_authority(self):
        self.owned()
        restored = WorkTwinShell(state_path=self.shell.state_path, client=self.client)
        self.assertFalse(restored.read_thread("thread-0")["card"]["can_send"])

    def test_direct_terminal_response_does_not_leave_active_turn(self):
        card = self.owned()
        original = self.client.request
        def request(method, params=None, **kwargs):
            if method == "turn/start":
                return {"result": {"turn": {"id": "fast", "status": "completed"}}}
            return original(method, params, **kwargs)
        self.client.request = request
        self.send(card)
        self.assertNotIn("thread-0", self.shell._active_turns)

    def test_ack_updates_visible_feed_immediately(self):
        card = self.shell.read_thread("thread-0")["card"]
        self.shell._feed_snapshot = {"threads": [card]}
        self.shell.acknowledge_result("thread-0", card["pending_result_version"])
        self.assertFalse(self.shell._feed_snapshot["threads"][0]["unread"])

    def test_detail_uses_recent_metadata_time(self):
        self.shell.feed.collect()
        self.assertEqual(self.shell.read_thread("thread-0")["card"]["updated_at"], 500)

    def test_unchanged_snapshots_reuse_cache_and_changes_invalidate(self):
        self.shell.feed.collect()
        initial = len([1 for m, _ in self.client.calls if m == "thread/turns/list"])
        self.shell.feed.collect()
        self.assertEqual(len([1 for m, _ in self.client.calls if m == "thread/turns/list"]), initial)
        self.shell.feed.metadata["thread-0"]["updatedAt"] = 999
        self.shell.feed.detail("thread-0")
        self.assertEqual(len([1 for m, _ in self.client.calls if m == "thread/turns/list"]), initial+1)

    def test_desktop_events_invalidate_cache_without_metadata_change(self):
        observer = mock.Mock()
        observer.error = False
        observer.token_snapshot.return_value = {"ready": False}
        self.shell.runtime_observer = observer
        self.client.turns = [{"id": "turn-a", "status": "interrupted", "items": []}]
        observer.snapshot.return_value = {"status": "running", "turn_id": "turn-a", "event_at": 10, "revision": "start"}
        first = self.shell.feed.collect()["threads"][0]
        self.assertEqual(first["status"], "running")
        self.assertFalse(first["can_send"])
        self.assertNotIn("suggestions", first)
        observer.snapshot.return_value = {"status": "completed", "turn_id": "turn-a", "event_at": 11, "revision": "end"}
        second = self.shell.feed.collect()["threads"][0]
        self.assertEqual(second["status"], "completed")
        self.assertNotEqual(first["context_version"], second["context_version"])
        self.assertFalse(any(m in {"turn/start", "thread/resume"} for m, _ in self.client.calls))

    def test_feed_disconnect_and_staleness_clear_running_status(self):
        self.shell._feed_thread = mock.Mock()
        self.shell._feed_snapshot = {"threads": [{"id": "thread-0", "status": "running", "can_interrupt": True}]}
        for online, observed_at in [(False, 99), (True, 1)]:
            self.client.running = online
            self.shell._feed_at = observed_at
            with mock.patch("twin_shell.orchestrator.time.time", return_value=100):
                card = self.shell.list_threads()["threads"][0]
            self.assertEqual(card["status"], "unknown")
            self.assertFalse(card["can_interrupt"])

    def test_desktop_window_accepts_first_click(self):
        path = Path(__file__).resolve().parents[1] / "desktop_shell/src-tauri/tauri.conf.json"
        config = json.loads(path.read_text())
        self.assertTrue(config["app"]["windows"][0]["acceptFirstMouse"])

    def test_waiting_task_retains_status_without_recommendations(self):
        self.client.turns = [turn(text="需要你确认最终发布。")]
        card = self.owned()
        self.assertEqual(card["status"], "waiting_user")
        self.assertNotIn("suggestions", card)

    def test_read_waiting_task_keeps_execution_state_and_new_result_becomes_unread(self):
        self.client.turns = [turn(text="需要你确认最终发布。")]
        card = self.shell.read_thread("thread-0")["card"]
        self.shell.acknowledge_result("thread-0", card["pending_result_version"])
        restored = WorkTwinShell(state_path=self.shell.state_path, client=self.client)
        viewed = restored.read_thread("thread-0")["card"]
        self.assertFalse(viewed["unread"])
        self.assertEqual(viewed["status"], "waiting_user")
        self.assertFalse(viewed["can_send"])
        self.client.turns = [turn("new-result", text="新一轮仍需要你确认最终发布。")]
        self.assertTrue(restored.read_thread("thread-0")["card"]["unread"])
        self.assertFalse(any(m in {"turn/start", "turn/steer", "thread/resume"} for m, _ in self.client.calls))

    def test_feed_and_detail_do_not_generate_recommendations(self):
        self.assertNotIn("suggestions", self.owned())
        for card in self.shell.feed.collect()["threads"]:
            self.assertNotIn("suggestions", card)
        self.assertFalse(hasattr(self.shell.feed, "model"))

    def test_local_http_write_protection(self):
        path = Path(__file__).resolve().parents[1] / "scripts/work_twin_shell.py"
        spec = importlib.util.spec_from_file_location("shell_http_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        server = module.ShellHTTPServer(("127.0.0.1", 0), self.shell)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/api/threads/thread-0/ack"
        try:
            for headers in [{}, {"X-Work-Twin": "1", "Content-Type": "application/json", "Origin": "https://evil.example"}]:
                with self.assertRaises(HTTPError) as ctx:
                    urlopen(Request(url, data=b"{}", headers=headers), timeout=3)
                self.assertEqual(ctx.exception.code, 403)
            card = self.shell.read_thread("thread-0")["card"]
            with urlopen(Request(url, data=json.dumps({"version": card["result_version"]}).encode(), headers={"X-Work-Twin": "1", "Content-Type": "application/json"}), timeout=3) as response:
                self.assertEqual(response.status, 200)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
