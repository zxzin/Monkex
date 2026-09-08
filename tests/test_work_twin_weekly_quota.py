import unittest
from twin_shell.weekly_quota import weekly_quota


def bucket(used=62, duration=10080):
    return {"limitId": "codex", "primary": {"usedPercent": used, "windowDurationMins": duration, "resetsAt": 12345}}


class WeeklyQuotaTests(unittest.TestCase):
    def test_transport_failure_retries_after_five_seconds(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import Mock
        from twin_shell.orchestrator import WorkTwinShell
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=Mock(running=True))
            shell._refresh_usage = Mock(return_value={"refresh_pending": True})
            shell._stop_event = Mock()
            shell._stop_event.is_set.return_value = False
            shell._stop_event.wait.return_value = True
            shell._usage_loop()
            shell._stop_event.wait.assert_called_once_with(5.0)

    def test_timeout_preserves_fresh_observation_and_retries_without_redating(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import Mock, patch
        from twin_shell.orchestrator import WorkTwinShell
        client = Mock(running=True)
        client.request.side_effect = [{"result": {"rateLimits": bucket(13)}}, TimeoutError(), {"error": {"code": -32603}},
                                      TimeoutError(), {"result": {"rateLimits": bucket(14)}},
                                      {"result": {"rateLimits": bucket(14, 300)}}]
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=client)
            with patch('time.time', return_value=100):
                self.assertEqual(shell._refresh_usage()['weekly']['remaining_percent'], 87)
            with patch('time.time', return_value=140):
                weekly = shell._refresh_usage()['weekly']
                self.assertEqual(weekly['remaining_percent'], 87)
                self.assertEqual(weekly['observed_at'], 100)
                self.assertTrue(weekly['refresh_pending'])
            with patch('time.time', return_value=150):
                self.assertEqual(shell._refresh_usage()['weekly']['remaining_percent'], 87)
            with patch('time.time', return_value=191):
                self.assertFalse(shell._refresh_usage()['weekly']['available'])
            with patch('time.time', return_value=192):
                self.assertEqual(shell._refresh_usage()['weekly']['remaining_percent'], 86)
                self.assertFalse(shell._refresh_usage()['weekly']['available'], 'authoritative missing weekly window clears previous account data')

    def test_manual_refresh_reads_quota_and_returns_board_without_task_actions(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import Mock
        from twin_shell.orchestrator import WorkTwinShell
        client = Mock(running=True)
        client.request.return_value = {"result": {"rateLimits": bucket(8)}}
        with tempfile.TemporaryDirectory() as temporary:
            shell = WorkTwinShell(state_path=Path(temporary) / "state.json", client=client)
            shell._feed_thread = object()
            shell._feed_snapshot = {"threads": [{"id": "example", "unread": True}]}
            result = shell.refresh_dashboard()
            self.assertEqual(result["health"]["usage"]["weekly"]["remaining_percent"], 92)
            self.assertTrue(result["threads"][0]["unread"])
            client.request.assert_called_once_with("account/rateLimits/read", None)
            self.assertFalse(shell.state_path.exists())

    def test_remaining_is_one_hundred_minus_used(self):
        value = weekly_quota({"result": {"rateLimits": bucket()}}, now=100)
        self.assertEqual(value["remaining_percent"], 38)
        self.assertEqual(value["observed_at"], 100)
        self.assertEqual(value["resets_at"], 12345)

    def test_named_codex_bucket_wins_over_legacy_and_other_models(self):
        value = weekly_quota({"result": {"rateLimits": bucket(1), "rateLimitsByLimitId": {
            "codex_bengalfox": bucket(0), "codex": bucket(82)}}})
        self.assertEqual(value["remaining_percent"], 18)

    def test_weekly_secondary_is_found_by_duration(self):
        limits = bucket(80, 300)
        limits["secondary"] = bucket(10)["primary"]
        self.assertEqual(weekly_quota({"result": {"rateLimits": limits}})["remaining_percent"], 90)

    def test_unknown_never_becomes_full_or_zero(self):
        for response in ({}, {"error": {"message": "offline"}},
                         {"result": {"rateLimits": bucket(40, 300)}},
                         {"result": {"rateLimits": bucket(None)}},
                         {"result": {"rateLimits": bucket(float("nan"))}},
                         {"result": {"rateLimits": {**bucket(), "limitId": {}}}},
                         {"result": {"rateLimits": bucket(), "rateLimitsByLimitId": {"codex": None}}},
                         {"result": {"rateLimitsByLimitId": {"codex_bengalfox": bucket()}}}):
            self.assertIsNone(weekly_quota(response)["remaining_percent"])

    def test_percent_is_bounded(self):
        self.assertEqual(weekly_quota({"result": {"rateLimits": bucket(140)}})["remaining_percent"], 0)
        self.assertEqual(weekly_quota({"result": {"rateLimits": bucket(-4)}})["remaining_percent"], 100)
