import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from twin_shell import platform_support as platform
from twin_shell.app_server import AppServerClient


class PlatformTests(unittest.TestCase):
    def test_explicit_codex_path(self):
        with patch.dict(os.environ, {"MONKEX_CODEX_PATH": "/test/Codex executable"}):
            self.assertEqual(platform.codex_executable(), Path("/test/Codex executable"))

    def test_windows_data_root(self):
        with patch.object(platform.sys, "platform", "win32"), patch.dict(os.environ, {"LOCALAPPDATA": "/local", "MONKEX_DATA_DIR": ""}):
            self.assertEqual(platform.data_directory(), Path("/local/Monkex"))

    def test_windows_uri_uses_shell_association_without_command_string(self):
        with patch.object(platform.sys, "platform", "win32"), patch.object(os, "startfile", create=True) as launch:
            platform.open_codex_thread("abc-123")
            launch.assert_called_once_with("codex://threads/abc-123")
            with self.assertRaises(ValueError):
                platform.open_codex_thread("abc & calc.exe")

    def test_macos_uri(self):
        with patch.object(platform.sys, "platform", "darwin"), patch.object(platform.subprocess, "run") as launch:
            platform.open_codex_thread("abc-123")
            launch.assert_called_once_with(["open", "codex://threads/abc-123"], check=True, timeout=5)

    def test_no_training_package_imported(self):
        import sys
        self.assertNotIn("twin_core", sys.modules)


if __name__ == "__main__":
    unittest.main()
