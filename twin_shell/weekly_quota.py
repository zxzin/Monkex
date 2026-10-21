"""Read-only Codex usage displays, sourced from the current account snapshot."""
from decimal import Decimal, InvalidOperation
import math
import re
import time
from typing import Any


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


def _core_limits(result: dict[str, Any]) -> dict[str, Any] | None:
    buckets = result.get("rateLimitsByLimitId")
    limits = buckets["codex"] if isinstance(buckets, dict) and "codex" in buckets else result.get("rateLimits")
    if isinstance(limits, dict) and limits.get("limitId") in (None, "codex"):
        return limits
    return None


def _timestamp(value: Any) -> int | float | None:
    # Restrict dates to finite Unix seconds that the date display can render.
    if type(value) in (int, float) and 0 < value <= 253402300799:
        return value
    return None


def _credit_balance(value: Any) -> dict[str, Any]:
    result = {"available": False, "balance": None, "unlimited": False}
    if not isinstance(value, dict):
        return result
    result["unlimited"] = value.get("unlimited") is True
    balance = value.get("balance")
    if isinstance(balance, str) and len(balance) <= 128 and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", balance):
        try:
            amount = Decimal(balance)
            if amount.is_finite() and amount >= 0:
                result["balance"] = balance
        except InvalidOperation:
            pass
    result["available"] = result["balance"] is not None or result["unlimited"]
    return result


def _reset_cards(value: Any) -> dict[str, Any]:
    result = {"available": False, "available_count": None, "expirations": [], "unlisted_count": 0}
    if not isinstance(value, dict):
        return result
    count = value.get("availableCount")
    if type(count) is not int or not 0 <= count <= 9007199254740991:
        return result
    result.update(available=True, available_count=count, unlisted_count=count)
    rows = value.get("credits")
    if not isinstance(rows, list):
        return result
    grouped: dict[int | float | None, int] = {}
    listed = 0
    for row in rows:
        if listed >= count:
            break
        if not isinstance(row, dict) or row.get("status") != "available" or row.get("resetType") != "codexRateLimits":
            continue
        # A missing or malformed date is unavailable; explicit null means no expiry.
        if "expiresAt" not in row:
            continue
        raw_expiry = row["expiresAt"]
        expiry = _timestamp(raw_expiry)
        if raw_expiry is not None and expiry is None:
            continue
        grouped[expiry] = grouped.get(expiry, 0) + 1
        listed += 1
    result["expirations"] = [
        {"count": grouped[expiry], "expires_at": expiry}
        for expiry in sorted(grouped, key=lambda value: float("inf") if value is None else value)
    ]
    result["unlisted_count"] = count - listed
    return result


def quota_details(response: Any, *, now: float | None = None) -> dict[str, Any]:
    """Normalize quota metadata without retaining account or reset-credit identifiers."""
    details = {"observed_at": time.time() if now is None else now, "refresh_pending": False,
               "credit_balance": _credit_balance(None), "reset_cards": _reset_cards(None), "windows": []}
    if not isinstance(response, dict) or response.get("error") or not isinstance(response.get("result"), dict):
        return details
    result = response["result"]
    details["reset_cards"] = _reset_cards(result.get("rateLimitResetCredits"))
    limits = _core_limits(result)
    if limits is None:
        return details
    details["credit_balance"] = _credit_balance(limits.get("credits"))
    windows = {}
    for key in ("primary", "secondary"):
        window = limits.get(key)
        if not isinstance(window, dict):
            continue
        duration, used = window.get("windowDurationMins"), window.get("usedPercent")
        if (type(duration) not in (int, float) or duration not in (300, 10080)
                or type(used) not in (int, float) or not 0 <= used <= 100):
            continue
        windows.setdefault(int(duration), {"window_minutes": int(duration),
                           "remaining_percent": round(100 - used, 1), "resets_at": _timestamp(window.get("resetsAt"))})
    details["windows"] = [windows[duration] for duration in sorted(windows)]
    return details


def weekly_quota(response: Any, *, now: float | None = None) -> dict[str, Any]:
    unknown = {"available": False, "remaining_percent": None}
    if not isinstance(response, dict) or response.get("error"):
        return unknown
    result = response.get("result")
    if not isinstance(result, dict):
        return unknown
    limits = _core_limits(result)
    if limits is None:
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
