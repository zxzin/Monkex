"""Synthetic lifecycle coverage for content-free async question indicators."""
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from twin_shell.input_requests import InputRequests, pending_input, reply_ids
from twin_shell.runtime_observer import LocalRuntimeObserver, apply_runtime
from twin_shell.task_view import describe
from twin_shell.diagnostics import runtime_diagnostics
from twin_shell.orchestrator import WorkTwinShell, WorkTwinShellError


def question(call="call-a", count=1):
    return {"type": "AgentMessage", "id": call,
            "questions": [{"title": "Private question", "options": ["Private option"]} for _ in range(count)]}


def reply(call="call-a", indexes=(0,), *, role="UserMessage", status=None):
    items = [{"questionItemId": json.dumps(["request_user_input_async", call, index]),
              "question": "Private question", "answer": "Private answer"} for index in indexes]
    content = [{"type": "text", "text": "<send_user_message_question_reply>" + json.dumps(items) + "</send_user_message_question_reply>"}]
    return {"type": role, "status": status, "input" if role == "steeringUserMessage" else "content": content}


class InputStateTests(unittest.TestCase):
    def test_multiple_questions_partial_reply_and_duplicate_delivery(self):
        state = InputRequests.from_items([question(count=3), reply(indexes=(1,)), question(count=3)])
        result = state.snapshot(turn_id="current", observed_at=100)
        self.assertEqual((result["pending"], result["count"], result["available"]), (True, 2, True))
        self.assertNotIn("Private", str(state))
        state.observe(reply(indexes=(0, 2)))
        self.assertFalse(state.snapshot(turn_id="current", observed_at=101)["pending"])

    def test_reply_tombstone_prevents_later_question_revival(self):
        state = InputRequests.from_items([reply(), question()])
        self.assertFalse(state.snapshot(turn_id="current", observed_at=100)["pending"])

    def test_target_is_first_pending_question_in_canonical_item_order(self):
        state = InputRequests.from_items([question("z-call", count=2), question("a-call")])
        expected = lambda call, index: {"turn_id": "current", "question_id": json.dumps(["request_user_input_async", call, index], separators=(",", ":"))}
        self.assertEqual(state.snapshot(turn_id="current", observed_at=100)["target"], expected("z-call", 0))
        state.observe(reply("z-call", indexes=(0,)))
        self.assertEqual(state.snapshot(turn_id="current", observed_at=100)["target"], expected("z-call", 1))
        state.observe(reply("z-call", indexes=(1,)))
        self.assertEqual(state.snapshot(turn_id="current", observed_at=100)["target"], expected("a-call", 0))
        self.assertIsNone(state.snapshot(turn_id="current", observed_at=100, active=False)["target"])

    def test_api_merge_restores_question_order_and_retains_new_local_questions(self):
        local = InputRequests.from_items([question("local")])
        local.merge(InputRequests.from_items([question("api")]))
        self.assertEqual(json.loads(local.snapshot(turn_id="current", observed_at=100)["target"]["question_id"])[1], "api")
        local.observe(reply("api"))
        self.assertEqual(json.loads(local.snapshot(turn_id="current", observed_at=100)["target"]["question_id"])[1], "local")

    def test_whole_envelope_and_schema_are_required(self):
        text = reply()["content"][0]["text"]
        for value in ("quote " + text, "```" + text + "```", text + " quoted", "请回答我", text.replace('"answer": "Private answer", ', "")):
            if value == text:
                continue
            self.assertEqual(reply_ids([{"type": "text", "text": value}]), set())
        invalid = '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"call-a\\",0]"}]</send_user_message_question_reply>'
        self.assertEqual(reply_ids([{"type": "text", "text": invalid}]), set())

    def test_only_actual_user_or_accepted_steering_reply_clears(self):
        for role, status, pending in (("AgentMessage", None, True), ("ToolMessage", None, True),
                                      ("steeringUserMessage", "pending", True), ("steeringUserMessage", "rejected", True),
                                      ("steeringUserMessage", "accepted", False), ("userMessage", None, False)):
            state = InputRequests.from_items([question(), reply(role=role, status=status)])
            self.assertEqual(state.snapshot(turn_id="current", observed_at=100)["pending"], pending)

    def test_mismatched_ids_and_ordinary_text_leave_pending(self):
        state = InputRequests.from_items([question(), reply(call="other"), {"type": "userMessage", "content": [{"type": "text", "text": "Done"}]}])
        self.assertTrue(state.snapshot(turn_id="current", observed_at=100)["pending"])

    def test_codex_context_prefix_single_reply_and_invalid_batch(self):
        content = reply()["content"]
        original = content[0]["text"]
        wrapped = [{"type": "text", "text": "<environment_context>metadata</environment_context>\n## My request:\n" + original}]
        self.assertEqual(reply_ids(wrapped), {("call-a", 0)})
        single = original.replace(">[", ">").replace("]</", "</")
        self.assertEqual(reply_ids([{"type": "text", "text": single}]), {("call-a", 0)})
        invalid_batch = original.replace("]</", ', {"questionItemId":"invalid"}]</')
        self.assertEqual(reply_ids([{"type": "text", "text": invalid_batch}]), set())

    def test_plain_assistant_text_never_creates_questions(self):
        state = InputRequests.from_items([{"type": "AgentMessage", "id": "x", "text": "Need your answer. 需要用户输入"}])
        self.assertEqual(state.questions, set())

    def test_pending_validator_requires_exact_fresh_current_turn(self):
        field = InputRequests.from_items([question()]).snapshot(turn_id="current", observed_at=100)
        card = {"latest_turn_id": "current", "input_request": field}
        self.assertTrue(pending_input(card, 130))
        self.assertFalse(pending_input(card, 131))
        self.assertFalse(pending_input({**card, "latest_turn_id": "new"}, 101))
        self.assertFalse(pending_input({**card, "sync_pending": True}, 101))


class ObservedInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.log = self.root / "sessions" / "test.jsonl"
        self.log.parent.mkdir()
        self.log.touch()
        self.now = datetime.now(timezone.utc).timestamp()
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: self.now)
        with closing(sqlite3.connect(self.root / "state_5.sqlite")) as db, db:
            db.execute("CREATE TABLE threads(id TEXT, rollout_path TEXT, archived INTEGER)")
            db.execute("INSERT INTO threads VALUES ('thread', ?, 0)", (str(self.log),))

    def tearDown(self):
        self.tmp.cleanup()

    def event(self, kind, *, turn="current", envelope="event_msg", **extra):
        self.now += 1
        payload = {"type": kind, "turn_id": turn, **extra}
        with self.log.open("a") as stream:
            stream.write(json.dumps({"timestamp": datetime.fromtimestamp(self.now, timezone.utc).isoformat(),
                                     "type": envelope, "payload": payload}) + "\n")

    def observed(self):
        self.observer.refresh(["thread"])
        return self.observer.snapshot("thread")

    def test_cold_first_question_and_accepted_tool_output_keep_pending(self):
        self.event("item_completed", item=question())
        self.event("function_call_output", envelope="response_item", call_id="call-a", output='{"accepted":true}')
        self.assertTrue(self.observed()["input_request"]["pending"])
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: self.now)
        self.assertTrue(self.observed()["input_request"]["pending"])

    def test_same_turn_answer_clears_without_new_turn_and_no_content_retained(self):
        self.event("task_started")
        self.event("item_completed", item=question(count=2))
        self.assertEqual(self.observed()["input_request"]["count"], 2)
        self.event("item_completed", item=reply(indexes=(0,)))
        self.assertEqual(self.observed()["input_request"]["count"], 1)
        self.event("item_completed", item=reply(indexes=(1,)))
        result = self.observed()
        self.assertFalse(result["input_request"]["pending"])
        self.assertEqual(result["status"], "running")
        self.assertNotIn("Private", str(result))

    def test_input_lifetime_outlasts_runtime_lease_but_read_failure_is_unknown(self):
        self.event("item_completed", item=question())
        self.observed()
        self.now += 1900
        result = self.observed()
        self.assertEqual(result["status"], "unknown")
        self.assertTrue(result["input_request"]["pending"])
        self.assertTrue(result["input_request"]["available"])
        self.log.unlink()
        self.assertFalse(self.observed()["input_request"]["available"])

    def test_old_turn_reply_cannot_clear_current_and_new_terminal_clear(self):
        self.event("task_started")
        self.event("item_completed", item=question())
        self.event("item_completed", turn="old", item=reply())
        self.assertTrue(self.observed()["input_request"]["pending"])
        self.event("task_complete")
        self.assertFalse(self.observed()["input_request"]["pending"])
        self.event("task_started", turn="new")
        self.assertFalse(self.observed()["input_request"]["pending"])

    def test_api_seed_and_local_reply_merge_without_revival(self):
        self.event("task_started")
        self.event("item_completed", item=reply())
        self.observed()
        self.observer.observe_input_items("thread", "current", [question()])
        self.assertFalse(self.observed()["input_request"]["pending"])
        self.observer.observe_input_items("thread", "old", [question("old")])
        self.assertFalse(self.observed()["input_request"]["pending"])

    def test_feed_seeds_missing_question_from_full_current_turn_and_never_persists_it(self):
        self.event("item_completed", item={"type": "Reasoning"})
        self.observed()
        current_turn = {"id": "current", "status": "interrupted", "completedAt": None,
                        "items": [question()]}
        class Client:
            running = True
            def request(self, method, params, **kwargs):
                if method == "thread/read":
                    return {"result": {"thread": {"id": "thread", "name": "Fixture", "status": {"type": "notLoaded"}}}}
                return {"result": {"data": [current_turn]}}
        shell = WorkTwinShell(state_path=self.root / "state.json", client=Client())
        shell.runtime_observer = self.observer
        card = shell.feed.detail("thread")["card"]
        self.assertTrue(card["input_request"]["pending"])
        self.assertEqual(card["input_request"]["turn_id"], "current")
        self.assertNotIn("Private", shell.state_path.read_text())
        self.assertNotIn("input_request", shell.state_path.read_text())
        self.event("item_completed", item=reply())
        card = shell.feed.detail("thread", force=True)["card"]
        self.assertFalse(card["input_request"]["pending"])
        self.assertFalse(card["unread"])

    def test_disconnected_feed_masks_pending_input_availability(self):
        self.event("task_started")
        self.event("item_completed", item=question())
        field = self.observed()["input_request"]
        client = type("FixtureClient", (), {"running": False})()
        shell = WorkTwinShell(state_path=self.root / "state.json", client=client)
        shell._feed_thread = object()
        shell._feed_snapshot = {"threads": [{"id": "thread", "status": "running", "latest_turn_id": "current", "input_request": field}]}
        import time
        shell._feed_at = time.time()
        row = shell.list_threads()["threads"][0]
        self.assertTrue(row["input_request"]["pending"])
        self.assertFalse(row["input_request"]["available"])

    def test_interrupted_api_without_terminal_timestamp_preserves_pending(self):
        self.event("task_started")
        self.event("item_completed", item=question())
        seen = self.observed()
        self.now += 1900
        card = describe({}, [{"id": "current", "status": "interrupted", "completedAt": None, "items": []}], owned=False)
        card.update(latest_turn_status="interrupted", latest_turn_completed_at=0)
        apply_runtime(card, seen)
        self.assertEqual(card["status"], "running")

    def test_api_terminal_wins_over_delayed_local_question(self):
        self.event("task_started")
        self.event("item_completed", item=question())
        self.observed()
        shell = WorkTwinShell(state_path=self.root / "state.json", client=type("FixtureClient", (), {"running": True})())
        shell.runtime_observer = self.observer
        card = {"id": "thread", "latest_turn_id": "current", "status": "result_ready",
                "latest_turn_status": "completed", "latest_turn_completed_at": self.now + 1, "result_is_latest": True}
        shell.feed.telemetry(card)
        self.assertFalse(card["input_request"]["pending"])

    def test_waiting_user_does_not_become_network_or_tool_stall(self):
        field = InputRequests.from_items([question()]).snapshot(turn_id="current", observed_at=self.now)
        card = {"id": "thread", "latest_turn_id": "current", "status": "running", "input_request": field,
                "runtime": {"turn_id": "current", "activity_at": self.now - 3600, "pending_tools": 1, "phase": "tool"}}
        result = runtime_diagnostics([card], feed_at=self.now, connected=True, now=self.now)
        self.assertEqual(result["operational"]["code"], "awaiting_user_input")
        self.assertEqual(result["operational"]["quiet_tasks"], 0)
        self.assertEqual(result["tasks"][0]["token_signal"], "waiting_user")
        stale = runtime_diagnostics([card], feed_at=self.now - 31, connected=True, now=self.now)
        self.assertEqual(stale["operational"]["code"], "sync_unavailable")


