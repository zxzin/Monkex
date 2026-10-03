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

    def test_windows_finds_latest_versioned_codex_without_path_injection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            older = root / "OpenAI/Codex/bin/11111111/codex.exe"
            latest = root / "OpenAI/Codex/bin/22222222/codex.exe"
            older.parent.mkdir(parents=True)
            latest.parent.mkdir(parents=True)
            older.write_bytes(b"older")
            latest.write_bytes(b"latest")
            os.utime(older, (1, 1))
            os.utime(latest, (2, 2))
            with (
                patch.object(platform.sys, "platform", "win32"),
                patch.object(platform.shutil, "which", return_value=None),
                patch.object(platform.Path, "home", return_value=root / "Home"),
                patch.dict(os.environ, {
                    "LOCALAPPDATA": str(root),
                    "ProgramFiles": str(root / "Program Files"),
                    "MONKEX_CODEX_PATH": "",
                }),
            ):
                self.assertEqual(platform.codex_executable(), latest)

    def test_windows_ignores_unrelated_dynamic_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            unrelated = root / "OpenAI/Codex/bin/not-a-version/codex.exe"
            unrelated.parent.mkdir(parents=True)
            unrelated.write_bytes(b"unrelated")
            with (
                patch.object(platform.sys, "platform", "win32"),
                patch.object(platform.shutil, "which", return_value=None),
                patch.object(platform.Path, "home", return_value=root / "Home"),
                patch.dict(os.environ, {
                    "LOCALAPPDATA": str(root),
                    "ProgramFiles": str(root / "Program Files"),
                    "MONKEX_CODEX_PATH": "",
                }),
            ):
                self.assertEqual(platform.codex_executable(), Path("__monkex_codex_not_found__"))

    def test_windows_falls_back_to_msix_codex_resource(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packaged = root / "Program Files/WindowsApps/OpenAI.Codex_1.2.3.0_x64__2p2nqsd0c76g0/app/resources/codex.exe"
            packaged.parent.mkdir(parents=True)
            packaged.write_bytes(b"packaged")
            with (
                patch.object(platform.sys, "platform", "win32"),
                patch.object(platform.shutil, "which", return_value=None),
                patch.object(platform.Path, "home", return_value=root / "Home"),
                patch.dict(os.environ, {
                    "LOCALAPPDATA": str(root / "Local"),
                    "ProgramFiles": str(root / "Program Files"),
                    "MONKEX_CODEX_PATH": "",
                }),
            ):
                self.assertEqual(platform.codex_executable(), packaged)

    def test_macos_still_uses_codex_from_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "codex"
            executable.write_bytes(b"codex")
            with (
                patch.object(platform.sys, "platform", "darwin"),
                patch.object(platform.shutil, "which", return_value=str(executable)),
                patch.dict(os.environ, {"MONKEX_CODEX_PATH": ""}),
            ):
                self.assertEqual(platform.codex_executable(), executable)

    def test_macos_finds_embedded_cli_without_finder_path_injection(self):
        for bundle in (
            Path("/Applications/ChatGPT.app"),
            Path("/Applications/Codex.app"),
            Path("/test/Home/Applications/ChatGPT.app"),
            Path("/test/Home/Applications/Codex.app"),
        ):
            executable = bundle / "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
            with (
                self.subTest(bundle=bundle),
                patch.object(platform.sys, "platform", "darwin"),
                patch.object(platform.shutil, "which", return_value=None),
                patch.object(platform, "_macos_registered_apps", return_value=[]),
                patch.object(platform.Path, "home", return_value=Path("/test/Home")),
                patch.object(platform.Path, "is_file", autospec=True, side_effect=lambda path: path == executable),
                patch.dict(os.environ, {"MONKEX_CODEX_PATH": ""}),
            ):
                self.assertEqual(platform.codex_executable(), executable)

    def test_macos_preserves_legacy_bundle_layout(self):
        executable = Path("/Applications/Codex.app/Contents/Resources/codex")
        with (
            patch.object(platform.sys, "platform", "darwin"),
            patch.object(platform.shutil, "which", return_value=None),
            patch.object(platform, "_macos_registered_apps", return_value=[]),
            patch.object(platform.Path, "is_file", autospec=True, side_effect=lambda path: path == executable),
            patch.dict(os.environ, {"MONKEX_CODEX_PATH": ""}),
        ):
            self.assertEqual(platform.codex_executable(), executable)

    def test_macos_finds_registered_renamed_app_with_future_resource_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "External Apps/My Coding Assistant.app"
            executable = bundle / "Contents/Resources/runtime/v-next/tools/codex"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"fixture")
            executable.chmod(0o755)
            with (
                patch.object(platform.sys, "platform", "darwin"),
                patch.object(platform.shutil, "which", return_value=None),
                patch.object(platform, "_macos_registered_apps", return_value=[bundle]),
                patch.object(platform.Path, "home", return_value=root / "Home"),
                patch.dict(os.environ, {"MONKEX_CODEX_PATH": ""}),
            ):
                self.assertEqual(platform.codex_executable(), executable)

    def test_macos_prefers_registered_default_over_newer_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundles = [root / "Current.app", root / "Backup.app"]
            executables = []
            for index, bundle in enumerate(bundles):
                executable = bundle / "Contents/Resources/future/codex"
                executable.parent.mkdir(parents=True)
                executable.write_bytes(b"fixture")
                executable.chmod(0o755)
                os.utime(executable, (index + 1, index + 1))
                executables.append(executable)
            with (
                patch.object(platform.sys, "platform", "darwin"),
                patch.object(platform.shutil, "which", return_value=None),
                patch.object(platform, "_macos_registered_apps", return_value=bundles),
                patch.dict(os.environ, {"MONKEX_CODEX_PATH": ""}),
            ):
                self.assertEqual(platform.codex_executable(), executables[0])

    def test_macos_rescans_versioned_resources_after_update(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary) / "Current.app"
            older = bundle / "Contents/Resources/runtime/v1/codex"
            newer = bundle / "Contents/Resources/runtime/v2/codex"
            older.parent.mkdir(parents=True)
            older.write_bytes(b"fixture")
            older.chmod(0o755)
            os.utime(older, (1, 1))
            with (
                patch.object(platform.sys, "platform", "darwin"),
                patch.object(platform.shutil, "which", return_value=None),
                patch.object(platform, "_macos_registered_apps", return_value=[bundle]),
                patch.dict(os.environ, {"MONKEX_CODEX_PATH": ""}),
            ):
                self.assertEqual(platform.codex_executable(), older)
                newer.parent.mkdir(parents=True)
                newer.write_bytes(b"fixture")
                newer.chmod(0o755)
                os.utime(newer, (2, 2))
                self.assertEqual(platform.codex_executable(), newer)

    @unittest.skipIf(os.name == "nt", "macOS executable bits and symlinks")
    def test_macos_resource_search_excludes_helpers_and_external_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "Current.app"
            resources = bundle / "Contents/Resources"
            resources.mkdir(parents=True)
            helper = resources / "codex-code-mode-host"
            helper.touch()
            helper.chmod(0o755)
            external = root / "outside-codex"
            external.touch()
            external.chmod(0o755)
            (resources / "codex").symlink_to(external)
            not_executable = resources / "docs/codex"
            not_executable.parent.mkdir()
            not_executable.touch()
            not_executable.chmod(0o644)
            self.assertEqual(platform._macos_resource_candidates(bundle), [])

    def test_macos_resource_search_has_depth_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary) / "Current.app"
            deep = bundle / "Contents/Resources" / "/".join(["nested"] * 9) / "codex"
            deep.parent.mkdir(parents=True)
            deep.touch()
            deep.chmod(0o755)
            self.assertEqual(platform._macos_resource_candidates(bundle), [])

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
