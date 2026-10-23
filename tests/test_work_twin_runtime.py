from datetime import datetime, timezone
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from twin_shell.runtime_observer import LocalRuntimeObserver, apply_runtime
from twin_shell.task_view import describe


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.log = self.root / "sessions" / "rollout.jsonl"
        self.log.parent.mkdir()
        self.log.touch()
        self.now = datetime.now(timezone.utc).timestamp()
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: self.now)
        with closing(sqlite3.connect(self.root / "state_5.sqlite")) as db, db:
            db.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT, archived INTEGER)")
            db.execute("INSERT INTO threads VALUES (?,?,0)", ("thread-a", str(self.log)))

    def tearDown(self):
        self.tmp.cleanup()

    def test_refresh_closes_database_connection(self):
        connection = sqlite3.connect(self.root / "state_5.sqlite")
        tracked = mock.Mock(wraps=connection)
        with mock.patch("twin_shell.runtime_observer.sqlite3.connect", return_value=tracked):
            self.observer.refresh(["thread-a"])
        tracked.close.assert_called_once_with()
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")

    def test_database_timestamp_tracks_open_windows_rollout_with_stale_mtime(self):
        self.append("item_completed", turn_id="turn-1", item={"type": "Reasoning"})
        stale = self.now - 3600
        os.utime(self.log, (stale, stale))
        with closing(sqlite3.connect(self.root / "state_5.sqlite")) as db, db:
            db.execute("ALTER TABLE threads ADD COLUMN updated_at INTEGER")
            db.execute("UPDATE threads SET updated_at=? WHERE id=?", (int(self.now), "thread-a"))
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: self.now)
        self.assertEqual(self.observed()["status"], "running")

    @unittest.skipUnless(os.name == "nt", "Windows extended-length paths")
    def test_windows_extended_length_rollout_path_is_observed(self):
        self.append("item_completed", turn_id="turn-1", item={"type": "Reasoning"})
        extended_path = "\\\\?\\" + str(self.log)
        with closing(sqlite3.connect(self.root / "state_5.sqlite")) as db, db:
            db.execute("UPDATE threads SET rollout_path=? WHERE id=?", (extended_path, "thread-a"))
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: self.now)
        self.assertEqual(self.observed()["status"], "running")

    def test_stale_rollout_without_fresh_database_timestamp_stays_skipped(self):
        self.append("item_completed", turn_id="turn-1", item={"type": "Reasoning"})
        stale = self.now - 8 * 86400
        os.utime(self.log, (stale, stale))
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: self.now)
        self.assertEqual(self.observed()["status"], "unknown")

    def event(self, kind, *, turn_id=None, envelope="event_msg", **extra):
        payload = {"type": kind, **extra}
        if turn_id is not None:
            payload["turn_id"] = turn_id
        self.now += 1
        return json.dumps({"timestamp": datetime.fromtimestamp(self.now, timezone.utc).isoformat(), "type": envelope, "payload": payload}) + "\n"

    def append(self, kind, **kwargs):
        with self.log.open("a") as stream:
            stream.write(self.event(kind, **kwargs))

    def observed(self):
        self.observer.refresh(["thread-a"])
        return self.observer.snapshot("thread-a")

    def test_legacy_start_complete_and_restart(self):
        self.append("task_started", turn_id="turn-1")
        self.assertEqual(self.observed()["status"], "running")
        self.append("task_complete", turn_id="turn-1")
        self.assertEqual(self.observed()["status"], "completed")
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: self.now)
        self.assertEqual(self.observed()["status"], "completed")
        self.append("task_started", turn_id="turn-2")
        self.assertEqual(self.observed()["status"], "running")

    def test_paginated_progress_with_exact_turn_then_complete(self):
        self.append("item_completed", turn_id="turn-1", thread_id="thread-a", item={"type": "Reasoning", "text": "private"})
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_id"]), ("running", "turn-1"))
        self.append("task_complete", turn_id="turn-1")
        self.assertEqual(self.observed()["status"], "completed")

    def test_cold_tail_late_old_tool_end_preserves_newer_completed_turn(self):
        self.append("task_started", turn_id="old")
        self.append("task_complete", turn_id="old")
        self.append("token_count", junk="x" * 5000)
        self.append("task_started", turn_id="new")
        started_at = self.now
        self.append("task_complete", turn_id="new", last_agent_message="Result")
        completed_at = self.now
        self.now += 3600
        self.append("item_completed", turn_id="old", item={"type": "CommandExecution", "id": "old-tool"})
        # Both old lifecycle envelopes precede the bounded cold-start tail.
        with mock.patch("twin_shell.runtime_observer.READ_LIMIT", 1024):
            seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_id"]), ("completed", "new"))
        self.assertEqual((seen["turn_started_at"], seen["event_at"]), (started_at, completed_at))
        card = describe({}, [{"id": "new", "status": "completed", "startedAt": started_at,
            "completedAt": completed_at, "items": [{"type": "agentMessage", "text": "Result"}]}], owned=False)
        apply_runtime(card, seen)
        self.assertEqual((card["status"], card["latest_turn_id"]), ("result_ready", "new"))

    def test_isolated_named_progress_has_no_invented_start_and_expires(self):
        self.append("item_completed", turn_id="fragment", item={"type": "Reasoning"})
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_started_at"], seen["anchored"]), ("running", 0, False))
        self.now += 1801
        self.assertEqual(self.observed()["status"], "unknown")

    def test_new_context_progress_uses_bounded_lease_until_explicit_start(self):
        self.append(None, envelope="turn_context", turn_id="new", model="model")
        self.append("function_call", envelope="response_item", call_id="tool")
        self.assertEqual(self.observed()["turn_started_at"], 0)
        self.now += 1801
        self.assertEqual(self.observed()["status"], "unknown")
        self.append("task_started", turn_id="new")
        started_at = self.now
        self.now += 1801
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_started_at"], seen["anchored"]), ("running", started_at, True))

    def test_unknown_old_progress_cannot_replace_observed_running_turn(self):
        self.append("task_started", turn_id="new")
        started_at = self.now
        self.append("item_completed", turn_id="unseen-old", item={"type": "CommandExecution", "id": "old-tool"})
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_id"], seen["turn_started_at"]), ("running", "new", started_at))

    def test_late_old_turn_end_cannot_finish_new_turn(self):
        self.append("task_started", turn_id="turn-1")
        self.append("task_started", turn_id="turn-2")
        self.append("task_complete", turn_id="turn-1")
        self.append("item_completed", turn_id="turn-1", item={"type": "Reasoning"})
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_id"]), ("running", "turn-2"))

    def test_abort_terminal_sticky_against_late_activity(self):
        self.append("task_started", turn_id="turn-1")
        self.append("turn_aborted", turn_id="turn-1")
        self.append("agent_message", message="late")
        self.append("task_started", turn_id="turn-1")
        self.append("item_completed", turn_id="turn-1", item={"type": "AgentMessage"})
        self.assertEqual(self.observed()["status"], "interrupted")

    def test_error_completion_is_failed(self):
        self.append("task_started", turn_id="turn-1")
        self.append("task_complete", turn_id="turn-1", error="failure")
        self.assertEqual(self.observed()["status"], "failed")

    def test_structured_terminal_issue_is_private_bounded_and_turn_scoped(self):
        self.append("task_started", turn_id="turn-1")
        self.append("task_complete", turn_id="turn-1", error={"message": "PRIVATE_ERROR",
                    "codex_error_info": {"http_connection_failed": {"http_status_code": None}}})
        observed = self.observed()
        self.assertEqual(observed["runtime_issue"], {"state": "error", "code": "http_connection_failed", "at": self.now, "turn_id": "turn-1"})
        self.assertNotIn("PRIVATE_ERROR", repr(self.observer._cursors))
        card = describe({}, [{"id": "turn-1", "status": "inProgress", "startedAt": self.now - 2}], owned=False)
        apply_runtime(card, observed)
        self.assertEqual(card["runtime_issue"], observed["runtime_issue"])
        self.now += 301
        self.assertIsNone(self.observed()["runtime_issue"])

    def test_new_turn_clears_terminal_issue_and_late_old_error_stays_ignored(self):
        self.append("task_started", turn_id="turn-1")
        self.append("task_complete", turn_id="turn-1", error={"message": "PRIVATE_TIMEOUT", "codex_error_info": "other"})
        self.assertEqual(self.observed()["runtime_issue"]["code"], "task_error")
        self.append("task_started", turn_id="turn-2")
        self.append("task_complete", turn_id="turn-1", error={"codex_error_info": {"http_connection_failed": {"http_status_code": None}}})
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_id"]), ("running", "turn-2"))
        self.assertIsNone(seen["runtime_issue"])

    def test_unrecognized_error_message_never_implies_a_network_failure(self):
        self.append("task_started", turn_id="turn-1")
        self.append("task_complete", turn_id="turn-1", error={"message": "connection timed out PRIVATE_TEXT", "codex_error_info": {"new_unrecognized_error": {"private": "PRIVATE_DATA"}}})
        seen = self.observed()
        self.assertEqual(seen["runtime_issue"]["code"], "task_error")
        self.assertNotIn("PRIVATE_", repr(self.observer._cursors))

    def test_started_turn_survives_quiet_interval_until_matching_terminal(self):
        self.append("task_started", turn_id="turn-1")
        self.observed()
        self.now += 1801
        seen = self.observed()
        self.assertEqual(seen["status"], "running")
        self.assertFalse(seen["activity_fresh"])
        self.assertTrue(seen["observation_available"])
        self.append("task_complete", turn_id="turn-1")
        self.assertEqual(self.observed()["status"], "completed")

    def test_identified_tool_remains_pending_during_long_local_work(self):
        self.append("task_started", turn_id="turn-1")
        self.append("item_started", turn_id="turn-1", item={"type": "CommandExecution", "id": "tool-1"})
        self.observed()
        self.now += 3601
        seen = self.observed()
        self.assertEqual((seen["status"], seen["pending_tools"]), ("running", 1))
        self.assertFalse(seen["activity_fresh"])
        self.append("item_completed", turn_id="turn-1", item={"type": "CommandExecution", "id": "tool-1"})
        self.assertEqual(self.observed()["pending_tools"], 0)

    def test_late_superseded_turn_progress_cannot_replace_current_turn(self):
        self.append("task_started", turn_id="turn-1")
        self.append("task_started", turn_id="turn-2")
        self.append("item_started", turn_id="turn-2", item={"type": "CommandExecution", "id": "current-tool"})
        self.append("item_completed", turn_id="turn-1", item={"type": "Reasoning"})
        self.append(None, envelope="turn_context", turn_id="turn-1", model="old-model")
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_id"], seen["pending_tools"]), ("running", "turn-2", 1))
        self.assertNotEqual(seen["model"], "old-model")

    def test_new_context_associates_legacy_progress_after_previous_completion(self):
        self.append("task_started", turn_id="turn-1")
        self.append("task_complete", turn_id="turn-1")
        self.append(None, envelope="turn_context", turn_id="turn-2", model="new-model")
        self.append("function_call", envelope="response_item", call_id="call-new")
        seen = self.observed()
        self.assertEqual((seen["status"], seen["turn_id"], seen["pending_tools"]), ("running", "turn-2", 1))

    def test_anonymous_progress_uses_bounded_activity_lease(self):
        self.append("reasoning", envelope="response_item")
        self.assertEqual(self.observed()["status"], "running")
        self.now += 121
        self.assertEqual(self.observed()["status"], "running")
        self.now += 1680
        self.assertEqual(self.observed()["status"], "unknown")

    def test_message_text_and_token_count_are_not_lifecycle(self):
        fake = self.event("task_started", turn_id="fake")
        self.append("user_message", message=fake)
        self.append("token_count", info={"type": "task_started"})
        self.append("item_completed", turn_id="fake", item={"type": "UserMessage"})
        self.assertEqual(self.observed()["status"], "unknown")

    def test_token_telemetry_does_not_change_runtime_or_persist_content(self):
        self.append("task_started", turn_id="turn-1")
        self.append("token_count", info={"total_token_usage":{"total_tokens":1000}})
        self.append("token_count", info={"total_token_usage":{"total_tokens":1600}})
        self.append("task_complete", turn_id="turn-1")
        self.append("token_count", info={"total_token_usage":{"total_tokens":1600}})
        self.assertEqual(self.observed()["status"], "completed")
        tokens=self.observer.token_snapshot("thread-a")
        self.assertEqual(tokens["recent_tokens"],600)
        self.observed()
        self.assertEqual(self.observer.token_snapshot("thread-a")["recent_tokens"],600)
        self.assertEqual(self.observer.token_snapshot("missing")["ready"],False)

    def test_phase_is_timestamped_evidence_and_context_retains_only_model_settings(self):
        self.append("task_started", turn_id="turn-1")
        self.append(None, envelope="turn_context", turn_id="turn-1", model="gpt-example", effort="high",
                    cwd="PRIVATE_WORKSPACE", instructions="PRIVATE_INSTRUCTIONS")
        self.append("reasoning", envelope="response_item", text="PRIVATE_REASONING")
        observed = self.observed()
        self.assertEqual((observed["phase"], observed["model"], observed["effort"]), ("thinking", "gpt-example", "high"))
        self.assertEqual(observed["phase_at"], observed["activity_at"])
        original_at = observed["phase_at"]
        self.now += 180
        self.assertEqual(self.observed()["phase_at"], original_at)
        self.assertNotIn("PRIVATE_", repr(self.observer._cursors))

    def test_token_report_preserves_phase_and_activity_timestamp(self):
        self.append("task_started", turn_id="turn-1")
        original = self.observed()
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1000}})
        observed = self.observed()
        self.assertEqual((observed["phase"], observed["phase_at"], observed["activity_at"]),
                         ("starting", original["phase_at"], original["activity_at"]))

    def test_new_context_clears_turn_activity_and_usage_keeps_thread_window(self):
        self.append("task_started", turn_id="old")
        self.append("agent_reasoning", turn_id="old")
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1000}})
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1600}})
        self.append("task_complete", turn_id="old")
        self.observed()
        self.assertEqual(self.observer.diagnostics_snapshot("thread-a")[1]["recent_tokens"], 600)

        self.append(None, envelope="turn_context", turn_id="new")
        self.observed()
        evidence, tokens = self.observer.diagnostics_snapshot("thread-a")
        self.assertEqual((evidence["turn_id"], evidence["status"], evidence["phase"]),
                         ("new", "unknown", "unknown"))
        self.assertEqual((evidence["activity_at"], evidence["live_activity_at"], evidence["phase_at"]), (0, 0, 0))
        self.assertFalse(tokens["available"])
        self.assertFalse(tokens["ready"])
        self.assertIsNone(tokens["last_report_at"])
        self.assertIsNone(tokens["tokens_per_min"])
        self.assertEqual(self.observer.token_snapshot("thread-a")["recent_tokens"], 600)

    def test_new_start_requires_its_own_token_baseline_and_second_report(self):
        self.append("task_started", turn_id="old")
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1000, "output_tokens": 100}})
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1600, "output_tokens": 200}})
        self.append("task_started", turn_id="new")
        started_at = self.now
        self.observed()
        evidence, tokens = self.observer.diagnostics_snapshot("thread-a")
        self.assertEqual((evidence["turn_id"], evidence["phase"], evidence["activity_at"]),
                         ("new", "starting", started_at))
        self.assertFalse(tokens["ready"])
        self.assertIsNone(tokens["last_report_at"])

        self.append("token_count", turn_id="new", info={"total_token_usage": {"total_tokens": 1800, "output_tokens": 250}})
        self.observed()
        baseline = self.observer.diagnostics_snapshot("thread-a")[1]
        self.assertTrue(baseline["available"])
        self.assertFalse(baseline["ready"])
        self.assertIsNone(baseline["tokens_per_min"])
        self.assertFalse(baseline["output_ready"])
        self.assertEqual(self.observer.token_snapshot("thread-a")["recent_tokens"], 800)

        # A repeated context for the same turn preserves its own baseline.
        self.append(None, envelope="turn_context", turn_id="new")
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1900, "output_tokens": 275}})
        self.observed()
        evidence, tokens = self.observer.diagnostics_snapshot("thread-a")
        self.assertEqual((evidence["turn_id"], evidence["activity_at"]), ("new", started_at))
        self.assertTrue(tokens["ready"])
        self.assertEqual(tokens["recent_tokens"], 100)
        self.assertEqual(tokens["tokens_per_min"], 3000)
        self.assertEqual(tokens["recent_output_tokens"], 25)
        self.assertEqual(tokens["output_tokens_per_min"], 750)
        self.assertEqual(self.observer.token_snapshot("thread-a")["recent_tokens"], 900)

    def test_unassociated_reports_never_supply_current_turn_diagnostics(self):
        self.append("token_count", turn_id="unselected", info={"total_token_usage": {"total_tokens": 100}})
        self.append("token_count", info={"total_token_usage": {"total_tokens": 200}})
        self.observed()
        evidence, tokens = self.observer.diagnostics_snapshot("thread-a")
        self.assertIsNone(evidence["turn_id"])
        self.assertEqual(evidence["activity_at"], 0)
        self.assertFalse(tokens["available"])
        self.assertFalse(tokens["ready"])
        self.assertEqual(self.observer.token_snapshot("thread-a")["recent_tokens"], 100)

    def test_late_old_turn_token_report_preserves_current_turn_baseline(self):
        self.append("task_started", turn_id="old")
        self.append("task_started", turn_id="new")
        self.append("token_count", turn_id="new", info={"total_token_usage": {"total_tokens": 1000}})
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1100}})
        last_current_report = self.now
        self.observed()
        self.append("token_count", turn_id="old", info={"total_token_usage": {"total_tokens": 1150}})
        self.observed()
        evidence, tokens = self.observer.diagnostics_snapshot("thread-a")
        self.assertEqual(evidence["turn_id"], "new")
        self.assertEqual(tokens["last_report_at"], last_current_report)
        self.assertEqual(tokens["recent_tokens"], 100)
        self.assertEqual(self.observer.token_snapshot("thread-a")["recent_tokens"], 150)

    def test_diagnostics_snapshot_reads_evidence_and_turn_tokens_under_one_lock_and_clock(self):
        self.append("task_started", turn_id="current")
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1000}})
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1100}})
        self.observed()
        cursor = self.observer._cursors["thread-a"]
        original_lock = self.observer._lock

        class TrackingLock:
            held = False
            entries = 0

            def __enter__(self):
                original_lock.acquire()
                self.held = True
                self.entries += 1

            def __exit__(self, *_):
                self.held = False
                original_lock.release()

        lock = TrackingLock()
        evidence_snapshot, token_snapshot = cursor.snapshot, cursor.turn_tokens.snapshot
        times = []

        def capture_evidence(now):
            self.assertTrue(lock.held)
            times.append(now)
            return evidence_snapshot(now)

        def capture_tokens(now):
            self.assertTrue(lock.held)
            times.append(now)
            return token_snapshot(now)

        with mock.patch.object(self.observer, "_lock", lock), \
                mock.patch.object(self.observer, "clock", return_value=self.now) as clock, \
                mock.patch.object(cursor, "snapshot", side_effect=capture_evidence), \
                mock.patch.object(cursor.turn_tokens, "snapshot", side_effect=capture_tokens), \
                mock.patch.object(self.observer, "snapshot", side_effect=AssertionError("separate runtime read")), \
                mock.patch.object(self.observer, "token_snapshot", side_effect=AssertionError("separate token read")):
            evidence, tokens = self.observer.diagnostics_snapshot("thread-a")
        clock.assert_called_once_with()
        self.assertEqual(lock.entries, 1)
        self.assertFalse(lock.held)
        self.assertEqual(times, [self.now, self.now])
        self.assertEqual(evidence["turn_id"], "current")
        self.assertEqual(tokens["recent_tokens"], 100)

    def test_diagnostics_snapshot_masks_usage_when_observation_unavailable(self):
        self.append("task_started", turn_id="current")
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1000}})
        self.append("token_count", info={"total_token_usage": {"total_tokens": 1100}})
        self.observed()
        with mock.patch("twin_shell.runtime_observer.sqlite3.connect", side_effect=sqlite3.OperationalError):
            self.observed()
        evidence, tokens = self.observer.diagnostics_snapshot("thread-a")
        self.assertEqual(evidence["turn_id"], "current")
        self.assertFalse(evidence["observation_available"])
        self.assertFalse(tokens["available"])
        self.assertFalse(tokens["ready"])
        self.assertIsNone(tokens["last_report_at"])
        self.assertIsNone(tokens["tokens_per_min"])
        missing_evidence, missing_tokens = self.observer.diagnostics_snapshot("missing")
        self.assertFalse(missing_evidence["observation_available"])
        self.assertEqual(missing_evidence["status"], "unknown")
        self.assertFalse(missing_tokens["ready"])
        self.observed()
        self.assertEqual(self.observer.diagnostics_snapshot("thread-a")[1]["recent_tokens"], 100)

    def test_parallel_tool_pairing_deduplicates_envelopes_and_preserves_remaining_call(self):
        self.append("task_started", turn_id="turn-1")
        self.append("function_call", envelope="response_item", call_id="call-a", arguments="PRIVATE_ARGS")
        self.append("mcp_tool_call_begin", call_id="call-a")
        self.append("custom_tool_call", envelope="response_item", call_id="call-b", input="PRIVATE_INPUT")
        observed = self.observed()
        self.assertEqual((observed["phase"], observed["pending_tools"]), ("tool", 2))
        self.append("mcp_tool_call_end", call_id="call-a", result="PRIVATE_RESULT")
        self.assertEqual(self.observed()["pending_tools"], 1)
        self.append("function_call_output", envelope="response_item", call_id="call-a", output="PRIVATE_OUTPUT")
        self.assertEqual(self.observed()["pending_tools"], 1)
        self.append("custom_tool_call_output", envelope="response_item", call_id="call-b")
        self.assertEqual((self.observed()["phase"], self.observed()["pending_tools"]), ("waiting", 0))
        self.append("mcp_tool_call_begin", call_id="call-a")
        self.assertEqual((self.observed()["phase"], self.observed()["pending_tools"]), ("waiting", 0))
        self.assertNotIn("PRIVATE_", repr(self.observer._cursors))

    def test_tool_without_call_id_cannot_finish_a_different_pending_tool(self):
        self.append("task_started", turn_id="turn-1")
        self.append("exec_command_begin", call_id="call-a")
        self.append("exec_command_end")
        observed = self.observed()
        self.assertEqual((observed["phase"], observed["pending_tools"]), ("tool", 1))
        self.append("item_completed", item={"type": "CommandExecution", "call_id": "call-a"})
        self.assertEqual(self.observed()["pending_tools"], 0)

    def test_new_turn_and_terminal_clear_tool_metadata_without_changing_lifecycle(self):
        self.append("task_started", turn_id="turn-1")
        self.append(None, envelope="turn_context", turn_id="turn-1", model="old-model", effort="high")
        self.append("exec_command_begin", call_id="old-call")
        self.observed()
        self.append("task_started", turn_id="turn-2")
        fresh = self.observed()
        self.assertEqual((fresh["phase"], fresh["pending_tools"], fresh["model"]), ("starting", 0, None))
        self.append("exec_command_begin", call_id="new-call")
        self.append("task_complete", turn_id="turn-1")
        self.assertEqual(self.observed()["pending_tools"], 1)
        self.append("task_complete", turn_id="turn-2")
        finished = self.observed()
        self.assertEqual((finished["status"], finished["phase"], finished["pending_tools"]), ("completed", "waiting", 0))

    def test_tool_metadata_is_bounded_and_truncation_clears_it(self):
        self.append("task_started", turn_id="turn-1")
        for index in range(70):
            self.append("exec_command_begin", call_id=f"call-{index}")
        self.assertEqual(self.observed()["pending_tools"], 64)
        self.log.write_text("")
        observed = self.observed()
        self.assertEqual((observed["status"], observed["phase"], observed["pending_tools"]), ("unknown", "unknown", 0))

    def test_partial_line_and_unchanged_file(self):
        record = self.event("task_started", turn_id="turn-1")
        self.log.write_text(record[:-3])
        self.assertEqual(self.observed()["status"], "unknown")
        self.assertEqual(self.observed()["status"], "unknown")
        with self.log.open("a") as stream:
            stream.write(record[-3:])
        first = self.observed()
        self.assertEqual(first["status"], "running")
        self.assertEqual(first["revision"], self.observed()["revision"])

    def test_rotation_and_truncation_discard_old_running(self):
        self.append("task_started", turn_id="turn-1")
        self.observed()
        self.log.write_text("")
        self.assertEqual(self.observed()["status"], "unknown")
        new = self.log.with_name("next.jsonl")
        new.write_text(self.event("task_complete", turn_id="turn-2"))
        with closing(sqlite3.connect(self.root / "state_5.sqlite")) as db, db:
            db.execute("UPDATE threads SET rollout_path=?", (str(new),))
        self.assertEqual(self.observed()["status"], "completed")

    def test_bounded_tail_retains_fresh_terminal(self):
        self.append("task_started", turn_id="turn-1")
        self.observed()
        self.append("token_count", junk="x" * 5000)
        self.append("task_complete", turn_id="turn-1")
        with mock.patch("twin_shell.runtime_observer.READ_LIMIT", 1024):
            self.assertEqual(self.observed()["status"], "completed")

    def test_temporary_read_failure_preserves_lifecycle_with_unavailable_observation(self):
        self.append("task_started", turn_id="turn-1")
        self.observed()
        with mock.patch("twin_shell.runtime_observer.sqlite3.connect", side_effect=sqlite3.OperationalError):
            seen = self.observed()
            self.assertEqual((seen["status"], seen["turn_id"]), ("running", "turn-1"))
            self.assertFalse(seen["observation_available"])
        self.assertTrue(self.observer.error)
        self.assertEqual(self.observed()["status"], "running")
        self.append("task_complete", turn_id="turn-1")
        self.assertEqual(self.observed()["status"], "completed")

    def test_archived_metadata_invalidates_previous_running_lifecycle(self):
        self.append("task_started", turn_id="turn-1")
        self.observed()
        with closing(sqlite3.connect(self.root / "state_5.sqlite")) as db, db:
            db.execute("UPDATE threads SET archived=1 WHERE id='thread-a'")
        self.assertEqual(self.observed()["status"], "unknown")

    def test_malformed_and_other_thread_events_ignored(self):
        self.log.write_text("broken\n")
        self.append(["task_started"], turn_id="turn-1")
        self.append("task_started", turn_id="turn-1", thread_id="other")
        self.assertEqual(self.observed()["status"], "unknown")

    def test_observer_retains_metadata_only_and_does_not_write(self):
        self.append("agent_reasoning", text="PRIVATE_DIALOGUE_SECRET")
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.observed()
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertNotIn("PRIVATE_DIALOGUE_SECRET", repr(self.observer._cursors))

    def test_observation_updates_display_without_control(self):
        self.append("task_started", turn_id="turn-1")
        card = describe({}, [{"id": "turn-1", "status": "interrupted"}], owned=False)
        previous = card["context_version"]
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "running")
        self.assertFalse(card["can_send"] or card["can_interrupt"])
        self.assertNotEqual(card["context_version"], previous)

    def test_finished_snapshot_is_not_resurrected_by_unanchored_activity(self):
        self.append("agent_reasoning", text="late")
        card = describe({}, [{"id": "turn-1", "status": "completed", "items": [{"type": "agentMessage", "phase": "final_answer", "text": "Result"}]}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "result_ready")

    def test_isolated_late_named_tool_end_cannot_override_api_terminal(self):
        started_at, completed_at = self.now - 20, self.now - 10
        self.append("item_completed", turn_id="unknown-old", item={"type": "CommandExecution", "id": "old-tool"})
        seen = self.observed()
        for terminal in ("completed", "failed", "interrupted"):
            with self.subTest(terminal=terminal):
                card = describe({}, [{"id": "new", "status": terminal, "startedAt": started_at,
                    "completedAt": completed_at, "items": [{"type": "agentMessage", "text": "Result"}]}], owned=False)
                card.update(latest_turn_status=terminal, latest_turn_completed_at=completed_at)
                before = card["status"]
                apply_runtime(card, seen)
                self.assertEqual((card["status"], card["latest_turn_id"], card["latest_turn_started_at"]),
                                 (before, "new", started_at))

    def test_expired_named_fragment_preserves_independent_api_active(self):
        self.append("item_completed", turn_id="fragment", item={"type": "Reasoning"})
        self.observed()
        self.now += 1801
        card = describe({"status": {"type": "active"}}, [{"id": "current", "status": "inProgress", "startedAt": self.now}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_id"]), ("running", "current"))

    def test_fresh_unanchored_fragment_preserves_independent_api_active_turn(self):
        self.append("item_completed", turn_id="fragment", item={"type": "CommandExecution", "id": "old-tool"})
        card = describe({"status": {"type": "active"}}, [{"id": "current", "status": "inProgress", "startedAt": self.now - 10}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_id"], card["latest_turn_started_at"]),
                         ("running", "current", self.now - 10))

    def test_matching_unanchored_progress_preserves_api_start_timestamp(self):
        self.append("item_completed", turn_id="current", item={"type": "Reasoning"})
        card = describe({}, [{"id": "current", "status": "inProgress", "startedAt": self.now - 10}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_started_at"]), ("running", self.now - 10))

    def test_cold_current_work_overrides_unconfirmed_api_interruption(self):
        self.append("task_started", turn_id="current")
        started_at = self.now
        self.append("token_count", junk="x" * 5000)
        self.append("item_completed", turn_id="current", item={"type": "Reasoning"})
        work_at = self.now
        self.append("item_completed", turn_id="current", item={"type": "CommandExecution", "id": "tool"})
        with mock.patch("twin_shell.runtime_observer.READ_LIMIT", 1024):
            evidence = self.observed()
        self.assertFalse(evidence["anchored"])
        card = describe({}, [{"id": "current", "status": "interrupted", "startedAt": started_at}], owned=False)
        card.update(latest_turn_status="interrupted", latest_turn_completed_at=0)
        apply_runtime(card, evidence)
        self.assertEqual((card["status"], card["latest_turn_id"], card["latest_turn_started_at"]), ("running", "current", started_at))
        self.assertEqual(evidence["live_activity_at"], work_at)
        self.assertTrue(evidence["live_activity_fresh"])

    def test_isolated_tool_end_keeps_unconfirmed_api_interruption(self):
        self.append("item_completed", turn_id="current", item={"type": "CommandExecution", "id": "tool"})
        card = describe({}, [{"id": "current", "status": "interrupted", "startedAt": self.now - 10}], owned=False)
        card.update(latest_turn_status="interrupted", latest_turn_completed_at=0)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "interrupted")

    def test_stale_work_with_fresh_tool_end_keeps_unconfirmed_interruption(self):
        self.append("item_completed", turn_id="current", item={"type": "Reasoning"})
        self.observed()
        self.now += 1801
        self.append("item_completed", turn_id="current", item={"type": "CommandExecution", "id": "tool"})
        card = describe({}, [{"id": "current", "status": "interrupted", "startedAt": self.now - 2000}], owned=False)
        card.update(latest_turn_status="interrupted", latest_turn_completed_at=0)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "interrupted")

    def test_fresh_work_keeps_confirmed_api_terminal(self):
        self.append("item_completed", turn_id="current", item={"type": "Reasoning"})
        for terminal in ("completed", "failed", "interrupted"):
            with self.subTest(terminal=terminal):
                card = describe({}, [{"id": "current", "status": terminal, "startedAt": self.now - 20,
                    "completedAt": self.now - 10}], owned=False)
                card.update(latest_turn_status=terminal, latest_turn_completed_at=self.now - 10)
                before = card["status"]
                apply_runtime(card, self.observed())
                self.assertEqual(card["status"], before)

    def test_observation_failure_keeps_unconfirmed_api_interruption(self):
        self.append("item_completed", turn_id="current", item={"type": "Reasoning"})
        self.observed()
        with mock.patch("twin_shell.runtime_observer.sqlite3.connect", side_effect=sqlite3.OperationalError):
            evidence = self.observed()
        card = describe({}, [{"id": "current", "status": "interrupted", "startedAt": self.now - 10}], owned=False)
        card.update(latest_turn_status="interrupted", latest_turn_completed_at=0)
        apply_runtime(card, evidence)
        self.assertEqual(card["status"], "interrupted")

    def test_older_terminal_cannot_override_new_snapshot(self):
        self.append("task_complete", turn_id="old")
        card = describe({}, [{"id": "new", "status": "interrupted"}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "interrupted")
        self.assertNotIn("runtime_source", card)

    def test_unavailable_local_observer_preserves_independent_api_active_status(self):
        card = describe({"status": {"type": "active"}}, [{"id": "new", "status": "inProgress", "startedAt": self.now}], owned=False)
        apply_runtime(card, {"status": "unknown", "revision": "unavailable", "observation_available": False})
        self.assertEqual(card["status"], "running")

    def test_older_running_tail_cannot_override_newer_api_terminal(self):
        self.append("task_started", turn_id="old")
        card = describe({}, [{"id": "new", "status": "completed", "startedAt": self.now + 10,
            "completedAt": self.now + 20, "items": [{"type": "agentMessage", "text": "New result"}]}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_id"]), ("result_ready", "new"))

    def test_same_turn_api_completion_wins_over_previous_local_start(self):
        self.append("task_started", turn_id="turn-1")
        card = describe({}, [{"id": "turn-1", "status": "completed", "startedAt": self.now,
            "completedAt": self.now + 20, "items": [{"type": "agentMessage", "text": "Result"}]}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "result_ready")

    def test_same_turn_final_result_without_api_timestamps_stays_completed(self):
        self.append("task_started", turn_id="turn-1")
        card = describe({}, [{"id": "turn-1", "status": "completed", "items": [{"type": "agentMessage", "text": "Result"}]}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "result_ready")

    def test_newer_api_result_with_only_completion_time_is_not_resurrected(self):
        self.append("task_started", turn_id="old")
        card = describe({}, [{"id": "new", "status": "completed", "completedAt": self.now + 20,
            "items": [{"type": "agentMessage", "text": "Result"}]}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_id"]), ("result_ready", "new"))

    def test_new_running_tail_replaces_older_completed_api_turn_identity(self):
        card = describe({}, [{"id": "old", "status": "completed", "startedAt": self.now - 20,
            "completedAt": self.now - 10, "items": [{"type": "agentMessage", "text": "Result"}]}], owned=False)
        self.append("task_started", turn_id="new")
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_id"]), ("running", "new"))

    def test_unanchored_old_terminal_cannot_finish_current_api_turn(self):
        self.append("task_complete", turn_id="old", last_agent_message="Earlier result")
        evidence = self.observed()
        for runtime in ("active", "idle"):
            with self.subTest(runtime=runtime):
                card = describe({"status": {"type": runtime}}, [{"id": "current", "status": "inProgress", "startedAt": self.now - 10}], owned=False)
                card["latest_turn_status"] = "inProgress"
                before = card["status"]
                apply_runtime(card, evidence)
                self.assertEqual((card["status"], card["latest_turn_id"]), (before, "current"))
                self.assertEqual(card["result_turn_id"], "old")
                self.assertFalse(card["result_is_latest"])
                self.assertNotIn("runtime_source", card)

    def test_same_turn_unanchored_terminal_finishes_current_api_turn(self):
        card = describe({"status": {"type": "active"}}, [{"id": "current", "status": "inProgress", "startedAt": self.now - 10}], owned=False)
        card["latest_turn_status"] = "inProgress"
        self.append("task_complete", turn_id="current", last_agent_message="Result")
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_id"]), ("result_ready", "current"))

    def test_anchored_new_terminal_finishes_lagging_api_running_turn(self):
        card = describe({"status": {"type": "active"}}, [{"id": "old", "status": "inProgress", "startedAt": self.now - 10}], owned=False)
        card["latest_turn_status"] = "inProgress"
        self.append("task_started", turn_id="new")
        self.append("task_complete", turn_id="new", last_agent_message="Result")
        apply_runtime(card, self.observed())
        self.assertEqual((card["status"], card["latest_turn_id"]), ("result_ready", "new"))

    def test_new_local_result_replaces_stale_api_turn_and_matches_api_version(self):
        old = {"id": "old", "status": "interrupted", "startedAt": self.now - 100}
        card = describe({}, [old], owned=False)
        self.append("task_started", turn_id="new")
        self.append("task_complete", turn_id="new", last_agent_message="New result")
        apply_runtime(card, self.observed())
        fresh = describe({}, [{"id": "new", "status": "completed", "items": [
            {"type": "agentMessage", "phase": "final_answer", "text": "New result"}]}], owned=False)
        self.assertEqual(card["status"], "result_ready")
        self.assertEqual(card["latest_turn_id"], "new")
        self.assertTrue(card["has_result"] and card["result_is_latest"])
        self.assertEqual(card["result_version"], fresh["result_version"])
        self.assertNotIn("New result", repr(self.observer._cursors))

    def test_completed_result_survives_cold_start_after_runtime_lease(self):
        self.append("task_complete", turn_id="new", last_agent_message="Result")
        self.now += 3600
        self.assertIsNotNone(self.observed().get("result_version"))

    def test_old_completion_cannot_replace_newer_api_result(self):
        self.append("task_complete", turn_id="old", last_agent_message="Old result")
        card = describe({}, [{"id": "new", "status": "completed", "startedAt": self.now + 10,
            "completedAt": self.now + 20, "items": [{"type": "agentMessage", "text": "New result"}]}], owned=False)
        version = card["result_version"]
        apply_runtime(card, self.observed())
        self.assertEqual(card["result_version"], version)
        self.assertEqual(card["latest_turn_id"], "new")

    def test_newer_api_terminal_for_same_turn_wins_over_older_local_terminal(self):
        self.append("task_complete", turn_id="turn-1", last_agent_message="Older result")
        card = describe({}, [{"id": "turn-1", "status": "failed", "startedAt": self.now - 20}], owned=False)
        card.update(latest_turn_status="failed", latest_turn_completed_at=self.now + 10)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "failed")
        self.assertFalse(card["has_result"])


if __name__ == "__main__":
    unittest.main()
