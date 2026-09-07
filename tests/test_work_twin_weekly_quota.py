import unittest
from twin_shell.weekly_quota import weekly_quota


def bucket(used=62, duration=10080):
    return {"limitId": "codex", "primary": {"usedPercent": used, "windowDurationMins": duration, "resetsAt": 12345}}


class WeeklyQuotaTests(unittest.TestCase):
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
