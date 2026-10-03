"""OS boundaries for the distributable Monkex observer; no shell command strings."""
from __future__ import annotations

import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys


WINDOWS_CODEX_VERSION = re.compile(r"^[0-9a-fA-F]{8,64}$")


def data_directory() -> Path:
    override = os.environ.get("MONKEX_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))) / "Monkex"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Monkex"
    return Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "monkex"


def codex_executable() -> Path:
    explicit = os.environ.get("MONKEX_CODEX_PATH")
    if explicit:
        return Path(explicit).expanduser()
    candidates = []
    if sys.platform != "win32":
        located = shutil.which("codex")
        if located:
            return Path(located)
    if sys.platform == "darwin":
        bundles = _unique_paths(_macos_registered_apps() + [
            Path("/Applications/ChatGPT.app"), Path("/Applications/Codex.app"),
            Path.home() / "Applications/ChatGPT.app", Path.home() / "Applications/Codex.app",
        ])
        for bundle in bundles:
            known = [bundle / relative for relative in (
                "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
                "Contents/Resources/codex",
            )]
            # Preserve the system's app priority; choose the newest CLI within that app.
            for path in _newest_first(_unique_paths(known + _macos_resource_candidates(bundle))):
                if path.is_file():
                    return path
    if sys.platform == "win32":
        located = shutil.which("codex.exe")
        if located:
            candidates.append(Path(located))
        candidates += _windows_codex_candidates()
    return next((p for p in candidates if p.is_file()), Path("__monkex_codex_not_found__"))


def _macos_registered_apps() -> list[Path]:
    """Find the active Codex app through LaunchServices, independent of its name/location."""
    import ctypes

    try:
        cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        ls = ctypes.CDLL("/System/Library/Frameworks/CoreServices.framework/CoreServices")
        pointer = ctypes.c_void_p
        signatures = [
            (cf.CFStringCreateWithCString, [pointer, ctypes.c_char_p, ctypes.c_uint32], pointer),
            (cf.CFURLCreateWithString, [pointer, pointer, pointer], pointer),
            (cf.CFURLCopyFileSystemPath, [pointer, ctypes.c_int], pointer),
            (cf.CFStringGetLength, [pointer], ctypes.c_long),
            (cf.CFStringGetMaximumSizeForEncoding, [ctypes.c_long, ctypes.c_uint32], ctypes.c_long),
            (cf.CFStringGetCString, [pointer, pointer, ctypes.c_long, ctypes.c_uint32], ctypes.c_bool),
            (cf.CFArrayGetCount, [pointer], ctypes.c_long),
            (cf.CFArrayGetValueAtIndex, [pointer, ctypes.c_long], pointer),
            (cf.CFRelease, [pointer], None),
            (ls.LSCopyDefaultApplicationURLForURL, [pointer, ctypes.c_uint32, pointer], pointer),
            (ls.LSCopyApplicationURLsForBundleIdentifier, [pointer, pointer], pointer),
        ]
        for function, arguments, result in signatures:
            function.argtypes, function.restype = arguments, result
    except (OSError, AttributeError):
        return []

    owned = []
    utf8 = 0x08000100

    def retain(value):
        if value:
            owned.append(value)
        return value

    def string(value: str):
        return retain(cf.CFStringCreateWithCString(None, value.encode("utf-8"), utf8))

    def path_for_url(url) -> Path | None:
        if not url:
            return None
        value = retain(cf.CFURLCopyFileSystemPath(url, 0))
        if not value:
            return None
        size = cf.CFStringGetMaximumSizeForEncoding(cf.CFStringGetLength(value), utf8) + 1
        buffer = ctypes.create_string_buffer(size)
        return Path(buffer.value.decode("utf-8")) if cf.CFStringGetCString(value, buffer, size, utf8) else None

    paths = []
    try:
        uri_string = string("codex://threads/monkex-discovery")
        uri = retain(cf.CFURLCreateWithString(None, uri_string, None)) if uri_string else None
        default = retain(ls.LSCopyDefaultApplicationURLForURL(uri, 0xFFFFFFFF, None)) if uri else None
        default_path = path_for_url(default)
        if default_path:
            try:
                with (default_path / "Contents/Info.plist").open("rb") as stream:
                    identity = plistlib.load(stream).get("CFBundleIdentifier")
                if identity == "com.openai.codex":
                    paths.append(default_path)
            except (OSError, ValueError, AttributeError, plistlib.InvalidFileException):
                pass
        identity_string = string("com.openai.codex")
        apps = retain(ls.LSCopyApplicationURLsForBundleIdentifier(identity_string, None)) if identity_string else None
        if apps:
            for index in range(min(cf.CFArrayGetCount(apps), 128)):
                path = path_for_url(cf.CFArrayGetValueAtIndex(apps, index))
                if path:
                    paths.append(path)
        return _unique_paths(paths)
    finally:
        for value in reversed(owned):
            cf.CFRelease(value)


def _macos_resource_candidates(bundle: Path) -> list[Path]:
    """Bounded search for the exact executable name inside a recognized app's resources."""
    resources = bundle / "Contents/Resources"
    candidates = []
    try:
        root = resources.resolve()
        for visited, (directory, folders, files) in enumerate(os.walk(resources, followlinks=False)):
            if visited >= 4096:
                break
            current = Path(directory)
            if len(current.relative_to(resources).parts) >= 8:
                folders.clear()
            if "codex" in files:
                executable = current / "codex"
                if executable.resolve().is_relative_to(root) and executable.is_file() and os.access(executable, os.X_OK):
                    candidates.append(executable)
    except (OSError, ValueError, RuntimeError):
        pass
    return candidates


def _windows_codex_candidates() -> list[Path]:
    home_local = Path.home() / "AppData/Local"
    local_roots = _unique_paths([
        Path(os.environ.get("LOCALAPPDATA", str(home_local))),
        home_local,
    ])
    candidates: list[Path] = []
    for local in local_roots:
        codex_bin = local / "OpenAI/Codex/bin"
        candidates.append(codex_bin / "codex.exe")
        candidates += _newest_first(
            path for path in _safe_glob(codex_bin, "*/codex.exe")
            if WINDOWS_CODEX_VERSION.fullmatch(path.parent.name)
        )
        candidates.append(local / "Programs/Codex/resources/codex.exe")

    program_files = Path(os.environ.get("ProgramFiles", "C:/Program Files"))
    windows_apps = program_files / "WindowsApps"
    candidates += _newest_first(
        path for path in _safe_glob(
            windows_apps,
            "OpenAI.Codex_*__2p2nqsd0c76g0/app/resources/codex.exe",
        )
    )
    return _unique_paths(candidates)


def _safe_glob(root: Path, pattern: str) -> list[Path]:
    try:
        return list(root.glob(pattern))
    except OSError:
        return []


def _newest_first(paths) -> list[Path]:
    def freshness(path: Path) -> tuple[int, int, str]:
        try:
            return path.stat().st_mtime_ns, path.parent.stat().st_mtime_ns, str(path)
        except OSError:
            return -1, -1, str(path)

    return sorted(paths, key=freshness, reverse=True)


def _unique_paths(paths) -> list[Path]:
    result = []
    seen = set()
    for path in paths:
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def process_options() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def open_codex_thread(thread_id: str) -> None:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", thread_id):
        raise ValueError("Invalid task ID")
    uri = "codex://threads/" + thread_id
    if sys.platform == "win32":
        os.startfile(uri)
    elif sys.platform == "darwin":
        subprocess.run(["open", uri], check=True, timeout=5)
    else:
        subprocess.run(["xdg-open", uri], check=True, timeout=5)
