"""Explainable public-path score; it is not model throughput or an uptime probability.

The caller supplies credential-free probe observations. This module performs
pure calculations and retains no history, destinations, credentials or content.
"""
from __future__ import annotations

import math
from typing import Any


WINDOW_SECONDS = 15 * 60
FRESH_SECONDS = 180
FAILURE_LATENCY_MS = 6000
TARGET_WEIGHTS = {"codex": 0.60, "api": 0.25, "auth": 0.15}
METHOD_VERSION = "public-path-v1"


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _latency_quality(value: float) -> float:
    if value <= 500:
        return 1.0
    if value <= 3000:
        return 1 - (value - 500) * 0.6 / 2500
    return max(0.0, 0.4 * (6000 - value) / 3000)


def _blend(values: dict[str, float]) -> float:
    """Retain Codex emphasis while making a weak required service visible."""
    weighted = sum(TARGET_WEIGHTS[key] * values[key] for key in TARGET_WEIGHTS)
    return 0.6 * weighted + 0.4 * min(values.values())


def _observations(history, now):
    unique = {}
    for raw in history:
        if not isinstance(raw, dict):
            continue
        target, at, round_id = raw.get("target"), raw.get("at"), raw.get("round_id")
        valid_round = (isinstance(round_id, str) and 0 < len(round_id) <= 128) or type(round_id) is int
        if not isinstance(target, str) or target not in TARGET_WEIGHTS or not _number(at) or not now-WINDOW_SECONDS < at <= now or not valid_round:
            continue
        if type(raw.get("transport_ok")) is not bool or type(raw.get("expected_response")) is not bool:
            continue
        status = raw.get("http_status")
        status = status if type(status) is int and 100 <= status <= 599 else None
        latency = raw.get("latency_ms")
        latency = float(latency) if _number(latency) and latency >= 0 else None
        transport = raw["transport_ok"]
        restricted = bool(transport and status in {403, 429})
        expected = bool(transport and raw["expected_response"] and not restricted)
        observation = {"at": float(at), "round_id": round_id, "target": target,
                       "transport_ok": transport, "expected_response": expected,
                       "restricted": restricted, "http_status": status, "latency_ms": latency}
        key = (type(round_id).__name__, round_id, target)
        previous = unique.get(key)
        # A round contributes one attempt per service. Its earliest observation
        # survives retransmission; retries belong to a new independent round.
        if previous is None or (observation["at"], expected) < (previous["at"], previous["expected_response"]):
            unique[key] = observation
    return sorted(unique.values(), key=lambda row: row["at"])


def _official_context(official, notes, caps):
    if not isinstance(official, dict) or official.get("stale"):
        notes.append("official_status_unknown")
        return
    components = official.get("components")
    components = components if isinstance(components, list) else []
    named = [component for component in components if isinstance(component, dict)
             and isinstance(component.get("name"), str)]
    desktop_names = {"codex in chatgpt desktop", "codex desktop", "codex desktop app"}
    desktop = [component for component in named if component["name"].strip().lower() in desktop_names]
    # Desktop evidence has priority. A broad Codex component supplies a fallback
    # only when the status page has no explicit desktop component.
    codex = desktop or [component for component in named if component["name"].strip().lower() == "codex"]
    known = {"operational", "degraded_performance", "partial_outage", "major_outage", "under_maintenance"}
    statuses = {component.get("status") for component in codex if isinstance(component.get("status"), str)}
    if statuses & {"partial_outage", "major_outage"}:
        notes.append("official_codex_outage")
        caps.append({"code": "official_codex_outage", "max_value": 40})
    elif statuses & {"degraded_performance", "under_maintenance"}:
        notes.append("official_codex_degraded")
        caps.append({"code": "official_codex_degraded", "max_value": 70})
    elif not statuses or not statuses <= known:
        notes.append("official_status_unknown")
    incidents = official.get("incidents")
    other_degraded = any(isinstance(component, dict) and component not in codex
                         and isinstance(component.get("status"), str)
                         and component.get("status") in {"degraded_performance", "partial_outage", "major_outage", "under_maintenance"}
                         for component in components)
    # Incident text without explicit component evidence remains a public notice.
    if (isinstance(incidents, list) and incidents) or other_degraded:
        notes.append("official_other_notice")


