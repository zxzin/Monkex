"""Read-only desktop turn evidence; this observer grants no execution authority.

The standalone App Server knows its own live connections. Desktop-owned turns
are observed separately through structured local rollout events. Only IDs,
timestamps and lifecycle state survive parsing, in memory only.
"""
from __future__ import annotations
from contextlib import closing

from dataclasses import dataclass, field
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any

from .token_meter import TokenMeter


READ_LIMIT = 4 * 1024 * 1024
LINE_LIMIT = 2 * 1024 * 1024
RUNTIME_LEASE = 30 * 60
PROGRESS_EVENTS = {"agent_reasoning", "agent_message", "mcp_tool_call_begin", "mcp_tool_call_end", "exec_command_begin", "exec_command_end", "item_started", "item_completed"}
PROGRESS_ITEMS = {"reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"}


@dataclass
class Cursor:
    identity: tuple[str, int, int]
    offset: int = 0
    skipping: bool = False
    pending: bytes = b""
    status: str = "unknown"
    turn_id: str | None = None
    event_at: float = 0
    activity_at: float = 0
    anchored: bool = False
    terminal_ids: set[str] = field(default_factory=set)
    tokens: TokenMeter = field(default_factory=TokenMeter)

    def snapshot(self, now: float) -> dict[str, Any]:
        status = self.status
        if status == "running" and not (-30 <= now - self.activity_at <= RUNTIME_LEASE):
            status = "unknown"
        return {"status": status, "turn_id": self.turn_id, "event_at": self.event_at,
                "anchored": self.anchored, "revision": f"{self.offset}:{status}:{self.turn_id}:{self.event_at}"}


