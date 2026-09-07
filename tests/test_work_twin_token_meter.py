import unittest

from twin_shell.token_meter import TokenMeter, aggregate_project_tokens


class TokenMeterTests(unittest.TestCase):
    def record(self, meter, at, total):
        meter.record(at, {"total_token_usage": {"total_tokens": total, "input_tokens": total-10, "output_tokens": 10, "reasoning_output_tokens": 5}})

    def test_initial_cumulative_total_is_a_baseline(self):
        meter = TokenMeter()
        self.record(meter, 100, 900000000)
        self.assertIsNone(meter.snapshot(100)["tokens_per_min"])
        self.assertFalse(meter.snapshot(100)["ready"])

    def test_increment_and_observed_window_rate(self):
        meter = TokenMeter()
        self.record(meter, 100, 1000)
        self.record(meter, 110, 1600)
        result = meter.snapshot(120)
        self.assertEqual(result["recent_tokens"], 600)
        self.assertEqual(result["tokens_per_min"], 1800)
        self.assertEqual(sum(result["buckets"]), 600)
        # Total already includes input/output; reasoning must not be added again.

    def test_duplicate_reports_and_reloads_do_not_double_count(self):
        meter = TokenMeter()
        self.record(meter, 100, 1000)
        self.record(meter, 110, 1600)
        self.record(meter, 110, 1600)
        self.record(meter, 120, 1600)
        self.assertEqual(meter.snapshot(120)["recent_tokens"], 600)
        self.assertEqual(meter.snapshot(171)["tokens_per_min"], 0)

    def test_counter_reset_starts_a_new_sample(self):
        meter = TokenMeter()
        for at,total in [(100,1000),(110,2000),(120,50)]: self.record(meter, at, total)
        self.assertIsNone(meter.snapshot(120)["tokens_per_min"])
        self.record(meter,130,100)
        self.assertEqual(meter.snapshot(130)["recent_tokens"],50)

    def test_invalid_and_out_of_order_reports_are_ignored(self):
        meter = TokenMeter()
        self.record(meter,100,1000)
        for at,total in [(99,2000),(110,-1),(110,True),(110,2**64),(110,1.2)]:self.record(meter,at,total)
        meter.record(110,{})
        self.assertEqual(meter.total,1000)
        self.assertEqual(meter.reports,1)

    def test_exact_window_boundary_expires(self):
        meter = TokenMeter()
        self.record(meter,100,1000)
        self.record(meter,110,1600)
        self.assertEqual(meter.snapshot(170)["recent_tokens"],0)

    def test_project_totals_are_scoped_and_partial_is_explicit(self):
        meter = TokenMeter()
        self.record(meter,100,1000)
        self.record(meter,110,1600)
        tokens = meter.snapshot(160)
        cards=[{"id":"a","cwd":"/project-a","status":"running","tokens":tokens},
               {"id":"b","cwd":"/project-a","status":"running","tokens":tokens},
               {"id":"c","cwd":"/project-b","status":"running","tokens":tokens},
               {"id":"d","cwd":"/project-b","status":"running","tokens":{}},
               {"id":"e","cwd":None,"status":"running","tokens":tokens}]
        result=aggregate_project_tokens(cards)
        self.assertEqual(result["/project-a"]["tokens_per_min"],1200)
        self.assertEqual(result["/project-a"]["recent_tokens"],1200)
        self.assertFalse(result["/project-a"]["partial"])
        self.assertEqual(result["/project-b"]["tokens_per_min"],600)
        self.assertTrue(result["/project-b"]["partial"])
        self.assertEqual(len(result),2)


if __name__ == "__main__":
    unittest.main()
