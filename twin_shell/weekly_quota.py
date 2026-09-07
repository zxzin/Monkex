"""Read-only weekly Codex subscription display; no stopping or reset policy."""
import math
import time


def primary_usage(response: dict) -> dict:
    if response.get("error"):
        raise ValueError("Usage unavailable")
    limits = (response.get("result") or {}).get("rateLimits") or {}
    primary = limits.get("primary") or {}
    used = float(primary["usedPercent"])
    if not math.isfinite(used) or not 0 <= used <= 100:
        raise ValueError("Invalid usage")
    return {"used_percent": used, "window_minutes": primary.get("windowDurationMins"),
            "plan_type": limits.get("planType"), "limit_id": limits.get("limitId")}
from typing import Any


def weekly_quota(response: Any, *, now: float | None = None) -> dict[str, Any]:
    unknown = {"available": False, "remaining_percent": None}
    if not isinstance(response, dict) or response.get("error"):
        return unknown
    result = response.get("result")
    if not isinstance(result, dict):
        return unknown
    buckets = result.get("rateLimitsByLimitId")
    limits = buckets["codex"] if isinstance(buckets, dict) and "codex" in buckets else result.get("rateLimits")
    if not isinstance(limits, dict) or (limits.get("limitId") is not None and limits.get("limitId") != "codex"):
        return unknown
    for key in ("primary", "secondary"):
        window = limits.get(key)
        if not isinstance(window, dict) or window.get("windowDurationMins") != 10080:
            continue
        used = window.get("usedPercent")
        if type(used) not in (int, float) or not math.isfinite(used):
            continue
        reset = window.get("resetsAt")
        reset = reset if type(reset) in (int, float) and math.isfinite(reset) and reset > 0 else None
        return {"available": True, "remaining_percent": round(max(0, min(100, 100-used)), 1),
                "window_minutes": 10080, "resets_at": reset,
                "observed_at": time.time() if now is None else now, "limit_id": "codex"}
    return unknown
