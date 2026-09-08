from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
from typing import Any, Callable
from .platform_support import codex_executable, process_options


DEFAULT_CODEX_CLI = codex_executable()


class AppServerError(RuntimeError):
    """Raised when the local Codex app-server cannot satisfy a request."""


@dataclass
class _PendingResponse:
    values: queue.Queue[dict[str, Any]]


class AppServerClient:
    """Thread-safe JSONL client for the local Codex app-server protocol."""

    def __init__(
        self,
        codex_cli: Path | None = None,
        *,
        request_timeout_seconds: float = 30.0,
        on_message: Callable[[dict[str, Any]], None] | None = None,
        config_overrides: list[str] | None = None,
    ) -> None:
        self.codex_cli = codex_cli or codex_executable()
        self._start_lock = threading.RLock()
        self.request_timeout_seconds = request_timeout_seconds
        self.on_message = on_message
        self.config_overrides = list(config_overrides or [])
        self._process: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[int, _PendingResponse] = {}
        self._request_id = 0
        self._closed = threading.Event()

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def start(self) -> None:
        with self._start_lock:
            self._start()

    def _start(self) -> None:
        if self.running:
            return
        if not self.codex_cli.is_file():
            self.codex_cli = codex_executable()
        if not self.codex_cli.is_file():
            raise AppServerError("请先安装并登录 Codex；可通过 MONKEX_CODEX_PATH 指定 Codex 可执行文件")
        self._closed.clear()
        command = [str(self.codex_cli), "app-server", "--listen", "stdio://"]
        for override in self.config_overrides:
            command.extend(["-c", override])
        self._process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            **process_options(),
        )
        self._reader = threading.Thread(
            target=self._read_loop,
            name="work-twin-app-server-reader",
            daemon=True,
        )
        self._stderr_reader = threading.Thread(
            target=self._stderr_loop,
            name="work-twin-app-server-stderr",
            daemon=True,
        )
        self._reader.start()
        self._stderr_reader.start()
        response = self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "zinx-work-twin-shell",
                    "title": "Monkex",
                    "version": "0.1.1",
                },
                "capabilities": {"experimentalApi": True},
            },
        )
        if response.get("error") is not None:
            self.close()
            raise AppServerError("Codex App Server 初始化失败")
        self.notify("initialized", {})

    def close(self) -> None:
        self._closed.set()
        process = self._process
        self._process = None
        if process is None:
            return
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        for stream in (process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()
        with self._pending_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for waiter in pending:
            waiter.values.put(
                {"error": {"code": -1, "message": "Codex App Server 已关闭"}}
            )

    def request(
        self,
        method: str,
        params: Any = None,
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        if not self.running and method != "initialize":
            self.start()
        with self._pending_lock:
            self._request_id += 1
            request_id = self._request_id
            waiter = _PendingResponse(queue.Queue(maxsize=1))
            self._pending[request_id] = waiter
        self._send({"id": request_id, "method": method, "params": params})
        try:
            return waiter.values.get(
                timeout=timeout_seconds or self.request_timeout_seconds
            )
        except queue.Empty as error:
            raise AppServerError(f"Codex 请求超时：{method}") from error
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def notify(self, method: str, params: Any = None) -> None:
        self._send({"method": method, "params": params})

    def respond(
        self,
        request_id: int | str,
        *,
        result: Any | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"id": request_id}
        if error is not None:
            payload["error"] = error
        else:
            payload["result"] = result if result is not None else {}
        self._send(payload)

    def _send(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.poll() is not None:
            raise AppServerError("Codex App Server 未运行")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            try:
                process.stdin.write(encoded + "\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError) as error:
                raise AppServerError("Codex App Server 连接已关闭") from error

    def _read_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        while not self._closed.is_set():
            line = process.stdout.readline()
            if not line:
                break
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            request_id = message.get("id")
            if request_id is not None and ("result" in message or "error" in message):
                with self._pending_lock:
                    waiter = self._pending.get(request_id)
                if waiter is not None:
                    waiter.values.put(message)
                    continue
            self._emit(message)
        if not self._closed.is_set():
            self._emit(
                {
                    "method": "shell/appServerDisconnected",
                    "params": {"at": time.time()},
                }
            )

    def _stderr_loop(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        for line in process.stderr:
            if self._closed.is_set():
                break
            text = line.strip()
            if text:
                self._emit(
                    {
                        "method": "shell/appServerDiagnostic",
                        "params": {"message": text[:800]},
                    }
                )

    def _emit(self, message: dict[str, Any]) -> None:
        if self.on_message is None:
            return
        try:
            self.on_message(message)
        except Exception:
            # A client-side rendering failure must not stop the protocol reader.
            return
