import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from twin_shell.orchestrator import WorkTwinShell
from twin_shell.weekly_quota import quota_details


def available_card(expiry, **overrides):
    return {"id": "private-card-id", "resetType": "codexRateLimits", "status": "available",
            "expiresAt": expiry, "title": "Private title", **overrides}


def usage_response(balance="12345.6789000000", count=3, cards=None):
    return {"result": {"accountId": "private-account-id", "rateLimits": {
        "limitId": "codex", "primary": {"windowDurationMins": 300, "usedPercent": 0, "resetsAt": 500},
        "secondary": {"windowDurationMins": 10080, "usedPercent": 35, "resetsAt": 1000},
        "credits": {"hasCredits": True, "unlimited": False, "balance": balance}},
        "rateLimitResetCredits": {"availableCount": count, "credits": cards}}}


class QuotaDetailsTests(unittest.TestCase):
    def test_live_contract_returns_exact_balance_two_windows_and_grouped_expiry(self):
        response = usage_response(cards=[available_card(800), available_card(None), available_card(800)])
        details = quota_details(response, now=100)
        self.assertEqual(details["credit_balance"], {"available": True, "balance": "12345.6789000000", "unlimited": False})
        self.assertEqual(details["windows"], [
            {"window_minutes": 300, "remaining_percent": 100, "resets_at": 500},
            {"window_minutes": 10080, "remaining_percent": 65, "resets_at": 1000}])
        self.assertEqual(details["reset_cards"], {"available": True, "available_count": 3,
            "expirations": [{"count": 2, "expires_at": 800}, {"count": 1, "expires_at": None}], "unlisted_count": 0})
        self.assertEqual(details["observed_at"], 100)
        self.assertNotIn("private", str(details))

    def test_core_bucket_wins_and_invalid_core_does_not_fall_back(self):
        response = usage_response()
        response["result"]["rateLimitsByLimitId"] = {"codex": {
            "limitId": "codex", "credits": {"balance": "12.5"},
            "primary": {"windowDurationMins": 10080, "usedPercent": 90, "resetsAt": 700}},
            "codex_other": {"credits": {"balance": "999"}}}
        details = quota_details(response)
        self.assertEqual(details["credit_balance"]["balance"], "12.5")
        self.assertEqual(details["windows"][0]["remaining_percent"], 10)
        response["result"]["rateLimitsByLimitId"]["codex"] = None
        self.assertFalse(quota_details(response)["credit_balance"]["available"])
        self.assertEqual(quota_details(response)["windows"], [])

    def test_capped_list_and_count_only_remain_distinct_from_zero(self):
        details = quota_details(usage_response(count=7, cards=[available_card(800)]))
        self.assertEqual(details["reset_cards"]["available_count"], 7)
        self.assertEqual(details["reset_cards"]["unlisted_count"], 6)
        count_only = quota_details(usage_response(count=3))["reset_cards"]
        self.assertEqual(count_only["available_count"], 3)
        self.assertEqual(count_only["expirations"], [])
        self.assertEqual(count_only["unlisted_count"], 3)
        zero = quota_details(usage_response(balance="0", count=0, cards=[]))
        self.assertTrue(zero["credit_balance"]["available"])
        self.assertEqual(zero["credit_balance"]["balance"], "0")
        self.assertTrue(zero["reset_cards"]["available"])
        self.assertEqual(zero["reset_cards"]["available_count"], 0)
        unknown = quota_details({"result": {}})
        self.assertFalse(unknown["reset_cards"]["available"])
        self.assertIsNone(unknown["reset_cards"]["available_count"])

    def test_invalid_and_non_available_card_rows_do_not_invent_expiry(self):
        cards = [available_card(800, status="redeemed"), available_card(800, resetType="unknown"),
                 available_card(True), available_card(-1), available_card(float("nan")),
                 available_card(float("inf")), available_card(10**30),
                 {"status": "available", "resetType": "codexRateLimits"}, available_card(None)]
        reset = quota_details(usage_response(count=4, cards=cards))["reset_cards"]
        self.assertEqual(reset["expirations"], [{"count": 1, "expires_at": None}])
        self.assertEqual(reset["unlisted_count"], 3)
        self.assertEqual(quota_details(usage_response(count=0, cards=[available_card(800)]))["reset_cards"]["expirations"], [])

    def test_malformed_balance_count_windows_and_dates_stay_unavailable(self):
        for balance in (None, True, -1, 0, "-1", "NaN", "Infinity", "1e100", "1,000", " 3", ""):
            with self.subTest(balance=balance):
                self.assertFalse(quota_details(usage_response(balance=balance))["credit_balance"]["available"])
        for count in (None, True, -1, 1.5, "3", float("nan"), float("inf"), 10**30):
            with self.subTest(count=count):
                self.assertFalse(quota_details(usage_response(count=count))["reset_cards"]["available"])
        for used in (True, -1, 101, float("nan"), float("inf"), "5"):
            with self.subTest(used=used):
                response = usage_response()
                response["result"]["rateLimits"]["primary"]["usedPercent"] = used
                self.assertEqual(len(quota_details(response)["windows"]), 1)
        for reset in (True, -1, float("nan"), float("inf"), 10**30):
            with self.subTest(reset=reset):
                response = usage_response()
                response["result"]["rateLimits"]["primary"]["resetsAt"] = reset
                self.assertIsNone(quota_details(response)["windows"][0]["resets_at"])

    def test_unlimited_is_explicit_and_does_not_invent_a_balance(self):
        response = usage_response(balance=None)
        response["result"]["rateLimits"]["credits"]["unlimited"] = True
        self.assertEqual(quota_details(response)["credit_balance"], {"available": True, "unlimited": True, "balance": None})


