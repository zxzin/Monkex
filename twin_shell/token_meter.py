"""Per-task rolling token telemetry, derived from local cumulative reports.

Like ZinxBee, the rate uses a 60-second window and an observed baseline. Input
includes cached input. Output reasoning is already included in output tokens.
These are reported usage units, not billing or model decoding throughput.
"""
from collections import deque
from dataclasses import dataclass, field
import math
from typing import Any


WINDOW_SECONDS = 60
BUCKET_SECONDS = 5


@dataclass
class TokenMeter:
    total: int | None = None
    first_at: float | None = None
    last_at: float | None = None
    reports: int = 0
    deltas: deque = field(default_factory=lambda: deque(maxlen=2048))

    def record(self, at: float, info: Any) -> None:
        if not isinstance(info, dict):
            return
        usage = info.get("total_token_usage")
        if not isinstance(usage, dict):
            return
        total = usage.get("total_tokens")
        if type(total) is not int or not 0 <= total <= 2**63 - 1 or not math.isfinite(at):
            return
        if self.last_at is not None and at < self.last_at:
            return
        if self.total is not None and total > self.total:
            self.deltas.append((at, total - self.total))
        elif self.total is not None and total < self.total:
            # A counter reset establishes a new baseline, without fabricating
            # negative use or charging the new baseline as fresh consumption.
            self.first_at, self.reports = at, 0
            self.deltas.clear()
        if self.first_at is None:
            self.first_at = at
        if self.last_at != at or self.total != total:
            self.reports += 1
        self.total, self.last_at = total, at
        while self.deltas and self.deltas[0][0] <= at - WINDOW_SECONDS:
            self.deltas.popleft()

    def snapshot(self, now: float) -> dict[str, Any]:
        buckets = [0] * (WINDOW_SECONDS // BUCKET_SECONDS)
        recent = 0
        for at, delta in self.deltas:
            if now - WINDOW_SECONDS < at <= now:
                recent += delta
                index = min(len(buckets)-1, int((at - (now-WINDOW_SECONDS)) // BUCKET_SECONDS))
                buckets[index] += delta
        ready = self.reports >= 2
        elapsed = max(1, min(WINDOW_SECONDS, now - self.first_at)) if self.first_at is not None else 0
        return {"source": "local_token_count", "available": self.total is not None,
                "ready": ready, "tokens_per_min": round(recent * 60 / elapsed, 1) if ready else None,
                "recent_tokens": recent if ready else None, "window_seconds": WINDOW_SECONDS,
                "sample_seconds": round(elapsed, 1), "last_report_at": self.last_at,
                "buckets": buckets, "bucket_seconds": BUCKET_SECONDS}


def aggregate_project_tokens(cards: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Group exact workspace paths in memory; never join unassociated projects."""
    groups: dict[str, dict[str, Any]] = {}
    for card in cards:
        cwd = card.get("cwd")
        if not cwd:
            continue
        entry = groups.setdefault(cwd, {"tokens_per_min": 0.0, "recent_tokens": 0,
                                       "measured_tasks": 0, "running_tasks": 0,
                                       "unmeasured_running_tasks": 0, "buckets": [0]*12})
        tokens = card.get("tokens") or {}
        if card.get("status") == "running":
            entry["running_tasks"] += 1
            if not tokens.get("ready"):
                entry["unmeasured_running_tasks"] += 1
        if tokens.get("ready"):
            entry["measured_tasks"] += 1
            entry["tokens_per_min"] += tokens["tokens_per_min"]
            entry["recent_tokens"] += tokens["recent_tokens"]
            entry["buckets"] = [a+b for a,b in zip(entry["buckets"], tokens["buckets"])]
    for entry in groups.values():
        entry["ready"] = entry["measured_tasks"] > 0
        if not entry["ready"]:
            entry["tokens_per_min"] = None
            entry["recent_tokens"] = None
        entry["partial"] = entry["unmeasured_running_tasks"] > 0
        entry["window_seconds"] = WINDOW_SECONDS
    return groups
