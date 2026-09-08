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

    def test_stale_rollout_without_fresh_database_timestamp_stays_skipped(self):
        self.append("item_completed", turn_id="turn-1", item={"type": "Reasoning"})
        stale = self.now - 3600
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

    def test_stale_started_turn_becomes_unknown(self):
        self.append("task_started", turn_id="turn-1")
        self.observed()
        self.now += 1801
        self.assertEqual(self.observed()["status"], "unknown")

    def test_long_tool_activity_uses_same_lease_as_started_turn(self):
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

    def test_read_failure_clears_live_claim(self):
        self.append("task_started", turn_id="turn-1")
        self.observed()
        with mock.patch("twin_shell.runtime_observer.sqlite3.connect", side_effect=sqlite3.OperationalError):
            self.assertEqual(self.observed()["status"], "unknown")
        self.assertTrue(self.observer.error)
        self.assertEqual(self.observed()["status"], "running")

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

    def test_older_terminal_cannot_override_new_snapshot(self):
        self.append("task_complete", turn_id="old")
        card = describe({}, [{"id": "new", "status": "interrupted"}], owned=False)
        apply_runtime(card, self.observed())
        self.assertEqual(card["status"], "interrupted")
        self.assertNotIn("runtime_source", card)


if __name__ == "__main__":
    unittest.main()
