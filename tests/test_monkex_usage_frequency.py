"""Distinct-run frequency regression; synthetic local records only."""
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from twin_shell import usage_frequency as frequency
from twin_shell.runtime_observer import LocalRuntimeObserver
from twin_shell.orchestrator import WorkTwinShell

NOW = datetime(2026, 10, 30, 12, tzinfo=timezone.utc).timestamp()


def event(turn, age=0, kind="task_started", **payload):
    return {"type": "event_msg", "timestamp": datetime.fromtimestamp(NOW-age, timezone.utc).isoformat(),
            "payload": {"type": kind, "turn_id": turn, **payload}}


class RunFrequencyTests(unittest.TestCase):
    def test_distinct_starts_exclude_tools_tokens_messages_and_terminal_duplicates(self):
        value = frequency.RunFrequency(complete=True)
        for record in [event("a", 10), event("a", 10), event("b", 5),
                       event("a", 4, "task_complete"), event("b", 3, "turn_aborted"),
                       event("c", 2, "token_count"), event("d", 1, "exec_command_begin"),
                       event("e", 1, "user_message", message="PRIVATE_BODY")]:
            value.observe(record, "thread", NOW)
        self.assertEqual(value.snapshot(NOW)["run_count"], 2)
        self.assertNotIn("PRIVATE_BODY", repr(value))

    def test_same_turn_retains_earliest_start_in_either_scan_direction(self):
        for ages in [(5, 100), (100, 5)]:
            value = frequency.RunFrequency(complete=True)
            for age in ages:
                value.observe(event("same", age), "thread", NOW)
            self.assertEqual(value.snapshot(NOW)["last_run_at"], NOW-100)

    def test_original_start_keeps_a_replayed_turn_outside_the_window_in_both_orders(self):
        for ages in [(1, 8*frequency.DAY), (8*frequency.DAY, 1)]:
            value = frequency.RunFrequency(complete=True)
            for age in ages:
                value.observe(event("same", age), "thread", NOW)
            self.assertEqual(value.snapshot(NOW)["run_count"], 0)

    def test_weights_boundaries_and_rolling_active_days(self):
        value = frequency.RunFrequency(complete=True)
        for i, age in enumerate([0, frequency.DAY-1, frequency.DAY, 3*frequency.DAY-1,
                                  3*frequency.DAY, 7*frequency.DAY-1, 7*frequency.DAY]):
            value.observe(event(str(i), age), "thread", NOW)
        data = value.snapshot(NOW)
        self.assertEqual(data["run_count"], 6)
        self.assertEqual(data["weighted_score"], 12)
        self.assertEqual(data["active_days"], 5)
        self.assertEqual(value.snapshot(NOW+7*frequency.DAY)["run_count"], 0)

    def test_future_foreign_missing_identity_and_quoted_events(self):
        value = frequency.RunFrequency(complete=True)
        for record in [event("future", -31), event("foreign", thread_id="another"),
                       event(None), {"type":"response_item", "payload":event("quoted")}]:
            value.observe(record, "thread", NOW)
        self.assertFalse(value.snapshot(NOW)["available"])

    def test_unavailable_differs_from_observed_zero(self):
        value = frequency.RunFrequency(complete=True)
        self.assertIsNone(value.snapshot(NOW)["run_count"])
        value.observe(event("old", 8*frequency.DAY), "thread", NOW)
        data = value.snapshot(NOW)
        self.assertTrue(data["available"])
        self.assertTrue(data["complete"])
        self.assertEqual(data["run_count"], 0)
        self.assertIsNone(data["last_run_at"])

    def test_run_cap_is_a_lower_bound(self):
        value = frequency.RunFrequency(complete=True)
        with patch.object(frequency, "RUN_LIMIT", 2):
            for i in range(3):
                value.observe(event(str(i), i), "thread", NOW)
        self.assertEqual(value.snapshot(NOW)["run_count"], 2)
        self.assertFalse(value.snapshot(NOW)["complete"])

    def test_backfill_rejoins_every_byte_boundary(self):
        data = b"".join(json.dumps(event(str(i), 20-i)).encode()+b"\n" for i in range(6))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/"log.jsonl"
            path.write_bytes(data)
            for tail in [1, 31, 110, 240]:
                value = frequency.RunFrequency()
                start = len(data)-tail
                value.seed_tail(start, data[start:], NOW)
                for line in data[start:].split(b"\n")[1:]:
                    value._line(line, "thread", NOW)
                while not value.complete:
                    self.assertLessEqual(value.backfill(path, "thread", NOW, 37), 37)
                self.assertEqual(value.snapshot(NOW)["run_count"], 6)
                self.assertTrue(value.snapshot(NOW)["complete"])

    def test_malformed_history_is_marked_partial(self):
        value = frequency.RunFrequency(complete=True)
        value.observe(event("valid"), "thread", NOW)
        value._line(b"malformed", "thread", NOW)
        self.assertFalse(value.snapshot(NOW)["complete"])


class ObserverFrequencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root/"sessions"/"rollout.jsonl"
        self.path.parent.mkdir()
        with closing(sqlite3.connect(self.root/"state_5.sqlite")) as db, db:
            db.execute("CREATE TABLE threads(id TEXT, rollout_path TEXT, archived INTEGER)")
            db.execute("INSERT INTO threads VALUES(?,?,0)", ("thread",str(self.path)))
        self.path.write_bytes(b"")
        self.observer = LocalRuntimeObserver(self.root, clock=lambda: NOW)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, records):
        self.path.write_text("".join(json.dumps(record)+"\n" for record in records))

    def test_historical_runs_survive_repeated_refresh_and_restart(self):
        self.write([event(str(i), 30-i) for i in range(20)])
        for observer in [self.observer, LocalRuntimeObserver(self.root, clock=lambda: NOW)]:
            observer.refresh(["thread"])
            observer.refresh(["thread"])
            self.assertEqual(observer.frequency_snapshot("thread")["run_count"], 20)

    def test_budgeted_backfill_and_partial_counts_eventually_complete(self):
        self.write([event(str(i), 40-i) for i in range(30)])
        with patch("twin_shell.runtime_observer.READ_LIMIT", 256), patch("twin_shell.runtime_observer.BACKFILL_BUDGET", 128):
            self.observer.refresh(["thread"])
            self.assertFalse(self.observer.frequency_snapshot("thread")["complete"])
            for _ in range(100):
                self.observer.refresh(["thread"])
            data = self.observer.frequency_snapshot("thread")
            self.assertEqual(data["run_count"], 30)
            self.assertTrue(data["complete"])

    def test_historical_read_budget_is_shared_and_rotates_between_threads(self):
        paths = []
        for i in range(5):
            path = self.path.parent/f"rollout-{i}.jsonl"
            path.write_text("".join(json.dumps(event(f"{i}-{j}", 100-j))+"\n" for j in range(60)))
            paths.append(path)
        with closing(sqlite3.connect(self.root/"state_5.sqlite")) as db, db:
            db.executemany("INSERT INTO threads VALUES(?,?,0)",
                           [(f"thread-{i}", str(path)) for i,path in enumerate(paths)])
        reads = []
        backfill = frequency.RunFrequency.backfill

        def record_read(instance, path, thread_id, now, budget):
            size = backfill(instance, path, thread_id, now, budget)
            reads.append((thread_id, size))
            return size

        with patch("twin_shell.runtime_observer.READ_LIMIT", 256), \
             patch("twin_shell.runtime_observer.BACKFILL_BUDGET", 80), \
             patch.object(frequency.RunFrequency, "backfill", record_read):
            for _ in range(5):
                before = len(reads)
                self.observer.refresh([f"thread-{i}" for i in range(5)])
                self.assertLessEqual(sum(size for _,size in reads[before:]), 80)
        self.assertEqual({thread_id for thread_id,size in reads if size},
                         {f"thread-{i}" for i in range(5)})

    def test_db_failure_and_missing_file_are_unavailable(self):
        self.write([event("a")])
        self.observer.refresh(["thread"])
        self.path.unlink()
        self.observer.refresh(["thread"])
        self.assertFalse(self.observer.frequency_snapshot("thread")["available"])
        with patch("twin_shell.runtime_observer.sqlite3.connect", side_effect=sqlite3.OperationalError):
            self.observer.refresh(["thread"])
        self.assertIsNone(self.observer.frequency_snapshot("thread")["run_count"])

    def test_replacement_rebuilds_authoritative_counts(self):
        self.write([event("a"),event("b")])
        self.observer.refresh(["thread"])
        self.write([event("new")])
        self.observer.refresh(["thread"])
        self.assertEqual(self.observer.frequency_snapshot("thread")["run_count"], 1)

    def test_opening_conversation_does_not_change_frequency_or_state(self):
        shell = WorkTwinShell(state_path=self.root/"shell.json", client=Mock(running=True))
        shell.client.request.return_value = {"result":{"thread":{"id":"thread"}}}
        before = json.dumps(shell._state,sort_keys=True)
        with patch("twin_shell.orchestrator.open_codex_thread"):
            shell.open_thread("thread")
        self.assertEqual(json.dumps(shell._state,sort_keys=True), before)
        self.assertFalse(shell.state_path.exists())

    def test_obsolete_click_ledger_is_retired_without_rewriting_other_state(self):
        state = self.root/"shell.json"
        state.write_text(json.dumps({"schema_version":2,"settings":{},"tasks":{},"observations":{},"outbox":{},"weekly_harvest":{"count":7},"open_frequency":{"threads":{"thread":[NOW]}}}))
        shell = WorkTwinShell(state_path=state,client=Mock())
        self.assertNotIn("open_frequency",shell._state)
        self.assertEqual(shell._state["weekly_harvest"],{"count":7})


if __name__ == "__main__":
    unittest.main()
