import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from twin_shell.diagnostics import ConnectionMonitor, PROBES, STATUS_URL, TRACE_URL, parse_official, public_request, runtime_diagnostics
from twin_shell.orchestrator import WorkTwinShell


NOW = 10000


def task(age=2, rate=0, output=0, tool=0):
    return {"id": "demo", "name": "Synthetic task", "status": "running", "latest_turn_id": "current-turn",
            "runtime": {"turn_id": "current-turn", "activity_at": NOW-age, "phase": "tool" if tool else "thinking", "pending_tools": tool},
            "tokens": {"ready": True, "output_ready": True, "tokens_per_min": rate,
                       "output_tokens_per_min": output, "last_report_at": NOW-age, "buckets": [0]*12}}


def state(cards=None, **kw):
    return runtime_diagnostics([task()] if cards is None else cards, feed_at=kw.pop("feed_at", NOW),
                               connected=kw.pop("connected", True), now=NOW, **kw)


def network(general="reachable", openai="reachable", stale=False):
    return {"stale": stale, "checks": [{"id": "general", "state": general}, {"id": "openai", "state": openai}]}


class DiagnosticsTests(unittest.TestCase):
    def test_current_turn_identity_required_for_all_runtime_metadata(self):
        for card_turn, observed_turn in (("new-turn", "old-turn"), ("old-turn", "new-turn"),
                                         ("current-turn", None), (None, "current-turn"), (None, None)):
            with self.subTest(card_turn=card_turn, observed_turn=observed_turn):
                card = task(rate=500, output=100, tool=1)
                card["latest_turn_id"] = card_turn
                card["runtime"].update(turn_id=observed_turn, phase_at=NOW-2, model="prior-model", effort="high")
                result = state([card], network=network())
                row = result["tasks"][0]
                self.assertEqual(result["operational"]["state"], "unknown")
                self.assertEqual((row["signal"], row["phase"], row["pending_tools"]), ("unknown", "unknown", 0))
                for key in ("tokens_per_min", "output_tokens_per_min", "activity_age_seconds", "phase_at",
                            "model", "effort", "last_report_at", "report_age_seconds"):
                    self.assertIsNone(row[key], key)
                self.assertIsNone(result["activity"]["last_activity_at"])
                self.assertIsNone(result["activity"]["total_tokens_per_min"])
                self.assertEqual(result["activity"]["buckets"], [0]*12)

    def test_matching_current_turn_preserves_activity_and_usage(self):
        result = state([task(rate=500, output=100)])
        self.assertEqual(result["operational"]["state"], "active")
        self.assertEqual(result["tasks"][0]["phase"], "thinking")
        self.assertEqual(result["activity"]["total_tokens_per_min"], 500)

    def test_observer_uses_one_atomic_snapshot_and_checks_its_turn(self):
        card = task(rate=500, output=100)
        observer = Mock(spec=["diagnostics_snapshot"])
        observer.diagnostics_snapshot.return_value = (card["runtime"], card["tokens"])
        result = state([card], observer=observer)
        observer.diagnostics_snapshot.assert_called_once_with("demo")
        self.assertEqual(result["operational"]["state"], "active")
        observer.diagnostics_snapshot.return_value = ({**card["runtime"], "turn_id": "old-turn"}, card["tokens"])
        result = state([card], observer=observer)
        self.assertEqual(result["operational"]["state"], "unknown")
        self.assertIsNone(result["tasks"][0]["last_report_at"])
        self.assertIsNone(result["activity"]["total_tokens_per_min"])

    def test_recent_current_failed_turn_is_visible_and_error_dominates_public_success(self):
        for code, expected in (("http_connection_failed", "recent_connection_error"), ("task_error", "recent_task_error"),
                               ("unknown_provider_error", "recent_task_error")):
            failed = task()
            failed.update(status="failed", latest_turn_id="current-turn", runtime_issue={
                "state": "error", "code": code, "at": NOW-20, "turn_id": "current-turn", "message": "private"})
            result = state([failed, task()], network=network())
            self.assertEqual(result["running_tasks"], 1)
            self.assertEqual(len(result["recent_issues"]), 1)
            self.assertEqual((result["operational"]["state"], result["operational"]["level"], result["operational"]["code"]),
                             ("error", "error", expected))
            self.assertEqual(result["operational"]["issue_tasks"], 1)
            self.assertEqual(result["assessment"]["code"], expected)
            self.assertNotIn("private", str(result))

    def test_terminal_errors_require_current_turn_and_bounded_timestamp(self):
        for issue_turn, at, card_status, observer_turn in (("old-turn", NOW-2, "failed", None),
                                                        ("current-turn", NOW-301, "failed", None),
                                                        ("current-turn", NOW+1, "failed", None),
                                                        ("current-turn", NOW-2, "running", None),
                                                        ("current-turn", NOW-2, "failed", "new-turn")):
            failed = task()
            failed.update(status=card_status, latest_turn_id="current-turn", runtime_issue={
                "state": "error", "code": "http_connection_failed", "at": at, "turn_id": issue_turn})
            if observer_turn:
                failed["runtime"]["turn_id"] = observer_turn
            result = state([failed])
            self.assertEqual(result["recent_issues"], [])
            self.assertNotEqual(result["operational"]["state"], "error")

    def test_failed_turn_can_use_matching_observer_issue_and_stale_feed_masks_it(self):
        failed = task()
        failed.update(status="failed", latest_turn_id="current-turn")
        failed["runtime"].update(turn_id="current-turn", runtime_issue={
            "state": "error", "code": "task_error", "at": NOW-2, "turn_id": "current-turn"})
        self.assertEqual(len(state([failed])["recent_issues"]), 1)
        stale = state([failed], feed_at=NOW-31)
        self.assertEqual(stale["recent_issues"], [])
        self.assertEqual(stale["operational"]["state"], "unknown")

    def test_sync_pending_running_card_stays_counted_as_unknown(self):
        pending = task(rate=500, output=100)
        pending.update(status="unknown", last_observed_status="running", sync_pending=True)
        result = state([pending, task()])
        self.assertEqual(result["running_tasks"], 2)
        self.assertEqual(result["operational"]["unknown_tasks"], 1)
        self.assertEqual(result["operational"]["state"], "unknown")
        pending_row = next(row for row in result["tasks"] if row["sync_pending"])
        self.assertEqual(pending_row["signal"], "unknown")
        self.assertIsNone(pending_row["tokens_per_min"])
        self.assertEqual(pending_row["token_signal"], "sync_unavailable")

    def test_running_sync_pending_contract_masks_even_readable_observer_activity(self):
        pending = task(rate=500, output=100)
        pending.update(sync_pending=True, runtime_observation_available=False)
        result = state([pending])
        self.assertEqual(result["running_tasks"], 1)
        self.assertEqual(result["operational"]["state"], "unknown")
        self.assertEqual(result["operational"]["level"], "unknown")
        self.assertTrue(result["tasks"][0]["sync_pending"])
        self.assertEqual(result["tasks"][0]["signal"], "unknown")
        self.assertIsNone(result["activity"]["total_tokens_per_min"])
        self.assertIsNone(result["activity"]["last_activity_at"])
        self.assertEqual(result["tasks"][0]["token_signal"], "sync_unavailable")

    def test_public_connectivity_cannot_make_quiet_runtime_healthy(self):
        result = state([task(age=900), task()], network=network())
        operational = result["operational"]
        self.assertEqual((operational["state"], operational["level"]), ("quiet", "notice"))
        self.assertEqual(operational["affected_tasks"], 1)
        self.assertEqual(operational["active_tasks"], 1)
        self.assertEqual(operational["score_scope"], "public_path")
        self.assertNotIn("value", operational)
        self.assertEqual(result["assessment"]["level"], "notice")

    def test_pending_tool_distinguishes_recent_activity_from_unconfirmed_long_wait(self):
        recent = state([task(tool=1)])["operational"]
        self.assertEqual((recent["state"], recent["level"], recent["code"]), ("tool_running", "ok", "tool_running"))
        waiting = state([task(age=900, tool=1)], network=network())
        self.assertEqual((waiting["operational"]["state"], waiting["operational"]["level"], waiting["operational"]["code"]),
                         ("tool_running", "notice", "tool_wait"))
        self.assertEqual(waiting["tasks"][0]["token_signal"], "tool_wait")
        self.assertNotIn("network_failure", waiting["operational"]["evidence"])
        self.assertEqual(waiting["assessment"]["level"], "notice")

    def test_unknown_task_evidence_prevents_all_tasks_healthy_claim(self):
        unknown = task()
        unknown["runtime"], unknown["tokens"] = {}, {}
        result = state([task(), unknown])
        self.assertEqual((result["operational"]["state"], result["operational"]["level"]), ("unknown", "unknown"))
        self.assertEqual(result["operational"]["unknown_tasks"], 1)
        self.assertEqual(result["assessment"]["level"], "unknown")
        stale = state([task()], feed_at=NOW-31)
        self.assertEqual(stale["operational"]["code"], "sync_unavailable")

    def test_unavailable_observer_masks_old_token_rates_and_activity(self):
        unavailable = task(rate=1000, output=100)
        unavailable["runtime"]["observation_available"] = False
        result = state([unavailable])
        self.assertEqual(result["operational"]["state"], "unknown")
        self.assertIsNone(result["activity"]["total_tokens_per_min"])
        self.assertIsNone(result["activity"]["last_activity_at"])
        self.assertEqual(result["tasks"][0]["token_signal"], "sync_unavailable")

    def test_turn_start_alone_is_waiting_for_response_not_proof_of_work(self):
        starting = task()
        starting["runtime"]["phase"] = "starting"
        result = state([starting, task()])
        self.assertEqual((result["operational"]["state"], result["operational"]["code"]), ("waiting", "awaiting_response"))
        self.assertEqual(result["operational"]["level"], "notice")
        self.assertEqual(result["operational"]["affected_tasks"], 1)

    def test_zero_tokens_explain_reports_without_claiming_network_failure(self):
        thinking = state([task()])
        self.assertEqual(thinking["tasks"][0]["token_signal"], "thinking")
        silent = state([task(age=600)])
        self.assertEqual(silent["tasks"][0]["token_signal"], "no_recent_usage_report")
        self.assertEqual(silent["operational"]["state"], "quiet")
        missing = task()
        missing["tokens"] = {}
        self.assertEqual(state([missing])["tasks"][0]["token_signal"], "awaiting_report")

    def test_zero_tokens_with_recent_tool_is_activity(self):
        result = state([task(tool=1)])
        self.assertEqual(result["assessment"]["code"], "active")
        self.assertEqual(result["activity"]["tool_tasks"], 1)
        self.assertEqual(result["activity"]["output_tokens_per_min"], 0)

    def test_quiet_task_stays_visible_when_another_is_active(self):
        result = state([task(age=600), task(rate=95100, output=131)])
        self.assertEqual(result["assessment"]["code"], "quiet")
        self.assertEqual(result["activity"]["quiet_tasks"], 1)
        self.assertEqual(result["activity"]["total_tokens_per_min"], 95100)
        self.assertEqual(result["activity"]["output_tokens_per_min"], 131)

    def test_stale_and_disconnected_data_never_claim_activity(self):
        for kwargs in ({"feed_at": NOW-31}, {"connected": False}, {"feed_at": 0}):
            result = state(**kwargs)
            self.assertEqual(result["assessment"]["code"], "sync_unavailable")
            self.assertIsNone(result["activity"]["output_tokens_per_min"])
            self.assertEqual(result["tasks"][0]["signal"], "unknown")

    def test_missing_report_is_unknown_not_zero(self):
        card = task()
        card["tokens"] = {}
        result = state([card])
        self.assertEqual(result["activity"]["output_measured_tasks"], 0)
        self.assertIsNone(result["activity"]["output_tokens_per_min"])

    def test_path_classification_keeps_reference_failure_separate(self):
        for general, openai, expected in [("timeout", "timeout", "network_unavailable"),
                                         ("reachable", "tls_error", "openai_path"),
                                         ("timeout", "reachable", "reference_path"),
                                         ("reachable", "slow", "connection_slow")]:
            self.assertEqual(state(network=network(general, openai))["assessment"]["code"], expected)
        self.assertEqual(state(network=network("timeout", "timeout", stale=True))["assessment"]["code"], "active")

    def test_official_incident_preserves_active_task(self):
        result = state(official={"state": "degraded", "stale": False})
        self.assertEqual(result["assessment"]["code"], "service_notice")
        self.assertEqual(result["activity"]["state"], "active")

    def test_http_restrictions_prove_connectivity_and_do_not_claim_network_failure(self):
        for general, openai in [("reachable", "http_error"), ("http_error", "http_error")]:
            result = state(network=network(general, openai))
            self.assertEqual(result["assessment"]["code"], "endpoint_response")
            self.assertEqual(result["assessment"]["level"], "notice")

    def test_status_schema_missing_incident_components_and_unrelated_degradation(self):
        body = {"components": [{"name": "Codex in ChatGPT Desktop", "status": "operational"},
                               {"name": "Images", "status": "major_outage"}],
                "incidents": [{"name": "Regional issue", "status": "monitoring"}],
                "page": {"updated_at": "2026-10-22T02:00:00Z"}}
        result = parse_official(body, NOW)
        self.assertEqual(result["state"], "operational")
        self.assertEqual(len(result["incidents"]), 1)
        self.assertEqual(result["updated_at"], body["page"]["updated_at"])
        self.assertEqual(parse_official({"components": []}, NOW)["state"], "unknown")
        self.assertEqual(parse_official(None, NOW)["state"], "unknown")
        self.assertEqual(parse_official({"components": [{"name": "Codex", "status": "new_schema"}]}, NOW)["state"], "unknown")

    def test_fixture_shell_diagnostics_uses_memory_without_external_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Mock(running=True)
            shell = WorkTwinShell(state_path=Path(directory)/"state.json", client=client)
            shell._feed_snapshot = {"threads": []}
            shell._feed_at = NOW
            with patch("twin_shell.diagnostics.time.time", return_value=NOW):
                result = shell.diagnostics(check=True)
            client.request.assert_not_called()
            self.assertEqual(result["assessment"]["code"], "idle")
            self.assertIsNone(shell.connection_monitor)