class QuotaDetailsRefreshTests(unittest.TestCase):
    def test_failure_retains_original_timestamp_then_expires_and_success_clears_fields(self):
        client = Mock(running=True)
        client.request.side_effect = [usage_response(cards=[available_card(800)]), TimeoutError(),
                                      {"error": {"code": -32603}}, {"result": {}}]
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=client)
            with patch("time.time", return_value=100):
                self.assertEqual(shell._refresh_usage()["details"]["observed_at"], 100)
            with patch("time.time", return_value=140):
                details = shell._refresh_usage()["details"]
                self.assertEqual(details["observed_at"], 100)
                self.assertEqual(details["credit_balance"]["balance"], "12345.6789000000")
                self.assertTrue(details["refresh_pending"])
            with patch("time.time", return_value=191):
                details = shell._refresh_usage()["details"]
                self.assertFalse(details["credit_balance"]["available"])
                self.assertFalse(details["reset_cards"]["available"])
                self.assertEqual(details["windows"], [])
            with patch("time.time", return_value=192):
                details = shell._refresh_usage()["details"]
                self.assertFalse(details["refresh_pending"])
                self.assertFalse(details["credit_balance"]["available"])
                self.assertEqual(details["observed_at"], 192)
            client.request.assert_called_with("account/rateLimits/read", None)
            self.assertFalse(shell.state_path.exists())

    def test_successful_missing_fields_replaces_fresh_old_account_data(self):
        client = Mock(running=True)
        client.request.side_effect = [usage_response(), {"result": {"rateLimits": {"limitId": "codex"}}}]
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=client)
            shell._refresh_usage()
            details = shell._refresh_usage()["details"]
            self.assertFalse(details["credit_balance"]["available"])
            self.assertFalse(details["reset_cards"]["available"])
            self.assertEqual(details["windows"], [])

    def test_manual_account_refresh_clears_old_details_even_if_new_account_read_fails(self):
        client = Mock(running=True)
        client.request.side_effect = [usage_response(), TimeoutError()]
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=client)
            shell._refresh_usage()
            shell._feed_thread = object()
            shell.feed.collect = Mock(return_value={"threads": []})
            result = shell.refresh_dashboard()
            details = result["health"]["usage"]["details"]
            self.assertFalse(details["credit_balance"]["available"])
            self.assertFalse(details["reset_cards"]["available"])
            self.assertEqual(details["windows"], [])
            client.close.assert_called_once_with()
            client.start.assert_called_once_with()

    def test_cached_quota_window_disappears_after_its_reset_time(self):
        client = Mock(running=True)
        response = usage_response()
        response["result"]["rateLimits"]["primary"]["resetsAt"] = 120
        client.request.side_effect = [response, TimeoutError()]
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=client)
            with patch("time.time", return_value=100):
                shell._refresh_usage()
            with patch("time.time", return_value=140):
                details = shell._refresh_usage()["details"]
                self.assertEqual([window["window_minutes"] for window in details["windows"]], [10080])
                self.assertTrue(details["credit_balance"]["available"])


if __name__ == "__main__":
    unittest.main()
