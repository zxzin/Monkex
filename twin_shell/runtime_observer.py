"""Read-only desktop turn evidence; this observer grants no execution authority.

The standalone App Server knows its own live connections. Desktop-owned turns
are observed separately through structured local rollout events. Only IDs,
timestamps, model settings and activity metadata survive parsing, in memory only.
"""
from __future__ import annotations
from contextlib import closing

from dataclasses import dataclass, field
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import threading
import time
from typing import Any

from .token_meter import TokenMeter
from .task_view import result_version


READ_LIMIT = 4 * 1024 * 1024
LINE_LIMIT = 2 * 1024 * 1024
RUNTIME_LEASE = 30 * 60
RESULT_WINDOW = 7 * 86400
PROGRESS_EVENTS = {"agent_reasoning", "agent_message", "mcp_tool_call_begin", "mcp_tool_call_end", "exec_command_begin", "exec_command_end", "item_started", "item_completed"}
PROGRESS_ITEMS = {"reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"}
TOOL_TRACK_LIMIT = 64
TOOL_ITEM_TYPES = {"commandexecution", "mcptoolcall", "dynamictoolcall", "functioncall", "customtoolcall", "websearch", "imagegeneration"}
ISSUE_TTL = 300


def _metadata_id(value: Any, limit: int = 256) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= limit and value.isprintable() else None


def _terminal_issue(error: Any, turn_id: str | None, at: float) -> dict[str, Any] | None:
    """Classify structured error variants without retaining message content."""
    if not error or not turn_id:
        return None
    info = error.get("codex_error_info") if isinstance(error, dict) else None
    if isinstance(info, dict):
        info = info.get("type") or (next(iter(info)) if len(info) == 1 else None)
    variant = info.replace("_", "").lower() if isinstance(info, str) else ""
    code = "http_connection_failed" if variant == "httpconnectionfailed" else "task_error"
    return {"state": "error", "code": code, "at": at, "turn_id": turn_id}