class PublicTraceTests(unittest.TestCase):
    def trace_response(self, body):
        response = io.BytesIO(body)
        response.status = 200
        response.read = Mock(wraps=response.read)
        with patch("twin_shell.diagnostics.build_opener") as opener:
            opener.return_value.open.return_value = response
            result = public_request(TRACE_URL, trace_body=True)
        opener.return_value.open.assert_called_once()
        response.read.assert_called_once_with(4097)
        return result

    def test_public_trace_keeps_only_strict_codes_and_salted_identity(self):
        for address in ("203.0.113.8", "2001:db8::9"):
            with self.subTest(address=address):
                result = self.trace_response(f"ip={address}\nloc=JP\ncolo=NRT\nh=private-host\nurl=https://private.test\n".encode())
                self.assertEqual((result["country_code"], result["edge_code"]), ("JP", "NRT"))
                self.assertRegex(result["route_fingerprint"], r"^[0-9a-f]{64}$")
                self.assertNotIn(address, str(result))
                self.assertNotIn("private", str(result))
                self.assertEqual(set(result), {"state", "latency_ms", "http_status", "route_fingerprint", "country_code", "edge_code"})

    def test_invalid_ip_missing_ip_and_oversized_trace_expose_no_metadata(self):
        for body in (b"loc=JP\ncolo=NRT\n", b"ip=invalid\nloc=JP\ncolo=NRT\n",
                     b"ip=https://private.test\nloc=JP\ncolo=NRT\n",
                     b"ip=203.0.113.8\nloc=JP\ncolo=NRT\n" + b"x" * 4097,
                     b"ip=203.0.113.8\nip=203.0.113.9\nloc=JP\ncolo=NRT\n"):
            with self.subTest(body=body[:40]):
                result = self.trace_response(body)
                self.assertNotIn("route_fingerprint", result)
                self.assertNotIn("country_code", result)
                self.assertNotIn("edge_code", result)

    def test_trace_codes_require_exact_uppercase_ascii_lengths(self):
        for country, edge in (("jp", "nrt"), ("JPN", "NR"), (" JP", "NRT "),
                              ("J1", "NR1"), ("日本", "東京駅"), ("JP<script>", "NRT<script>")):
            with self.subTest(country=country, edge=edge):
                result = self.trace_response(f"ip=203.0.113.8\nloc={country}\ncolo={edge}\n".encode())
                self.assertIsNone(result["country_code"])
                self.assertIsNone(result["edge_code"])
                self.assertIn("route_fingerprint", result)
        result = self.trace_response(b"ip=203.0.113.8\nloc=US\n")
        self.assertEqual(result["country_code"], "US")
        self.assertIsNone(result["edge_code"])