def score_runtime_health(history, *, now, runtime=None, official=None):
    """Score a bounded current sample using reliability 60, p95 25, jitter 15.

    Three independent observations of every required service enable a provisional
    value. Six per service spanning 15 seconds support a short-check result.
    Missing samples and stale runtime evidence retain their unknown semantics.
    """
    if not _number(now):
        raise ValueError("now must be a finite timestamp")
    runtime = runtime if isinstance(runtime, dict) else {}
    current = runtime.get("current") is True
    active = runtime.get("active", runtime.get("active_tasks", 0))
    quiet = runtime.get("quiet", runtime.get("quiet_tasks", 0))
    observed = bool(current and _number(active) and active > 0)
    notes, caps = ["public_path_only"], []
    if not current:
        notes.append("runtime_unconfirmed")
    if current and _number(quiet) and quiet > 0:
        notes.append("runtime_quiet")
    rows = _observations(history if isinstance(history, (list, tuple)) else [], now)
    rounds = {(type(row["round_id"]).__name__, row["round_id"]) for row in rows}
    by_target = {key: [row for row in rows if row["target"] == key] for key in TARGET_WEIGHTS}
    span = max(row["at"] for row in rows) - min(row["at"] for row in rows) if rows else 0
    last_at = max((row["at"] for row in rows), default=None)
    stale = last_at is not None and now - last_at > FRESH_SECONDS
    coverage = all(len(samples) >= 3 for samples in by_target.values())
    if not coverage:
        notes.append("partial_coverage")
    if len(rounds) < 3 or not coverage:
        notes.append("insufficient_rounds")
    if stale:
        notes.append("probe_stale")
    missing_latency = any(row["expected_response"] and row["latency_ms"] is None for row in rows)
    if missing_latency:
        notes.append("missing_latency")
    if any(not row["transport_ok"] or (not row["expected_response"] and row["latency_ms"] is None) for row in rows):
        notes.append("failed_latency_floor")
    if any(row["restricted"] for row in rows):
        notes.append("http_restricted")
    if any(row["transport_ok"] and not row["expected_response"] and not row["restricted"] for row in rows):
        notes.append("unexpected_response")
    if any(not row["transport_ok"] for row in rows):
        notes.append("service_failures")

    services, reliability, latency_quality, stability = [], {}, {}, {}
    for key, samples in by_target.items():
        actual = [row["latency_ms"] for row in samples if row["latency_ms"] is not None]
        scoring = [max(FAILURE_LATENCY_MS, row["latency_ms"] or 0) if not row["transport_ok"] or (not row["expected_response"] and row["latency_ms"] is None)
                   else row["latency_ms"] for row in samples]
        scoring = [value for value in scoring if value is not None]
        p50, p95 = _percentile(actual, .5), _percentile(actual, .95)
        score_p50, score_p95 = _percentile(scoring, .5), _percentile(scoring, .95)
        reachable_p50 = _percentile([row["latency_ms"] for row in samples
                                    if row["transport_ok"] and row["latency_ms"] is not None], .5)
        rate = sum(row["expected_response"] for row in samples) / len(samples) if samples else None
        if rate is not None:
            reliability[key] = rate
        if score_p95 is not None:
            latency_quality[key] = _latency_quality(score_p95)
            # Failure floors cannot raise the median and manufacture stability
            # when most requests time out. All-unreachable is zero stability.
            stable_p50 = min(score_p50, reachable_p50) if reachable_p50 is not None else 0
            stability[key] = max(0.0, 1 - (score_p95 - stable_p50) / 1500) if reachable_p50 is not None else 0.0
        services.append({"target": key, "sample_count": len(samples),
                         "success_percent": round(rate * 100, 1) if rate is not None else None,
                         "transport_percent": round(100 * sum(row["transport_ok"] for row in samples) / len(samples), 1) if samples else None,
                         "p50_ms": round(p50, 1) if p50 is not None else None,
                         "p95_ms": round(p95, 1) if p95 is not None else None,
                         "scoring_p95_ms": round(score_p95, 1) if score_p95 is not None else None,
                         "restricted_count": sum(row["restricted"] for row in samples)})

    if coverage:
        worst_success = min(reliability.values())
        if worst_success < .7:
            caps.append({"code": "success_below_70", "max_value": 39})
        elif worst_success < .9:
            caps.append({"code": "success_below_90", "max_value": 69})
        recent_codex = by_target["codex"][-3:]
        if all(not row["expected_response"] for row in recent_codex) and not all(row["restricted"] for row in recent_codex):
            notes.append("codex_recent_failures")
            caps.append({"code": "codex_recent_failures", "max_value": 30})
        if any(row["restricted"] for row in recent_codex):
            caps.append({"code": "codex_restricted", "max_value": 69})
    _official_context(official, notes, caps)
    confidence = "collecting"
    components = {"reliability": None, "latency": None, "stability": None}
    value, raw_value = None, None
    success = _blend(reliability) if len(reliability) == len(TARGET_WEIGHTS) else None
    if coverage and len(rounds) >= 3 and not stale and not missing_latency:
        components = {"reliability": round(60 * success, 2),
                      "latency": round(25 * _blend(latency_quality), 2),
                      "stability": round(15 * _blend(stability), 2)}
        raw_value = min(100, max(0, round(sum(components.values()))))
        value = min([raw_value] + [cap["max_value"] for cap in caps])
        confidence = "short_check" if all(len(samples) >= 6 for samples in by_target.values()) and len(rounds) >= 6 and span >= 15 else "provisional"
        if confidence == "short_check":
            notes.append("short_check_only")
    actual = [row["latency_ms"] for row in rows if row["latency_ms"] is not None]
    p50, p95 = _percentile(actual, .5), _percentile(actual, .95)
    grade = "stale" if stale else "collecting" if value is None else "good" if value >= 85 else "fair" if value >= 60 else "poor"
    return {"value": value, "grade": grade, "confidence": confidence,
            "metric": "public_connection", "unit": "points", "authenticated": False,
            "sample_count": len(rows), "round_count": len(rounds), "window_seconds": WINDOW_SECONDS,
            "success_percent": round(100 * sum(row["expected_response"] for row in rows) / len(rows), 1) if rows else None,
            "weighted_success_percent": round(success * 100, 1) if success is not None else None,
            "p50_ms": round(p50, 1) if p50 is not None else None,
            "p95_ms": round(p95, 1) if p95 is not None else None,
            "jitter_ms": round(p95 - p50, 1) if p95 is not None else None,
            "components": components, "notes": list(dict.fromkeys(notes)), "scope": "public_path",
            "codex_observed": observed, "services": services, "caps": caps,
            "coverage": "complete" if coverage else "partial", "span_seconds": round(span, 1),
            "last_sample_at": last_at, "sample_age_seconds": round(now - last_at, 1) if last_at is not None else None,
            "raw_value": raw_value, "method_version": METHOD_VERSION}
