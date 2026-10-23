import copy
import unittest

from twin_shell.health_score import score_runtime_health


NOW = 10000
OFFICIAL = {"stale": False, "components": [{"name": "Codex", "status": "operational"}], "incidents": []}


def samples(rounds=6, latency=400):
    rows = []
    for index in range(rounds):
        for target, status in (("codex", 401 if index % 2 else 405), ("api", 401), ("auth", 200)):
            rows.append({"at": NOW-(rounds-index-1)*3, "round_id": index, "target": target,
                         "state": "http_error" if status != 200 else "reachable", "latency_ms": latency,
                         "http_status": status, "transport_ok": True, "expected_response": True})
    return rows


def score(rows, **kwargs):
    return score_runtime_health(rows, now=kwargs.pop("now", NOW), official=kwargs.pop("official", OFFICIAL),
                                runtime=kwargs.pop("runtime", {"current": True, "active_tasks": 1}), **kwargs)


class HealthScoreTests(unittest.TestCase):
    def test_empty_and_partial_coverage_are_unknown(self):
        for rows in ([], samples(2), [row for row in samples() if row["target"] != "auth"]):
            result = score(rows)
            self.assertIsNone(result["value"])
            self.assertEqual(result["grade"], "collecting")
            self.assertEqual(result["coverage"], "partial")
        auth = score([row for row in samples() if row["target"] != "auth"])["services"][-1]
        self.assertIsNone(auth["success_percent"])

    def test_three_rounds_are_provisional_and_six_over_fifteen_seconds_are_short_check(self):
        early, complete = score(samples(3)), score(samples(6))
        self.assertEqual((early["value"], early["confidence"]), (100, "provisional"))
        self.assertEqual((complete["value"], complete["confidence"]), (100, "short_check"))
        self.assertEqual((complete["round_count"], complete["sample_count"], complete["span_seconds"]), (6, 18, 15))
        self.assertEqual(complete["components"], {"reliability": 60, "latency": 25, "stability": 15})
        simultaneous = samples()
        for row in simultaneous:
            row["at"] = NOW
        self.assertEqual(score(simultaneous)["confidence"], "provisional")

    def test_repeated_records_cannot_increase_confidence_or_hide_first_failed_attempt(self):
        initial = samples(2)
        self.assertEqual(score(initial * 20)["round_count"], 2)
        self.assertIsNone(score(initial * 20)["value"])
        rows = samples(3)
        rows[0].update(expected_response=False, transport_ok=False, latency_ms=None, at=NOW-7)
        retry = dict(rows[0], expected_response=True, transport_ok=True, latency_ms=100, at=NOW)
        self.assertEqual(score(rows + [retry])["sample_count"], 9)
        self.assertLess(score(rows + [retry])["value"], 100)

    def test_expected_401_and_405_prove_unauthenticated_endpoint_response(self):
        result = score(samples())
        self.assertEqual(result["success_percent"], 100)
        self.assertEqual(result["scope"], "public_path")
        self.assertEqual(result["metric"], "public_connection")
        self.assertEqual(result["unit"], "points")
        self.assertFalse(result["authenticated"])
        self.assertTrue(result["codex_observed"])

    def test_visible_success_percent_is_the_empirical_fifty_three_of_sixty(self):
        rows = samples(20)
        for row in [row for row in rows if row["target"] == "codex"][:7]:
            row.update(transport_ok=False, expected_response=False, latency_ms=None)
        result = score(rows)
        self.assertEqual(result["sample_count"], 60)
        self.assertEqual(result["success_percent"], 88.3)
        self.assertEqual(result["weighted_success_percent"], 73.4)
        self.assertEqual(result["components"]["reliability"], 44.04)

    def test_zero_latency_is_measured_and_missing_latency_is_unknown(self):
        self.assertEqual(score(samples(latency=0))["value"], 100)
        rows = samples()
        rows[0]["latency_ms"] = None
        result = score(rows)
        self.assertIsNone(result["value"])
        self.assertIn("missing_latency", result["notes"])

    def test_runtime_staleness_quiet_and_zero_tokens_do_not_deduct_network_points(self):
        expected = score(samples())["value"]
        for runtime in ({"current": False, "active_tasks": 5},
                        {"current": True, "active_tasks": 0, "quiet_tasks": 5, "tokens_per_min": 0}):
            result = score(samples(), runtime=runtime)
            self.assertEqual(result["value"], expected)
            self.assertFalse(result["codex_observed"])
        self.assertIn("runtime_unconfirmed", score(samples(), runtime={"current": False})["notes"])

    def test_probe_staleness_and_expiry_are_unknown_instead_of_zero(self):
        result = score(samples(), now=NOW+181)
        self.assertIsNone(result["value"])
        self.assertEqual(result["grade"], "stale")
        self.assertIn("probe_stale", result["notes"])
        expired = score(samples(), now=NOW+901)
        self.assertIsNone(expired["value"])
        self.assertEqual(expired["sample_count"], 0)

    def test_identical_slow_responses_have_good_stability_and_reduced_latency_score(self):
        values = [score(samples(latency=value)) for value in (100, 500, 1500, 3000, 6000)]
        self.assertEqual([result["value"] for result in values], sorted([result["value"] for result in values], reverse=True))
        self.assertEqual(values[-1]["components"]["stability"], 15)
        self.assertEqual(values[-1]["components"]["latency"], 0)
        self.assertLess(values[-1]["value"], 100)
        self.assertEqual(values[-1]["grade"], "fair")

    def test_twenty_six_of_thirty_codex_successes_lose_to_thirty_even_with_fast_successes(self):
        perfect, unreliable = samples(30), samples(30, latency=100)
        failures = [row for row in unreliable if row["target"] == "codex"][:4]
        for row in failures:
            row.update(transport_ok=False, expected_response=False, latency_ms=None, state="timeout")
        good, bad = score(perfect), score(unreliable)
        self.assertEqual(good["value"], 100)
        self.assertLessEqual(bad["value"], 69)
        self.assertLess(bad["value"], good["value"])
        codex = next(service for service in bad["services"] if service["target"] == "codex")
        self.assertEqual(codex["success_percent"], 86.7)
        self.assertEqual(codex["scoring_p95_ms"], 6000)
        self.assertEqual(codex["p95_ms"], 100)
        self.assertIn("failed_latency_floor", bad["notes"])

    def test_recent_three_codex_failures_cap_score_and_failures_remain_in_latency_scoring(self):
        rows = samples(30)
        for row in [row for row in rows if row["target"] == "codex"][-3:]:
            row.update(transport_ok=False, expected_response=False, latency_ms=None)
        result = score(rows)
        self.assertLessEqual(result["value"], 30)
        self.assertIn("codex_recent_failures", result["notes"])
        self.assertLess(result["components"]["latency"], 25)

    def test_403_429_transport_restriction_differs_from_transport_failure(self):
        for code in (403, 429):
            restricted, offline = samples(), samples()
            for row in restricted:
                if row["target"] == "codex":
                    row.update(http_status=code, expected_response=False)
            for row in offline:
                if row["target"] == "codex":
                    row.update(transport_ok=False, expected_response=False, latency_ms=None, http_status=None)
            response, failure = score(restricted), score(offline)
            self.assertIn("http_restricted", response["notes"])
            self.assertNotIn("service_failures", response["notes"])
            self.assertNotIn("codex_recent_failures", response["notes"])
            self.assertGreater(response["value"], failure["value"])
            self.assertEqual(response["services"][0]["transport_percent"], 100)

    def test_downtime_and_real_zero_score_remain_measured(self):
        rows = samples()
        for row in rows:
            row.update(transport_ok=False, expected_response=False, latency_ms=6000+row["round_id"]*6000)
        result = score(rows)
        self.assertEqual(result["value"], 0)
        self.assertEqual(result["grade"], "poor")
        self.assertEqual(result["success_percent"], 0)

    def test_more_timeouts_cannot_create_a_stability_recovery(self):
        values = []
        for failures in (0, 1, 4, 10, 15, 18, 24, 30):
            rows = samples(30)
            for row in rows:
                if row["round_id"] < failures:
                    row.update(transport_ok=False, expected_response=False, latency_ms=None)
            values.append(score(rows)["value"])
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertEqual(values[-1], 0)

    def test_only_known_direct_codex_status_caps_the_score(self):
        for status, cap in (("degraded_performance", 70), ("partial_outage", 40), ("major_outage", 40)):
            result = score(samples(), official={"stale": False, "components": [{"name": "Codex in ChatGPT Desktop", "status": status}]})
            self.assertEqual(result["value"], cap)
        for official in (None, {"stale": True, "components": [{"name": "Codex", "status": "major_outage"}]},
                         {"stale": False, "components": [{"name": "Codex", "status": "new_schema"}]},
                         {"stale": False, "components": [{"name": "Responses", "status": "major_outage"}], "incidents": [{"name": "Regional incident"}]}):
            self.assertEqual(score(samples(), official=official)["value"], 100)

    def test_desktop_status_takes_precedence_over_codex_web_api_and_generic_status(self):
        other_components = [{"name": "Codex Web", "status": "major_outage"},
                            {"name": "Codex API", "status": "major_outage"},
                            {"name": "Codex", "status": "major_outage"}]
        for desktop_status in ("operational", "new_schema"):
            result = score(samples(), official={"stale": False, "components": [
                {"name": "Codex in ChatGPT Desktop", "status": desktop_status}, *other_components]})
            self.assertEqual(result["value"], 100)
            self.assertIn("official_other_notice", result["notes"])
            self.assertFalse(result["caps"])
        generic = score(samples(), official={"stale": False, "components": other_components})
        self.assertEqual(generic["value"], 40)
        only_web_api = score(samples(), official={"stale": False, "components": other_components[:2]})
        self.assertEqual(only_web_api["value"], 100)
        self.assertIn("official_other_notice", only_web_api["notes"])

    def test_invalid_future_and_nonfinite_records_are_ignored_without_mutating_input(self):
        rows = samples()
        original = copy.deepcopy(rows)
        bad = [dict(rows[0], at=NOW+1), dict(rows[0], at=float("nan")),
               dict(rows[0], target=[]), dict(rows[0], round_id=[]), dict(rows[0], transport_ok=1)]
        self.assertEqual(score(rows+bad)["sample_count"], 18)
        self.assertEqual(rows, original)


if __name__ == "__main__":
    unittest.main()