class MonitorTests(unittest.TestCase):
    def test_expected_auth_rejections_are_healthy_and_exit_change_clears_old_samples(self):
        node = ["exit-a"]
        def request(url, **kwargs):
            if kwargs.get("trace_body"):
                return {"state": "reachable", "http_status": 200, "route_fingerprint": node[0]}
            statuses = {PROBES["codex"]: 405, PROBES["api"]: 401}
            code = statuses.get(url, 200)
            return {"state": "http_error" if code in {401,405} else "reachable", "latency_ms": 450,
                    "http_status": code, "body": {"components": []}}
        monitor = ConnectionMonitor(clock=lambda: NOW, request=request)
        for _ in range(3):
            monitor._run()
        self.assertEqual(len(monitor._history), 9)
        self.assertTrue(all(row["expected_response"] for row in monitor._history))
        self.assertEqual(monitor.snapshot()[0]["checks"][1]["state"], "reachable")
        node[0] = "exit-b"
        monitor._run()
        self.assertEqual(len(monitor._history), 3)
        self.assertEqual(monitor.snapshot()[0]["route_generation"], 2)
        self.assertNotIn("exit-b", str(monitor.snapshot()))

    def test_missing_exit_check_reports_unconfirmed_until_next_observation(self):
        node = ["exit-a"]
        def request(url, **kwargs):
            if kwargs.get("trace_body"):
                return {"state": "reachable", "route_fingerprint": node[0]} if node[0] else {"state": "timeout"}
            return {"state": "reachable", "latency_ms": 100, "http_status": 200}
        monitor = ConnectionMonitor(clock=lambda: NOW, request=request)
        monitor._run()
        self.assertTrue(monitor.snapshot()[0]["exit_observed"])
        node[0] = None
        monitor._run()
        self.assertFalse(monitor.snapshot()[0]["exit_observed"])
        # An unknown exit cannot establish a route change. A later observed
        # change clears all previous route samples before storing this round.
        node[0] = "exit-b"
        monitor._run()
        self.assertTrue(monitor.snapshot()[0]["exit_observed"])
        self.assertEqual(len(monitor._history), 3)
        self.assertEqual(monitor.snapshot()[0]["route_generation"], 2)

    def test_fixed_destinations_failure_unknown_and_expiry(self):
        now = [NOW]
        seen = []
        def request(url, **kwargs):
            seen.append(url)
            return {"state": "reachable", "latency_ms": 90, "http_status": 200,
                    "body": {"components": [{"name": "Codex", "status": "operational"}]}}
        monitor = ConnectionMonitor(clock=lambda: now[0], request=request)
        monitor._run()
        current, official = monitor.snapshot()
        self.assertEqual(set(seen), {*PROBES.values(), STATUS_URL, TRACE_URL})
        self.assertFalse(current["stale"])
        self.assertEqual(official["state"], "operational")
        now[0] += 301
        self.assertTrue(monitor.snapshot()[0]["stale"])
        self.assertTrue(monitor.snapshot()[1]["stale"])

    def test_cooldown_inflight_close_and_nonblocking(self):
        now = [NOW]
        gate, entered = threading.Event(), threading.Event()
        def request(url, **kwargs):
            entered.set()
            gate.wait(2)
            return {"state": "timeout", "latency_ms": None, "http_status": None}
        monitor = ConnectionMonitor(clock=lambda: now[0], request=request)
        self.assertTrue(monitor.request_check(force=True))
        self.assertTrue(entered.wait(1))
        self.assertTrue(monitor.snapshot()[0]["checking"])
        self.assertFalse(monitor.request_check(force=True))
        monitor.close()
        gate.set()
        now[0] += 1000
        self.assertFalse(monitor.request_check(force=True))

    def test_latency_baseline_and_failure_streak(self):
        latency, status = [100], ["reachable"]
        monitor = ConnectionMonitor(clock=lambda: NOW, request=lambda url, **kw: {
            "state": status[0], "latency_ms": latency[0], "http_status": 200})
        for _ in range(3):
            monitor._run()
        latency[0] = 1500
        monitor._run()
        check = monitor.snapshot()[0]["checks"][0]
        self.assertEqual(check["baseline_ms"], 100)
        self.assertEqual(check["state"], "slow")
        status[0] = "timeout"
        monitor._run()
        monitor._run()
        self.assertEqual(monitor.snapshot()[0]["checks"][0]["failure_streak"], 2)

    def test_slow_dns_finishes_ui_check_without_accumulating_workers(self):
        gate = threading.Event()
        def request(url, **kwargs):
            gate.wait(2)
            return {"state": "reachable", "latency_ms": 100, "http_status": 200}
        monitor = ConnectionMonitor(clock=lambda: NOW, request=request)
        try:
            with patch("twin_shell.diagnostics.CYCLE_TIMEOUT", 0.01):
                monitor._run()
            current, official = monitor.snapshot()
            self.assertFalse(current["checking"])
            self.assertTrue(current["blocked"])
            self.assertEqual(current["checks"][0]["state"], "timeout")
            self.assertEqual(official["state"], "unknown")
            self.assertFalse(monitor.request_check(force=True))
        finally:
            gate.set()
            for worker in monitor._pending_workers:
                worker.join(1)
        self.assertFalse(monitor.snapshot()[0]["blocked"])

    def test_exit_metadata_follows_observation_expiry_missing_trace_and_route_change(self):
        now = [NOW]
        trace = [{"state": "reachable", "route_fingerprint": "exit-a", "country_code": "JP", "edge_code": "NRT"}]
        seen = []
        def request(url, **kwargs):
            seen.append(url)
            return trace[0] if kwargs.get("trace_body") else {"state": "reachable", "latency_ms": 100, "http_status": 200}
        monitor = ConnectionMonitor(clock=lambda: now[0], request=request)
        self.assertEqual(monitor.snapshot()[0]["exit"], {
            "state": "unknown", "country_code": None, "edge_code": None, "checked_at": None})
        monitor._round()
        observed = monitor.snapshot()[0]
        self.assertEqual(observed["exit"], {"state": "observed", "country_code": "JP", "edge_code": "NRT", "checked_at": NOW})
        self.assertNotIn("exit-a", str(observed))
        observed["exit"]["country_code"] = "XX"
        self.assertEqual(monitor.snapshot()[0]["exit"]["country_code"], "JP")
        self.assertEqual(seen.count(TRACE_URL), 1)
        self.assertEqual(set(seen), {*PROBES.values(), STATUS_URL, TRACE_URL})
        now[0] += 301
        self.assertEqual(monitor.snapshot()[0]["exit"], {
            "state": "stale", "country_code": None, "edge_code": None, "checked_at": NOW})
        self.assertFalse(monitor.snapshot()[0]["exit_observed"])
        trace[0] = {"state": "timeout"}
        monitor._round()
        self.assertEqual(monitor.snapshot()[0]["exit"], {
            "state": "unknown", "country_code": None, "edge_code": None, "checked_at": now[0]})
        trace[0] = {"state": "reachable", "route_fingerprint": "exit-b", "country_code": "US", "edge_code": "LAX"}
        monitor._round()
        self.assertEqual(monitor.snapshot()[0]["exit"]["country_code"], "US")
        self.assertEqual(monitor.snapshot()[0]["route_generation"], 2)
        self.assertEqual(len(monitor._history), 3)

    def test_manual_reset_immediately_clears_exit(self):
        def request(url, **kwargs):
            return {"state": "reachable", "latency_ms": 100, "http_status": 200,
                    "route_fingerprint": "exit-a", "country_code": "JP", "edge_code": "NRT"} if kwargs.get("trace_body") else {
                        "state": "reachable", "latency_ms": 100, "http_status": 200}
        monitor = ConnectionMonitor(clock=lambda: NOW, request=request)
        monitor._round()
        self.assertEqual(monitor.snapshot()[0]["exit"]["state"], "observed")
        with patch.object(threading.Thread, "start"):
            self.assertTrue(monitor.request_check(force=True, reset=True))
        reset = monitor.snapshot()[0]
        self.assertEqual(reset["exit"], {"state": "unknown", "country_code": None, "edge_code": None, "checked_at": None})
        self.assertNotIn("vpn", reset)
        self.assertFalse(reset["exit_observed"])
        self.assertEqual(len(monitor._history), 0)
        monitor.close()

    def test_invalid_trace_after_observed_exit_clears_all_old_labels(self):
        body = [b"ip=203.0.113.8\nloc=JP\ncolo=NRT\n"]
        def request(url, **kwargs):
            if kwargs.get("trace_body"):
                response = io.BytesIO(body[0])
                response.status = 200
                with patch("twin_shell.diagnostics.build_opener") as opener:
                    opener.return_value.open.return_value = response
                    return public_request(url, trace_body=True)
            return {"state": "reachable", "latency_ms": 100, "http_status": 200}
        monitor = ConnectionMonitor(clock=lambda: NOW, request=request)
        monitor._round()
        self.assertEqual(monitor.snapshot()[0]["exit"]["country_code"], "JP")
        body[0] = b"ip=invalid\nloc=US\ncolo=LAX\n"
        monitor._round()
        self.assertEqual(monitor.snapshot()[0]["exit"], {
            "state": "unknown", "country_code": None, "edge_code": None, "checked_at": NOW})
        self.assertFalse(monitor.snapshot()[0]["exit_observed"])

if __name__ == "__main__":
    unittest.main()
