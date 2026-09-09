"""OS boundaries for the distributable Monkex observer; no shell command strings."""
from __future__ import annotations

import os
from pathlib import Path
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
    if sys.platform == "darwin":
        candidates += [Path(p) / "Contents/Resources/codex" for p in (
            "/Applications/ChatGPT.app", "/Applications/Codex.app",
            str(Path.home() / "Applications/ChatGPT.app"), str(Path.home() / "Applications/Codex.app"))]
    if sys.platform == "win32":
        located = shutil.which("codex.exe")
        if located:
            candidates.append(Path(located))
        candidates += _windows_codex_candidates()
    else:
        located = shutil.which("codex")
        if located:
            candidates.append(Path(located))
    return next((p for p in candidates if p.is_file()), Path("__monkex_codex_not_found__"))


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
