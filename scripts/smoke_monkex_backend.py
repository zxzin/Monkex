"""Exercise the packaged backend with an empty user state and absent Codex."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("web", type=Path)
    args = parser.parse_args()
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="monkex-clean-user-") as temporary:
        env = dict(os.environ, MONKEX_CODEX_PATH=str(Path(temporary) / "missing-codex"),
                   MONKEX_DATA_DIR=temporary, MONKEX_STATIC_ROOT=str(args.web.resolve()))
        process = subprocess.Popen([str(args.binary.resolve()), "--port", str(port)], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(600):
                if process.poll() is not None:
                    raise AssertionError("Packaged backend exited: " + process.stderr.read().decode("utf-8", "replace")[-2000:])
                try:
                    health = json.load(urllib.request.urlopen(base + "/api/health", timeout=1))
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(.1)
            else:
                raise AssertionError("Packaged backend did not start")
            assert health["app_server"] == "offline"
            assert health["shell_task_count"] == 0
            assert b"Monkex" in urllib.request.urlopen(base).read()
            feed = json.load(urllib.request.urlopen(base + "/api/threads"))
            assert feed["threads"] == [] and feed.get("error")
            request = urllib.request.Request(base + "/api/threads", headers={"Origin": "https://untrusted.example"})
            try:
                urllib.request.urlopen(request)
                raise AssertionError("Foreign origin accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 403
            try:
                urllib.request.urlopen(base + "/shell/assets/monkey-banana-2026-09-07/index.html")
                raise AssertionError("Private prototype was packaged")
            except urllib.error.HTTPError as error:
                assert error.code == 404
            print("PASS: packaged backend, isolated empty state, missing-Codex guidance, static UI, origin rejection, prototype exclusion")
        finally:
            if os.name == "nt":
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            process.stderr.close()


if __name__ == "__main__":
    main()
