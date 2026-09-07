"""Sign the preview's Python sidecar separately, then seal the outer bundle."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    if sys.platform != "darwin":
        raise SystemExit("macOS only")
    native = ROOT / "desktop_shell/src-tauri"
    app = native / "target/release/bundle/macos/Monkex.app"
    sidecar = app / "Contents/MacOS/monkex-backend"
    if not sidecar.is_file():
        raise SystemExit("Build the complete app first")
    # Only the frozen Python child needs this exception: its ad-hoc embedded
    # libraries have no Developer ID team. Main UI retains library validation.
    # Retire after the interpreter and every extension share the publisher's
    # Developer ID and a signed/notarized cold-launch test passes.
    subprocess.run(["codesign", "--force", "--sign", "-", "--options", "runtime",
                    "--entitlements", str(native / "backend-entitlements.plist"), str(sidecar)], check=True)
    subprocess.run(["codesign", "--force", "--sign", "-", "--options", "runtime", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    subprocess.run([sys.executable, str(ROOT / "scripts/smoke_monkex_backend.py"), str(sidecar),
                    str(app / "Contents/Resources/web")], check=True)


if __name__ == "__main__":
    main()
