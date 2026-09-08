#!/usr/bin/env python3
from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import queue
import signal
import sys
import threading
from typing import Any
from urllib.parse import unquote, urlparse
import webbrowser


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from twin_shell import AppServerError, WorkTwinShell, WorkTwinShellError  # noqa: E402


STATIC_ROOT = Path(os.environ.get("MONKEX_STATIC_ROOT", str(ROOT / "shell"))).resolve()
MAX_BODY_BYTES = 2 * 1024 * 1024


class ShellRequestHandler(BaseHTTPRequestHandler):
    server: "ShellHTTPServer"

    def do_HEAD(self) -> None:  # noqa: N802
        if not self._local_request():
            return
        path = urlparse(self.path).path
        relative = "index.html" if path in {"", "/"} else path.lstrip("/")
        if relative.startswith("shell/"):
            relative = relative.removeprefix("shell/")
        candidate = (STATIC_ROOT / unquote(relative)).resolve()
        try:
            candidate.relative_to(STATIC_ROOT.resolve())
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(candidate.stat().st_size))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if not self._local_request():
            return
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                self._json(self.server.shell.health())
            elif path == "/api/threads":
                self._json(self.server.shell.list_threads())
            elif path == "/api/events":
                self._events()
            else:
                self._static(path)
        except (WorkTwinShellError, AppServerError) as error:
            self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            self._json(
                {"error": "本机工作分身服务发生内部错误"},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def do_POST(self) -> None:  # noqa: N802
        if not self._local_request(write=True):
            return
        path = urlparse(self.path).path
        try:
            payload = self._body()
            if path == "/api/refresh":
                self._json(self.server.shell.refresh_dashboard())
            elif path.startswith("/api/threads/") and path.endswith("/ack"):
                thread_id = unquote(path.removeprefix("/api/threads/").removesuffix("/ack")).strip("/")
                self._json(self.server.shell.acknowledge_result(thread_id, str(payload.get("version") or "")))
            elif path.startswith("/api/threads/") and path.endswith("/open"):
                thread_id = unquote(path.removeprefix("/api/threads/").removesuffix("/open")).strip("/")
                self._json(self.server.shell.open_thread(thread_id))
            else:
                self._json({"error": "接口不存在"}, status=HTTPStatus.NOT_FOUND)
        except (WorkTwinShellError, AppServerError, ValueError) as error:
            self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            self._json(
                {"error": "本机工作分身服务发生内部错误"},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def log_message(self, format: str, *args: Any) -> None:
        if self.server.verbose:
            super().log_message(format, *args)

    def _local_request(self, *, write: bool = False) -> bool:
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if host not in allowed or (origin and origin not in {f"http://{h}" for h in allowed}):
            self._json({"error": "仅接受本机工作分身窗口的请求"}, status=HTTPStatus.FORBIDDEN)
            return False
        if write and (self.headers.get("X-Work-Twin") != "1" or not self.headers.get("Content-Type", "").startswith("application/json")):
            self._json({"error": "请求来源校验失败"}, status=HTTPStatus.FORBIDDEN)
            return False
        return True

    def _body(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length") or "0"
        try:
            length = int(raw_length)
        except ValueError as error:
            raise WorkTwinShellError("请求长度无效") from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise WorkTwinShellError("请求内容过大")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise WorkTwinShellError("请求 JSON 无效") from error
        if not isinstance(value, dict):
            raise WorkTwinShellError("请求必须是 JSON 对象")
        return value

    def _json(self, value: Any, *, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path: str) -> None:
        relative = "index.html" if path in {"", "/"} else path.lstrip("/")
        if relative.startswith("shell/"):
            relative = relative.removeprefix("shell/")
        candidate = (STATIC_ROOT / unquote(relative)).resolve()
        try:
            candidate.relative_to(STATIC_ROOT.resolve())
        except ValueError:
            self._json({"error": "资源路径无效"}, status=HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            self._json({"error": "资源不存在"}, status=HTTPStatus.NOT_FOUND)
            return
        body = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") or content_type == "application/javascript" else content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _events(self) -> None:
        subscriber = self.server.shell.events.subscribe()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.write(b"event: ready\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = subscriber.get(timeout=20)
                    event_name = str(event.get("type") or "message")
                    data = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                    packet = f"event: {event_name}\ndata: {data}\n\n".encode("utf-8")
                except queue.Empty:
                    packet = b": keep-alive\n\n"
                self.wfile.write(packet)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            self.server.shell.events.unsubscribe(subscriber)


class ShellHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        shell: WorkTwinShell,
        *,
        verbose: bool = False,
    ) -> None:
        super().__init__(address, ShellRequestHandler)
        self.shell = shell
        self.verbose = verbose


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="启动本机 Codex 工作分身壳子")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--open", action="store_true", dest="open_browser")
    parser.add_argument("--verbose", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("工作分身壳子当前只允许绑定本机回环地址")
    shell = WorkTwinShell()
    shell.start()
    server = ShellHTTPServer((args.host, args.port), shell, verbose=args.verbose)

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    url = f"http://{args.host}:{args.port}/"
    print(json.dumps({"status": "ready", "url": url}, ensure_ascii=False), flush=True)
    if args.open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        shell.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
