"""Bounded, content-free frequency of distinct Codex run-start envelopes."""
from dataclasses import dataclass, field
from datetime import datetime
import json
from pathlib import Path
import re
from typing import Any

DAY = 86400
WINDOW_SECONDS = 7 * DAY
BACKFILL_CHUNK = 1024 * 1024
BACKFILL_BUDGET = 4 * BACKFILL_CHUNK
FRAGMENT_LIMIT = 64 * 1024
RUN_LIMIT = 4096


def valid_thread_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", value) is not None


def unknown_frequency(now: float | None = None) -> dict[str, Any]:
    return {"source": "codex_run", "window_days": 7, "run_count": None,
            "weighted_score": None, "active_days": None, "last_run_at": None,
            "available": False, "complete": False, "observed_at": now}


@dataclass
class RunFrequency:
    runs: dict[str, float] = field(default_factory=dict)
    backfill_end: int = 0
    carry: bytes | None = field(default=b"", repr=False)
    complete: bool = False
    supported: bool = False
    gap_until: float = 0

    def mark_gap(self, now: float) -> None:
        self.gap_until = max(self.gap_until, now + WINDOW_SECONDS)

    def seed_tail(self, start: int, block: bytes, now: float) -> None:
        """Join the first tail fragment to the preceding historical chunk."""
        self.backfill_end = start
        self.complete = start == 0
        first = block.split(b"\n", 1)[0] if start else b""
        self.carry = first if len(first) <= FRAGMENT_LIMIT else None
        if self.carry is None:
            self.mark_gap(now)

    def observe(self, record: dict[str, Any], thread_id: str, now: float) -> None:
        payload = record.get("payload")
        if (record.get("type") != "event_msg" or not isinstance(payload, dict)
                or payload.get("type") != "task_started"
                or payload.get("thread_id", thread_id) != thread_id):
            return
        turn = payload.get("turn_id")
        if not isinstance(turn, str) or not 0 < len(turn) <= 256 or not turn.isprintable():
            self.mark_gap(now)
            return
        try:
            at = datetime.fromisoformat(str(record.get("timestamp")).replace("Z", "+00:00")).timestamp()
            if not 0 < at <= now + 30:
                self.mark_gap(now)
                return
        except (ValueError, TypeError, OverflowError):
            self.mark_gap(now)
            return
        self.supported = True
        if turn in self.runs:
            self.runs[turn] = min(self.runs[turn], at)
        else:
            # Retain the canonical start even when it predates the window:
            # a later replay of that turn keeps its original age.
            self.runs[turn] = at
        if len(self.runs) > RUN_LIMIT:
            self.runs = {key: value for key, value in self.runs.items() if value > now - WINDOW_SECONDS}
        if len(self.runs) > RUN_LIMIT:
            self.runs = dict(sorted(self.runs.items(), key=lambda item: item[1], reverse=True)[:RUN_LIMIT])
            self.mark_gap(now)

    def _line(self, line: bytes, thread_id: str, now: float) -> None:
        if not line:
            return
        if len(line) > 2 * BACKFILL_CHUNK:
            self.mark_gap(now)
            return
        try:
            record = json.loads(line)
            if isinstance(record, dict):
                self.observe(record, thread_id, now)
        except (ValueError, TypeError, RecursionError):
            self.mark_gap(now)

    def backfill(self, path: Path, thread_id: str, now: float, budget: int) -> int:
        if self.complete or self.backfill_end <= 0 or budget <= 0:
            return 0
        end = self.backfill_end
        start = max(0, end - min(budget, BACKFILL_CHUNK))
        with path.open("rb") as stream:
            stream.seek(start)
            block = stream.read(end - start)
        if len(block) != end - start:
            self.mark_gap(now)
            return len(block)
        lines = block.split(b"\n")
        if self.carry is not None:
            lines[-1] += self.carry
        else:
            lines.pop()
        first = lines.pop(0) if lines else b""
        for line in lines:
            self._line(line, thread_id, now)
        self.carry = first if len(first) <= FRAGMENT_LIMIT else None
        if self.carry is None:
            self.mark_gap(now)
        self.backfill_end = start
        if start == 0:
            if self.carry is not None:
                self._line(self.carry, thread_id, now)
            self.carry = b""
            self.complete = True
        return len(block)

    def snapshot(self, now: float) -> dict[str, Any]:
        if not self.supported:
            return unknown_frequency(now)
        starts = [at for at in self.runs.values() if now - WINDOW_SECONDS < at <= now + 30]
        return {"source": "codex_run", "window_days": 7, "run_count": len(starts),
                "weighted_score": sum(3 if now - at < DAY else 2 if now - at < 3 * DAY else 1 for at in starts),
                "active_days": len({int(max(0, now - at) // DAY) for at in starts}),
                "last_run_at": max(starts) if starts else None, "available": True,
                "complete": self.complete and self.gap_until < now, "observed_at": now}
