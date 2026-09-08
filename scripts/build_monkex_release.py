"""Build a self-contained observer backend and curated web resources."""
from pathlib import Path
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WEB_FILES = ["index.html", "styles.css", "app.js", "banana-tree.js", "read-play.js", "task-navigation.js",
    "assets/monkey-banana-2026-09-07/banana-tree.png",
    "assets/monkey-banana-2026-09-07/gold-chain-monkey.png",
    "assets/monkey-banana-2026-09-07/pixel-banana-v4-diagonal.png",
    "assets/monkey-banana-2026-09-07/pixel-banana-peel-v1.png",
    "assets/monkey-banana-2026-09-07/pixel-banana-green-v1.png",
    "assets/monkex-coins-2026-09-07/banana-coin-v1.png",
    "assets/monkey-run-2026-09-07/run-atlas.png"]


def main():
    native = ROOT / "desktop_shell/src-tauri"
    output = ROOT / "build/monkex"
    output.mkdir(parents=True, exist_ok=True)
    triple = next(line.split(": ", 1)[1] for line in subprocess.check_output(
        ["rustc", "-vV"], text=True).splitlines() if line.startswith("host:"))
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--name", "monkex-backend", "--paths", str(ROOT), "--exclude-module", "twin_core",
        "--distpath", str(output / "dist"), "--workpath", str(output / "work"),
        "--specpath", str(output), str(ROOT / "scripts/work_twin_shell.py")], check=True)
    suffix = ".exe" if sys.platform == "win32" else ""
    (native / "binaries").mkdir(exist_ok=True)
    shutil.copy2(output / "dist" / ("monkex-backend" + suffix),
                 native / "binaries" / ("monkex-backend-" + triple + suffix))
    resources = native / "release-web"
    for relative in WEB_FILES:
        destination = resources / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "shell" / relative, destination)
    expected = set(WEB_FILES)
    actual = {str(p.relative_to(resources)).replace("\\", "/") for p in resources.rglob("*") if p.is_file()}
    if actual != expected:
        raise SystemExit("Release web folder contains unexpected files; inspect before packaging")
    print(json.dumps({"platform": triple, "web_files": len(actual), "backend": "bundled"}))


if __name__ == "__main__":
    main()
