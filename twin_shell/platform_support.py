"""OS boundaries for the distributable Monkex observer; no shell command strings."""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


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
    elif sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
        candidates += [local / "OpenAI/Codex/bin/codex.exe",
                       local / "Programs/Codex/resources/codex.exe"]
    located = shutil.which("codex.exe" if sys.platform == "win32" else "codex")
    if located:
        candidates.append(Path(located))
    return next((p for p in candidates if p.is_file()), Path("__monkex_codex_not_found__"))


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
