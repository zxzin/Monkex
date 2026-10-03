from contextlib import redirect_stdout
import io
import json
import unittest
from unittest.mock import MagicMock, patch

from scripts import check_codex_compatibility as probe
from twin_shell.app_server import AppServerError


class CompatibilityProbeTests(unittest.TestCase):
    def test_checks_required_methods_and_emits_status_only(self):
        client = MagicMock()
        client.request.return_value = {"result": {"private_task": "private-content-sentinel"}}
        output = io.StringIO()
        with patch.object(probe, "AppServerClient", return_value=client), redirect_stdout(output):
            self.assertEqual(probe.main(), 0)
        self.assertEqual([call.args[0] for call in client.request.call_args_list],
                         ["thread/list", "account/rateLimits/read"])
        self.assertNotIn("private-content-sentinel", output.getvalue())
        self.assertEqual(set(json.loads(output.getvalue())["checks"].values()), {"ok"})
        client.close.assert_called_once()

    def test_failed_connection_is_closed_and_reported_without_raw_error(self):
        client = MagicMock()
        client.start.side_effect = AppServerError("private-error-sentinel")
        output = io.StringIO()
        with patch.object(probe, "AppServerClient", return_value=client), redirect_stdout(output):
            self.assertEqual(probe.main(), 1)
        self.assertNotIn("private-error-sentinel", output.getvalue())
        client.request.assert_not_called()
        client.close.assert_called_once()

    def test_missing_quota_is_reported_unavailable(self):
        client = MagicMock()
        client.request.side_effect = [{"result": {}}, {"error": {"code": -1}}]
        output = io.StringIO()
        with patch.object(probe, "AppServerClient", return_value=client), redirect_stdout(output):
            self.assertEqual(probe.main(), 1)
        self.assertEqual(json.loads(output.getvalue())["checks"]["account/rateLimits/read"], "unavailable")
        client.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
