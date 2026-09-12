from copy import deepcopy
from datetime import datetime
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


class CodexReadReceiptTests(unittest.TestCase):
    def setUp(self):
        from twin_shell.read_receipts import CodexReadReceipts
        self.tmp = tempfile.TemporaryDirectory()
        self.adapter = CodexReadReceipts(Path(self.tmp.name))
        self.ledger = {"thread-0": {"result_version": "result-a"}}
        self.cards = [{"id": "thread-0", "status": "result_ready", "unread": True}]

    def tearDown(self):
        self.tmp.cleanup()

    def snapshot(self, ids, host="local"):
        self.adapter.path.write_text(json.dumps({"electron-persisted-atom-state": {"unread-thread-ids-by-host-v1": {host: ids}}}), encoding="utf-8")

    def test_codex_view_clears_matching_result(self):
        self.snapshot(["thread-0"])
        self.adapter.reconcile(self.ledger, self.cards)
        self.snapshot([])
        self.assertTrue(self.adapter.reconcile(self.ledger, self.cards))
        self.assertFalse(self.cards[0]["unread"])
        self.assertEqual(self.ledger["thread-0"]["ack_version"], "result-a")
        self.assertFalse(self.adapter.reconcile(self.ledger, self.cards))

    def test_absence_at_first_launch_does_not_mark_everything_read(self):
        self.snapshot([])
        self.adapter.reconcile(self.ledger, self.cards)
        self.assertTrue(self.cards[0]["unread"])

    def test_new_result_cannot_be_cleared_by_old_removal(self):
        self.snapshot(["thread-0"])
        self.adapter.reconcile(self.ledger, self.cards)
        self.ledger["thread-0"]["result_version"] = "result-b"
        self.snapshot([])
        self.adapter.reconcile(self.ledger, self.cards)
        self.assertTrue(self.cards[0]["unread"])
        self.assertNotIn("ack_version", self.ledger["thread-0"])

    def test_restart_keeps_version_bound_receipt(self):
        from twin_shell.read_receipts import CodexReadReceipts
        self.snapshot(["thread-0"])
        self.adapter.reconcile(self.ledger, self.cards)
        restored = json.loads(json.dumps(self.ledger))
        self.snapshot([])
        CodexReadReceipts(self.adapter.path.parent).reconcile(restored, self.cards)
        self.assertFalse(self.cards[0]["unread"])

    def test_running_state_stays_running(self):
        self.cards[0]["status"] = "running"
        self.test_codex_view_clears_matching_result()
        self.assertEqual(self.cards[0]["status"], "running")

    def test_invalid_missing_remote_and_changed_schema_are_safe(self):
        self.snapshot(["thread-0"])
        self.adapter.reconcile(self.ledger, self.cards)
        for payload in ["{", "{}", "null", '{"electron-persisted-atom-state": []}']:
            self.adapter.path.write_text(payload, encoding="utf-8")
            self.assertFalse(self.adapter.reconcile(self.ledger, self.cards))
            self.assertTrue(self.cards[0]["unread"])
        self.snapshot([], host="remote")
        self.assertFalse(self.adapter.reconcile(self.ledger, self.cards))
        self.snapshot("thread-0")
        self.assertFalse(self.adapter.reconcile(self.ledger, self.cards))

    def test_other_user_directory_never_imports_receipt(self):
        from twin_shell.read_receipts import CodexReadReceipts
        with tempfile.TemporaryDirectory() as other:
            self.assertFalse(CodexReadReceipts(Path(other)).reconcile(self.ledger, self.cards))
            self.assertTrue(self.cards[0]["unread"])


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

    def test_local_completion_is_unread_after_old_ack_and_survives_stale_history(self):
        from twin_shell.runtime_observer import apply_runtime
        from twin_shell.task_view import result_version
        self.client.turns[0].update(startedAt=100, completedAt=110)
        old = self.shell.read_thread("thread-0")["card"]
        self.shell.acknowledge_result("thread-0", old["result_version"])
        card = deepcopy(old)
        evidence = {"status": "completed", "turn_id": "turn-b", "event_at": 200,
            "result_turn_id": "turn-b", "result_version": result_version("turn-b", "New result"),
            "result_completed_at": 200}
        apply_runtime(card, evidence)
        self.shell.feed.observe(card)
        self.assertTrue(card["unread"])
        self.assertEqual(card["status"], "result_ready")
        self.assertEqual(self.shell.weekly_harvest()["count"], 1)
        # A history-only refresh/restart cannot restore the previous result.
        restored = WorkTwinShell(state_path=self.root / "state.json", client=self.client)
        stale = restored.read_thread("thread-0")["card"]
        self.assertTrue(stale["unread"])
        self.assertEqual(stale["result_version"], evidence["result_version"])
        restored.acknowledge_result("thread-0", evidence["result_version"])
        self.assertFalse(restored.read_thread("thread-0")["card"]["unread"])

    def test_weekly_harvest_persists_and_deduplicates_successful_receipts(self):
        card = self.shell.read_thread("thread-0")["card"]
        version = card["result_version"]
        self.assertEqual(self.shell.weekly_harvest()["count"], 0)
        response = self.shell.acknowledge_result("thread-0", version)
        self.assertEqual(response["weekly_harvest"]["count"], 1)
        self.shell.acknowledge_result("thread-0", version)
        self.assertEqual(self.shell.weekly_harvest()["count"], 1)
        restored = WorkTwinShell(state_path=self.root / "state.json", client=self.client)
        self.assertEqual(restored.list_threads()["weekly_harvest"]["count"], 1)
        self.assertEqual(restored.acknowledge_result("thread-0", version)["weekly_harvest"]["count"], 1)

    def test_weekly_harvest_uses_local_monday_and_resets_across_years(self):
        self.shell._state["weekly_harvest"] = {"week_start": "2026-12-28", "count": 125}
        self.assertEqual(self.shell.weekly_harvest(datetime(2027, 1, 3, 23, 59, 59))["count"], 125)
        self.assertEqual(self.shell.weekly_harvest(datetime(2027, 1, 4)), {"week_start": "2027-01-04", "count": 0})
        with mock.patch("twin_shell.orchestrator.datetime") as clock:
            clock.now.return_value.astimezone.return_value = datetime(2027, 1, 4)
            card = self.shell.read_thread("thread-0")["card"]
            self.assertEqual(self.shell.acknowledge_result("thread-0", card["result_version"])["weekly_harvest"]["count"], 1)

    def test_weekly_harvest_save_failure_rolls_back_count_and_receipt(self):
        card = self.shell.read_thread("thread-0")["card"]
        with mock.patch.object(self.shell, "_save_state", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.shell.acknowledge_result("thread-0", card["result_version"])
        self.assertEqual(self.shell.weekly_harvest()["count"], 0)
        self.assertNotEqual(self.shell._state["observations"]["thread-0"].get("ack_version"), card["result_version"])
        self.assertEqual(self.shell.acknowledge_result("thread-0", card["result_version"])["weekly_harvest"]["count"], 1)

    def test_automatic_read_sync_and_invalid_receipts_do_not_add_harvest(self):
        card = self.shell.read_thread("thread-0")["card"]
        with self.assertRaises(ValueError):
            self.shell.acknowledge_result("thread-0", "outdated-result")
        self.assertEqual(self.shell.weekly_harvest()["count"], 0)
        self.shell._state["observations"]["thread-0"]["ack_version"] = card["result_version"]
        self.shell._save_state()
        self.assertEqual(self.shell.acknowledge_result("thread-0", card["result_version"])["weekly_harvest"]["count"], 0)

    def send(self, card, request="request-0001", text="请复核界面", **extra):
        return self.shell.send_message("thread-0", text, request_id=request, context_version=card["context_version"], **extra)

    def test_completed_turn_is_result_not_acceptance(self):
        card = self.shell.read_thread("thread-0")["card"]
        self.assertEqual(card["status"], "result_ready")
        self.assertIn("尚未验收", card["stage"])
        self.assertFalse(card["can_send"])

    def test_feed_and_cached_details_only_read_existing_codex_content(self):
        for _ in range(2):
            result = self.shell.list_threads()
            detail = self.shell.feed.detail("thread-0")
            self.assertTrue(result["threads"])
            self.assertEqual("检查这个应用的界面和按钮", detail["card"]["summary"])
        self.assertFalse(hasattr(self.shell, "summaries"))
        self.assertTrue(self.client.calls)
        self.assertLessEqual({method for method, _ in self.client.calls},
                             {"thread/list", "thread/read", "thread/turns/list"})
        self.assertIsNone(importlib.util.find_spec("twin_shell.semantic_summary"))

    def test_feed_syncs_codex_receipt_through_cached_rows(self):
        from twin_shell.read_receipts import CodexReadReceipts
        self.shell.codex_read_receipts = CodexReadReceipts(self.root)
        path = self.shell.codex_read_receipts.path
        def write(ids):
            path.write_text(json.dumps({"electron-persisted-atom-state": {"unread-thread-ids-by-host-v1": {"local": ids}}}), encoding="utf-8")
        write(["thread-0"])
        self.assertTrue(self.shell.list_threads()["threads"][0]["unread"])
        write([])
        self.assertFalse(self.shell.list_threads()["threads"][0]["unread"])
        self.assertFalse(self.shell.list_threads()["threads"][0]["unread"])
        self.assertEqual(json.loads(self.shell.state_path.read_text())["observations"]["thread-0"]["ack_version"], self.shell.read_thread("thread-0")["card"]["result_version"])

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