class LocalRuntimeObserver:
    def __init__(self, codex_home: Path, *, clock=time.time) -> None:
        self.root = codex_home.expanduser().resolve()
        self.clock = clock
        self._lock = threading.RLock()
        self._cursors: dict[str, Cursor] = {}
        self._available: set[str] = set()
        self.error = False

    def refresh(self, thread_ids: list[str]) -> None:
        """Resolve metadata read-only and tail changed files with bounded IO."""
        if not thread_ids:
            return
        with self._lock:
            try:
                databases = sorted(self.root.glob("state_[0-9]*.sqlite"), key=lambda p: int(p.stem.split("_")[-1]))
                if not databases:
                    raise OSError("Local state database unavailable")
                with closing(sqlite3.connect(databases[-1].as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
                    paths = {}
                    for start in range(0, len(thread_ids), 400):
                        batch = thread_ids[start:start+400]
                        paths.update(db.execute(f"SELECT id, rollout_path FROM threads WHERE archived=0 AND id IN ({','.join('?' for _ in batch)})", batch))
                self.error = False
            except (OSError, ValueError, sqlite3.Error):
                self.error = True
                self._available.difference_update(thread_ids)
                return
            for thread_id in thread_ids:
                self._available.discard(thread_id)
                path_value = paths.get(thread_id)
                if not path_value:
                    continue
                try:
                    path = Path(path_value).resolve()
                    if not path.is_relative_to(self.root / "sessions"):
                        continue
                    stat = path.stat()
                    identity = (str(path), stat.st_dev, stat.st_ino)
                    cursor = self._cursors.get(thread_id)
                    if not cursor and self.clock() - stat.st_mtime > RUNTIME_LEASE:
                        continue
                    if not cursor or cursor.identity != identity or stat.st_size < cursor.offset:
                        cursor = Cursor(identity)
                        self._cursors[thread_id] = cursor
                    with path.open("rb") as stream:
                        # The end of a long file is sufficient for fresh activity.
                        # Dropped history never supplies an invented start event.
                        start = max(cursor.offset, stat.st_size - READ_LIMIT)
                        if start != cursor.offset:
                            cursor.pending = b""
                            cursor.skipping = True
                            cursor.status, cursor.turn_id, cursor.anchored = "unknown", None, False
                            cursor.tokens = TokenMeter()
                        stream.seek(start)
                        block = stream.read(READ_LIMIT)
                    cursor.offset = start + len(block)
                    self._consume(cursor, block, thread_id)
                    self._available.add(thread_id)
                except (OSError, ValueError):
                    continue

    def _consume(self, cursor: Cursor, block: bytes, thread_id: str) -> None:
        data = cursor.pending + block
        cursor.pending = b""
        lines = data.split(b"\n")
        remainder = lines.pop()
        for line in lines:
            if cursor.skipping:
                cursor.skipping = False
                continue
            if len(line) > LINE_LIMIT:
                continue
            try:
                record = json.loads(line)
                if isinstance(record, dict):
                    self._event(cursor, record, thread_id)
            except (ValueError, TypeError, OverflowError, RecursionError):
                continue
        if len(remainder) > LINE_LIMIT:
            cursor.skipping = True
        else:
            cursor.pending = remainder

    def _event(self, cursor: Cursor, record: dict[str, Any], thread_id: str) -> None:
        envelope = record.get("type")
        if envelope not in {"event_msg", "response_item", "turn_context"}:
            return
        payload = record.get("payload")
        if not isinstance(payload, dict) or payload.get("thread_id", thread_id) != thread_id:
            return
        timestamp = record.get("timestamp")
        if not isinstance(timestamp, str):
            return
        at = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
        if at > self.clock() + 30 or at < cursor.event_at:
            return
        kind = payload.get("type")
        if kind is not None and not isinstance(kind, str):
            return
        if envelope == "event_msg" and kind == "token_count":
            cursor.tokens.record(at, payload.get("info"))
            return
        turn_id = payload.get("turn_id")
        if turn_id is not None and not isinstance(turn_id, str):
            return
        if envelope == "event_msg" and kind == "task_started" and turn_id:
            if turn_id not in cursor.terminal_ids:
                cursor.status, cursor.turn_id, cursor.anchored = "running", turn_id, True
                cursor.activity_at = cursor.event_at = at
            return
        if envelope == "event_msg" and kind in {"task_complete", "turn_aborted"}:
            if turn_id:
                cursor.terminal_ids.add(turn_id)
                if len(cursor.terminal_ids) > 32:
                    cursor.terminal_ids = {turn_id}
            if cursor.turn_id and turn_id and cursor.turn_id != turn_id:
                return
            cursor.status = "interrupted" if kind == "turn_aborted" else "failed" if payload.get("error") else "completed"
            cursor.turn_id = turn_id or cursor.turn_id
            cursor.event_at = at
            return
        # Context associates later legacy activity with a turn without itself
        # proving activity. Quoted events inside message bodies are never read.
        if envelope == "turn_context":
            if turn_id and cursor.status == "unknown":
                cursor.turn_id = turn_id
            return
        progress = (envelope == "event_msg" and kind in PROGRESS_EVENTS) or (envelope == "response_item" and (kind in PROGRESS_ITEMS or (kind == "message" and payload.get("role") == "assistant" and payload.get("phase") == "commentary")))
        if kind in {"item_started", "item_completed"}:
            item = payload.get("item")
            if not isinstance(item, dict) or item.get("type") in {"UserMessage", "userMessage"}:
                progress = False
        if not progress or (turn_id and turn_id in cursor.terminal_ids):
            return
        if cursor.status in {"completed", "failed", "interrupted"}:
            if not turn_id or turn_id == cursor.turn_id:
                return
            cursor.anchored = False
        if turn_id and turn_id != cursor.turn_id:
            cursor.turn_id, cursor.anchored = turn_id, False
        cursor.status = "running"
        cursor.activity_at = cursor.event_at = at

    def snapshot(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            cursor = self._cursors.get(thread_id)
            if thread_id not in self._available or not cursor:
                return {"status": "unknown", "revision": "unavailable", "event_at": 0}
            return cursor.snapshot(self.clock())

    def token_snapshot(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            cursor = self._cursors.get(thread_id)
            if thread_id not in self._available or not cursor:
                return TokenMeter().snapshot(self.clock())
            return cursor.tokens.snapshot(self.clock())


def apply_runtime(card: dict[str, Any], evidence: dict[str, Any]) -> None:
    """Decorate display state while retaining the original control boundary."""
    if card.get("can_send"):
        return
    status = evidence.get("status")
    turn_id = evidence.get("turn_id")
    matches = not turn_id or not card.get("latest_turn_id") or card["latest_turn_id"] == turn_id
    if status == "running":
        # A completed API turn wins over activity with no start or turn anchor.
        if not turn_id and card.get("status") in {"result_ready", "waiting_user"}:
            return
        card.update(status="running", stage="正在推进", result_is_latest=False,
                    observation="本机运行事件 · 只读跟踪", runtime_source="local_events",
                    runtime_observed_at=evidence.get("event_at"))
    elif status in {"completed", "interrupted", "failed"} and matches:
        card.update(runtime_source="local_events", runtime_observed_at=evidence.get("event_at"), observation="本机回合结束事件 · 只读跟踪")
        if status == "completed":
            if card.get("result_is_latest"):
                card["status"] = "waiting_user" if card.get("status") == "waiting_user" else "result_ready"
                card["stage"] = "本轮有结果 · 尚未验收"
            else:
                card.update(status="completed", stage="本轮已结束 · 结果同步中")
        else:
            card.update(status=status, stage="回合已停止" if status == "interrupted" else "本轮失败")
    elif status == "unknown" and card.get("status") == "running":
        card.update(status="unknown", stage="状态待同步")
    card["context_version"] = hashlib.sha256((card["context_version"] + str(evidence.get("revision"))).encode()).hexdigest()[:24]