class OpenInputTests(unittest.TestCase):
    def setUp(self):
        import time
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.client = type("FixtureClient", (), {"running": True})()
        self.shell = WorkTwinShell(state_path=self.root / "state.json", client=self.client)
        field = InputRequests.from_items([question()]).snapshot(turn_id="current", observed_at=time.time())
        self.target = field["target"]
        self.card = {"id": "thread", "status": "running", "latest_turn_id": "current", "input_request": field,
                     "unread": True, "pending_result_version": "older-result"}
        self.shell.feed.detail = Mock(return_value={"card": self.card, "thread": {"id": "thread"}})
        self.shell._feed_snapshot = {"threads": [{"id": "thread"}]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_exact_current_target_opens_thread_without_ack_send_or_harvest(self):
        before = json.dumps(self.shell._state, sort_keys=True)
        with patch("twin_shell.orchestrator.open_codex_thread") as opened, patch.object(self.shell, "acknowledge_result") as ack, patch.object(self.shell, "send_message") as send:
            result = self.shell.open_input("thread", **self.target)
        self.assertEqual(result, {"ok": True, "navigation_scope": "thread"})
        self.shell.feed.detail.assert_called_once_with("thread", force=True)
        opened.assert_called_once_with("thread")
        ack.assert_not_called()
        send.assert_not_called()
        self.assertTrue(self.card["unread"])
        self.assertEqual(json.dumps(self.shell._state, sort_keys=True), before)
        self.assertFalse(self.shell.state_path.exists())

    def test_answered_or_changed_target_returns_stale_without_navigation(self):
        for change in ("answered", "turn", "question"):
            with self.subTest(change=change), patch("twin_shell.orchestrator.open_codex_thread") as opened:
                original = json.loads(json.dumps(self.card))
                if change == "answered":
                    self.card["input_request"].update(pending=False, count=0, target=None)
                elif change == "turn":
                    self.card["latest_turn_id"] = "new"
                else:
                    self.card["input_request"]["target"] = {**self.target, "question_id": '["request_user_input_async","different",0]'}
                result = self.shell.open_input("thread", **self.target)
                self.assertEqual(result, {"ok": False, "stale": True, "reason": "input_target_changed"})
                opened.assert_not_called()
                self.card.clear()
                self.card.update(original)

    def test_disconnected_unavailable_or_unreadable_state_prevents_open(self):
        with patch("twin_shell.orchestrator.open_codex_thread") as opened:
            self.client.running = False
            self.assertEqual(self.shell.open_input("thread", **self.target)["reason"], "sync_unavailable")
            self.shell.feed.detail.assert_not_called()
            self.client.running = True
            self.card["input_request"]["available"] = False
            self.assertEqual(self.shell.open_input("thread", **self.target)["reason"], "sync_unavailable")
            for error in (TimeoutError(), WorkTwinShellError("Private response")):
                self.shell.feed.detail.side_effect = error
                result = self.shell.open_input("thread", **self.target)
                self.assertEqual(result["reason"], "sync_unavailable")
                self.assertNotIn("Private", str(result))
            opened.assert_not_called()

    def test_invalid_identity_is_rejected_before_reading_or_navigation(self):
        with patch("twin_shell.orchestrator.open_codex_thread") as opened:
            for thread, turn, question_id in (("../thread", "current", self.target["question_id"]),
                    ("thread", None, self.target["question_id"]), ("thread", "current", "invalid"),
                    ("thread", "current", '["other","call-a",0]'), ("thread", "current", '["request_user_input_async","call-a",true]')):
                with self.assertRaises(WorkTwinShellError):
                    self.shell.open_input(thread, turn_id=turn, question_id=question_id)
            self.shell.feed.detail.assert_not_called()
            opened.assert_not_called()

    def test_http_endpoint_preserves_origin_boundary_and_exact_payload(self):
        import importlib.util
        import threading
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        spec = importlib.util.spec_from_file_location("input_http_fixture", Path(__file__).resolve().parents[1] / "scripts/work_twin_shell.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        shell = Mock()
        shell.open_input.return_value = {"ok": False, "stale": True, "reason": "input_target_changed"}
        server = module.ShellHTTPServer(("127.0.0.1", 0), shell)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f"http://127.0.0.1:{server.server_port}/api/threads/thread/open-input"
        body = json.dumps(self.target).encode()
        headers = {"X-Work-Twin": "1", "Content-Type": "application/json"}
        try:
            with urlopen(Request(url, data=body, headers=headers), timeout=3) as response:
                self.assertEqual(json.load(response), shell.open_input.return_value)
            shell.open_input.assert_called_once_with("thread", **self.target)
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(url, data=body, headers={**headers, "Origin": "https://untrusted.example"}), timeout=3)
            self.assertEqual(error.exception.code, 403)
            self.assertEqual(shell.open_input.call_count, 1)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)


if __name__ == "__main__":
    unittest.main()
