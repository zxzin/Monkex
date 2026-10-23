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

    def test_input_and_output_are_separate_without_cached_or_reasoning_double_count(self):
        meter = TokenMeter()
        meter.record(100, {"total_token_usage": {"total_tokens": 1000, "input_tokens": 800,
            "cached_input_tokens": 700, "output_tokens": 200, "reasoning_output_tokens": 50}})
        meter.record(110, {"total_token_usage": {"total_tokens": 1600, "input_tokens": 1300,
            "cached_input_tokens": 1100, "output_tokens": 300, "reasoning_output_tokens": 100}})
        measured = meter.snapshot(120)
        self.assertTrue(measured["input_ready"] and measured["output_ready"])
        self.assertEqual(measured["recent_input_tokens"], 500)
        self.assertEqual(measured["recent_output_tokens"], 100)
        self.assertEqual(measured["input_tokens_per_min"], 1500)
        self.assertEqual(measured["output_tokens_per_min"], 300)

    def test_missing_output_is_unknown_and_restoration_establishes_fresh_baseline(self):
        meter = TokenMeter()
        self.record(meter, 100, 1000)
        self.record(meter, 110, 1600)
        self.assertEqual(meter.snapshot(110)["output_tokens_per_min"], 0)
        meter.record(120, {"total_token_usage": {"total_tokens": 1700, "input_tokens": 1600}})
        missing = meter.snapshot(120)
        self.assertTrue(missing["ready"] and missing["input_ready"])
        self.assertFalse(missing["output_ready"])
        self.assertIsNone(missing["output_tokens_per_min"])
        self.assertIsNone(missing["recent_output_tokens"])
        meter.record(130, {"total_token_usage": {"total_tokens": 1800, "output_tokens": 100}})
        self.assertFalse(meter.snapshot(130)["output_ready"])
        meter.record(140, {"total_token_usage": {"total_tokens": 1900, "output_tokens": 110}})
        self.assertEqual(meter.snapshot(140)["recent_output_tokens"], 10)

    def test_sparse_output_reports_expose_zero_and_original_report_timestamp(self):
        meter = TokenMeter()
        meter.record(100, {"total_token_usage": {"total_tokens": 1000, "output_tokens": 100}})
        meter.record(110, {"total_token_usage": {"total_tokens": 1100, "output_tokens": 200}})
        stale = meter.snapshot(200)
        self.assertTrue(stale["output_ready"])
        self.assertEqual(stale["output_tokens_per_min"], 0)
        self.assertEqual(stale["last_report_at"], 110)

    def test_reset_rebaselines_all_components_and_invalid_components_remain_unknown(self):
        meter = TokenMeter()
        self.record(meter, 100, 1000)
        self.record(meter, 110, 1600)
        meter.record(120, {"total_token_usage": {"total_tokens": 100, "input_tokens": 90, "output_tokens": 10}})
        reset = meter.snapshot(120)
        self.assertFalse(reset["ready"] or reset["input_ready"] or reset["output_ready"])
        meter.record(130, {"total_token_usage": {"total_tokens": 200, "input_tokens": True, "output_tokens": -1}})
        invalid = meter.snapshot(130)
        self.assertTrue(invalid["ready"])
        self.assertIsNone(invalid["input_tokens_per_min"])
        self.assertIsNone(invalid["output_tokens_per_min"])

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