@dataclass
class Cursor:
    identity: tuple[str, int, int]
    offset: int = 0
    skipping: bool = False
    pending: bytes = b""
    status: str = "unknown"
    turn_id: str | None = None
    turn_started_at: float = 0
    event_at: float = 0
    activity_at: float = 0
    live_activity_at: float = 0
    anchored: bool = False
    terminal_ids: set[str] = field(default_factory=set)
    superseded_ids: set[str] = field(default_factory=set)
    result_turn_id: str | None = None
    result_version: str | None = None
    result_completed_at: float = 0
    tokens: TokenMeter = field(default_factory=TokenMeter)
    turn_tokens: TokenMeter = field(default_factory=TokenMeter)
    phase: str = "unknown"
    phase_at: float = 0
    model: str | None = None
    effort: str | None = None
    telemetry_turn_id: str | None = None
    tool_calls: dict[str, float] = field(default_factory=dict)
    ended_tool_calls: dict[str, float] = field(default_factory=dict)
    runtime_issue: dict[str, Any] | None = None

    def select_turn(self, turn_id: str) -> None:
        if self.turn_id != turn_id:
            if self.turn_id:
                self.superseded_ids.add(self.turn_id)
                if len(self.superseded_ids) > 64:
                    self.superseded_ids = {self.turn_id}
            self.turn_id, self.turn_started_at = turn_id, 0
            self.anchored = False
            self.reset_activity_metadata(turn_id)

    def reset_activity_metadata(self, turn_id: str | None = None) -> None:
        self.telemetry_turn_id = turn_id
        self.activity_at = 0
        self.turn_tokens = TokenMeter()
        self.phase, self.phase_at = "unknown", 0
        self.live_activity_at = 0
        self.model = self.effort = None
        self.tool_calls.clear()
        self.ended_tool_calls.clear()
        self.runtime_issue = None

    def observe_phase(self, envelope: str, payload: dict[str, Any], at: float) -> None:
        """Record the latest event category, with bounded tool-call pairing.

        A phase describes observed evidence. Its timestamp lets the UI qualify
        stale observations instead of claiming continuous model execution.
        """
        kind = payload.get("type")
        item = payload.get("item") if kind in {"item_started", "item_completed"} else None
        item = item if isinstance(item, dict) else {}
        item_kind = item.get("type")
        item_kind = item_kind.replace("_", "").lower() if isinstance(item_kind, str) else ""
        call_id = _metadata_id(payload.get("call_id") or payload.get("callId") or item.get("call_id") or item.get("callId")
                               or (item.get("id") if item_kind in TOOL_ITEM_TYPES else None))
        starting = ((envelope == "response_item" and kind in {"function_call", "custom_tool_call"})
                    or (envelope == "event_msg" and kind in {"mcp_tool_call_begin", "exec_command_begin"})
                    or (kind == "item_started" and item_kind in TOOL_ITEM_TYPES))
        ending = ((envelope == "response_item" and kind in {"function_call_output", "custom_tool_call_output"})
                  or (envelope == "event_msg" and kind in {"mcp_tool_call_end", "exec_command_end"})
                  or (kind == "item_completed" and item_kind in TOOL_ITEM_TYPES))
        if starting:
            if call_id and call_id not in self.ended_tool_calls:
                self.tool_calls.setdefault(call_id, at)
                while len(self.tool_calls) > TOOL_TRACK_LIMIT:
                    self.tool_calls.pop(next(iter(self.tool_calls)))
            # An already-ended duplicate start carries no fresh execution claim.
            self.phase = "tool" if self.tool_calls or not call_id else "waiting"
            if self.phase == "tool":
                self.live_activity_at = at
        elif ending:
            if call_id:
                self.tool_calls.pop(call_id, None)
                self.ended_tool_calls[call_id] = at
                while len(self.ended_tool_calls) > TOOL_TRACK_LIMIT:
                    self.ended_tool_calls.pop(next(iter(self.ended_tool_calls)))
            self.phase = "tool" if self.tool_calls else "waiting"
        elif kind in {"agent_reasoning", "reasoning"} or item_kind == "reasoning":
            self.phase = "tool" if self.tool_calls else "thinking"
            self.live_activity_at = at
        elif kind == "agent_message" or (kind == "message" and payload.get("role") == "assistant") or item_kind == "agentmessage":
            self.phase = "tool" if self.tool_calls else "response"
            self.live_activity_at = at
        else:
            return
        self.phase_at = at

    def snapshot(self, now: float) -> dict[str, Any]:
        status = self.status
        activity_fresh = -30 <= now - self.activity_at <= RUNTIME_LEASE
        live_activity_fresh = bool(self.live_activity_at and -30 <= now - self.live_activity_at <= RUNTIME_LEASE)
        # An observed task_started anchors the lifecycle until its terminal
        # event. Tail fragments retain a bounded lease, even with a turn ID.
        if status == "running" and not self.anchored and not activity_fresh:
            status = "unknown"
        issue = self.runtime_issue
        issue = dict(issue) if issue and issue.get("turn_id") == self.turn_id and -30 <= now - issue["at"] <= ISSUE_TTL else None
        return {"status": status, "turn_id": self.turn_id, "turn_started_at": self.turn_started_at, "event_at": self.event_at,
                "activity_fresh": activity_fresh, "observation_available": True,
                "live_activity_at": self.live_activity_at, "live_activity_fresh": live_activity_fresh,
                "runtime_issue": issue,
                "activity_at": self.activity_at, "phase": self.phase, "phase_at": self.phase_at,
                "model": self.model, "effort": self.effort, "pending_tools": len(self.tool_calls),
                "result_turn_id": self.result_turn_id, "result_version": self.result_version,
                "result_completed_at": self.result_completed_at,
                "anchored": self.anchored, "revision": f"{self.offset}:{status}:{self.turn_id}:{self.event_at}:{activity_fresh}:{live_activity_fresh}"}


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
                    columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
                    updated_column = "updated_at" if "updated_at" in columns else "NULL"
                    metadata = {}
                    for start in range(0, len(thread_ids), 400):
                        batch = thread_ids[start:start+400]
                        rows = db.execute(
                            f"SELECT id, rollout_path, {updated_column} FROM threads "
                            f"WHERE archived=0 AND id IN ({','.join('?' for _ in batch)})",
                            batch,
                        )
                        metadata.update((row[0], (row[1], row[2])) for row in rows)
                self.error = False
            except (OSError, ValueError, sqlite3.Error):
                self.error = True
                self._available.difference_update(thread_ids)
                return
            for thread_id in thread_ids:
                self._available.discard(thread_id)
                thread_metadata = metadata.get(thread_id)
                if not thread_metadata:
                    # A successful metadata lookup confirms deletion/archival.
                    self._cursors.pop(thread_id, None)
                    continue
                path_value, database_updated_at = thread_metadata
                try:
                    path = _resolve_rollout_path(path_value)
                    if not path.is_relative_to(self.root / "sessions"):
                        continue
                    stat = path.stat()
                    identity = (str(path), stat.st_dev, stat.st_ino)
                    cursor = self._cursors.get(thread_id)
                    freshness = stat.st_mtime
                    if isinstance(database_updated_at, (int, float)):
                        freshness = max(freshness, float(database_updated_at))
                    # Windows can retain an open rollout's original mtime while
                    # Codex keeps appending. The state database is the canonical
                    # freshness signal for selecting which bounded tails to read.
                    if not cursor and self.clock() - freshness > RESULT_WINDOW:
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
                            cursor.turn_started_at = 0
                            cursor.tokens = TokenMeter()
                            cursor.reset_activity_metadata()
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
        if at > self.clock() + 30 or at < max(cursor.event_at, cursor.turn_started_at):
            return
        kind = payload.get("type")
        if kind is not None and not isinstance(kind, str):
            return
        turn_id = payload.get("turn_id")
        if turn_id is not None and not isinstance(turn_id, str):
            return
        if envelope == "event_msg" and kind == "token_count":
            # Thread totals retain their rolling window across turns. Runtime
            # health uses a separate baseline belonging to the selected turn.
            cursor.tokens.record(at, payload.get("info"))
            if cursor.turn_id and (not turn_id or turn_id == cursor.turn_id):
                cursor.turn_tokens.record(at, payload.get("info"))
            return
        if turn_id in cursor.superseded_ids:
            return
        if envelope == "event_msg" and kind == "task_started" and turn_id:
            if turn_id not in cursor.terminal_ids:
                if cursor.turn_id != turn_id:
                    cursor.select_turn(turn_id)
                    cursor.phase, cursor.phase_at = "starting", at
                if not cursor.anchored:
                    cursor.turn_started_at = at
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
            cursor.tool_calls.clear()
            cursor.ended_tool_calls.clear()
            cursor.phase, cursor.phase_at = "waiting", at
            cursor.runtime_issue = _terminal_issue(payload.get("error"), cursor.turn_id, at) if cursor.status == "failed" else None
            # The desktop completion envelope remains authoritative when the
            # paginated history API lags. Retain only its identity and digest.
            final = payload.get("last_agent_message")
            if cursor.status == "completed" and turn_id and isinstance(final, str) and final.strip():
                cursor.result_turn_id = turn_id
                cursor.result_version = result_version(turn_id, final)
                cursor.result_completed_at = at
            return
        # Context associates later legacy activity with a turn without itself
        # proving activity. Quoted events inside message bodies are never read.
        if envelope == "turn_context":
            if turn_id and turn_id in cursor.terminal_ids:
                return
            if turn_id and cursor.turn_id != turn_id:
                cursor.select_turn(turn_id)
                cursor.status = "unknown"
            cursor.model = _metadata_id(payload.get("model"), 128) or cursor.model
            cursor.effort = _metadata_id(payload.get("effort") or payload.get("reasoning_effort"), 32) or cursor.effort
            return
        progress = (envelope == "event_msg" and kind in PROGRESS_EVENTS) or (envelope == "response_item" and (kind in PROGRESS_ITEMS or (kind == "message" and payload.get("role") == "assistant" and payload.get("phase") == "commentary")))
        if kind in {"item_started", "item_completed"}:
            item = payload.get("item")
            if not isinstance(item, dict) or item.get("type") in {"UserMessage", "userMessage"}:
                progress = False
        if not progress or (turn_id and turn_id in cursor.terminal_ids):
            return
        # A progress envelope describes activity inside the selected lifecycle.
        # A delayed tool completion may name an older turn whose start/end were
        # outside the bounded tail. Only start/context can select another turn.
        if (cursor.status in {"completed", "failed", "interrupted"}
                or (turn_id and cursor.turn_id and turn_id != cursor.turn_id)):
            return
        if turn_id and turn_id != cursor.turn_id:
            cursor.select_turn(turn_id)
        if turn_id and cursor.telemetry_turn_id != turn_id:
            cursor.reset_activity_metadata(turn_id)
        cursor.observe_phase(envelope, payload, at)
        cursor.status = "running"
        cursor.activity_at = cursor.event_at = at

    def snapshot(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked(thread_id, self.clock())

    def _snapshot_locked(self, thread_id: str, now: float) -> dict[str, Any]:
        cursor = self._cursors.get(thread_id)
        if not cursor:
            return {"status": "unknown", "revision": "unavailable", "event_at": 0,
                    "activity_at": 0, "phase": "unknown", "phase_at": 0,
                    "live_activity_at": 0, "live_activity_fresh": False,
                    "model": None, "effort": None, "pending_tools": 0,
                    "activity_fresh": False, "observation_available": False, "runtime_issue": None}
        evidence = cursor.snapshot(now)
        if thread_id not in self._available:
            evidence.update(observation_available=False, activity_fresh=False, live_activity_fresh=False)
            evidence["revision"] += ":unavailable"
        return evidence

    def diagnostics_snapshot(self, thread_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """Capture one turn's activity and usage under the same lock and clock."""
        with self._lock:
            now = self.clock()
            evidence = self._snapshot_locked(thread_id, now)
            cursor = self._cursors.get(thread_id)
            meter = cursor.turn_tokens if cursor and thread_id in self._available else TokenMeter()
            return evidence, meter.snapshot(now)

    def token_snapshot(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            cursor = self._cursors.get(thread_id)
            if thread_id not in self._available or not cursor:
                return TokenMeter().snapshot(self.clock())
            return cursor.tokens.snapshot(self.clock())


def _resolve_rollout_path(value: str) -> Path:
    path_value = str(value)
    if sys.platform == "win32":
        if path_value.startswith("\\\\?\\UNC\\"):
            path_value = "\\\\" + path_value[8:]
        elif path_value.startswith("\\\\?\\"):
            path_value = path_value[4:]
    return Path(path_value).resolve()


def apply_runtime(card: dict[str, Any], evidence: dict[str, Any]) -> None:
    """Decorate display state while retaining the original control boundary."""
    if card.get("can_send"):
        return
    status = evidence.get("status")
    turn_id = evidence.get("turn_id")
    matches = not turn_id or not card.get("latest_turn_id") or card["latest_turn_id"] == turn_id
    latest_started = card.get("latest_turn_started_at") or 0
    event_at = evidence.get("event_at") or 0
    evidence_started = evidence.get("turn_started_at") or 0
    newer = bool(latest_started and (evidence_started or event_at) >= latest_started)
    api_terminal = card.get("latest_turn_status") in {"completed", "failed", "interrupted"} or card.get("status") in {"result_ready", "waiting_user", "completed", "failed", "interrupted"}
    terminal_at = card.get("latest_turn_completed_at") or (card.get("result_completed_at") if card.get("result_is_latest") else 0) or 0
    if turn_id and turn_id == card.get("latest_turn_id") and api_terminal and terminal_at > event_at:
        return
    result_at = evidence.get("result_completed_at") or 0
    if evidence.get("result_version") and result_at > (card.get("result_completed_at") or 0):
        # A timestamp comparison protects a newer API result from an older tail.
        card.update(has_result=True, result_version=evidence["result_version"],
                    result_turn_id=evidence["result_turn_id"], result_completed_at=result_at)
        if evidence["result_turn_id"] != card.get("latest_turn_id"):
            card.update(result_excerpt="新一轮已完成 · 打开 Codex 查看结果", result_is_latest=False)
    if status == "running":
        matching_final = bool(turn_id and turn_id == card.get("latest_turn_id") and card.get("has_result") and card.get("result_is_latest"))
        # Fresh same-turn execution outranks an interrupted snapshot with no
        # terminal timestamp or final. Tool-end receipts supply no live proof.
        current_work = bool(turn_id and turn_id == card.get("latest_turn_id")
                            and (card.get("latest_turn_status") or card.get("status")) == "interrupted"
                            and not terminal_at and not matching_final
                            and evidence.get("observation_available", True) and evidence.get("live_activity_fresh")
                            and (evidence.get("live_activity_at") or 0) >= latest_started)
        # Isolated fragments retain their own API turn and respect confirmed
        # terminal evidence. Their arrival time supplies activity, never a start.
        if not evidence.get("anchored") and (not matches or (api_terminal and not current_work)):
            return
        if ((not matches and latest_started and not newer)
                or (not matches and api_terminal and terminal_at and evidence_started <= terminal_at)
                or (matches and api_terminal and terminal_at and terminal_at >= event_at)
                or (matching_final and api_terminal and not terminal_at)):
            return
        if turn_id:
            card["latest_turn_id"] = turn_id
            if evidence_started:
                card["latest_turn_started_at"] = evidence_started
        card.pop("runtime_issue", None)
        card.update(status="running", stage="正在推进", result_is_latest=False,
                    observation="本机运行事件 · 只读跟踪" if evidence.get("observation_available", True) else "已观测运行 · 等待同步",
                    runtime_source="local_events", runtime_observed_at=evidence.get("event_at"),
                    runtime_activity_fresh=evidence.get("activity_fresh", True),
                    runtime_observation_available=evidence.get("observation_available", True))
    elif status in {"completed", "interrupted", "failed"} and (matches or newer):
        # A late terminal for another turn can carry a result receipt, while
        # the API's current running turn keeps its independent lifecycle. A
        # matching ID or an observed newer start establishes terminal order.
        if (not matches and not evidence.get("anchored")
                and (card.get("status") == "running" or card.get("latest_turn_status") == "inProgress")):
            return
        if turn_id:
            card["latest_turn_id"] = turn_id
        card["result_is_latest"] = bool(card.get("has_result") and card.get("result_turn_id") == card.get("latest_turn_id"))
        card.update(runtime_source="local_events", runtime_observed_at=evidence.get("event_at"), observation="本机回合结束事件 · 只读跟踪")
        issue = evidence.get("runtime_issue")
        if isinstance(issue, dict) and issue.get("turn_id") == card.get("latest_turn_id") and status == "failed":
            card["runtime_issue"] = dict(issue)
        else:
            card.pop("runtime_issue", None)
        if status == "completed":
            if card.get("result_is_latest"):
                card["status"] = "waiting_user" if card.get("status") == "waiting_user" else "result_ready"
                card["stage"] = "本轮有结果 · 尚未验收"
            else:
                card.update(status="completed", stage="本轮已结束 · 结果同步中")
        else:
            card.update(status=status, stage="回合已停止" if status == "interrupted" else "本轮失败")
    card["context_version"] = hashlib.sha256((card["context_version"] + str(evidence.get("revision"))).encode()).hexdigest()[:24]
