"""Read-only runtime evidence and small, credential-free public HTTPS probes.

The probes measure this process's public HTTPS path. They cannot measure model
decoding, identify a VPN, or establish the cause of an individual slow turn.
All history is bounded and memory-only; requests use fixed public destinations.
"""
from __future__ import annotations

from collections import deque
from copy import deepcopy
import json
import hashlib
import ipaddress
import math
import os
import socket
import ssl
import statistics
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener, getproxies


from .health_score import score_runtime_health

PROBES = {"general": "https://www.microsoft.com/favicon.ico",
          "codex": "https://chatgpt.com/backend-api/codex/responses",
          "api": "https://api.openai.com/v1/models",
          "auth": "https://auth.openai.com/.well-known/openid-configuration"}
EXPECTED_STATUS = {"general": {200, 204}, "codex": {401, 405}, "api": {401}, "auth": {200}}
STATUS_URL = "https://status.openai.com/api/v2/summary.json"
TRACE_URL = "https://chatgpt.com/cdn-cgi/trace"
_ROUTE_SALT = os.urandom(32)
CHECK_INTERVAL = 60
CHECK_TTL = 300
QUIET_SECONDS = 180
REQUEST_TIMEOUT = 6
CYCLE_TIMEOUT = 8


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _age(value, now):
    return round(max(0, now - value), 1) if _number(value) and value > 0 and value <= now + 30 else None


def _error_kind(error):
    reason = getattr(error, "reason", error)
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(reason, socket.gaierror):
        return "dns_error"
    if isinstance(reason, ssl.SSLError):
        return "tls_error"
    return "unreachable"


def public_request(url, *, json_body=False, trace_body=False):
    """Measure HTTPS response headers; bound reads and never retain error text."""
    started = time.monotonic()
    method = "HEAD" if url in (PROBES["codex"], PROBES["api"], PROBES["auth"]) else "GET"
    request = Request(url, method=method, headers={"User-Agent": "Monkex-Runtime-Health/1.0", "Accept": "application/json" if json_body else "*/*"})
    try:
        # urllib uses environment/system proxy settings. URLs and credentials
        # are never included in telemetry. A transparent VPN is not detectable.
        with build_opener(ProxyHandler(), _NoRedirect()).open(request, timeout=REQUEST_TIMEOUT) as response:
            latency = round((time.monotonic() - started) * 1000)
            status = response.status
            result = {"state": "reachable", "latency_ms": latency, "http_status": status}
            if json_body:
                content = response.read(256 * 1024 + 1)
                if len(content) > 256 * 1024:
                    return {"state": "invalid_response", "latency_ms": latency, "http_status": status}
                result["body"] = json.loads(content)
            elif trace_body:
                content = response.read(4097)
                if len(content) <= 4096:
                    fields = dict(line.split("=", 1) for line in content.decode("utf-8", "replace").splitlines() if "=" in line)
                    try:
                        address = str(ipaddress.ip_address(fields.get("ip", "")))
                        # Discard the address immediately; the process-salted
                        # fingerprint only detects an exit change in memory.
                        result["route_fingerprint"] = hashlib.sha256(_ROUTE_SALT + address.encode()).hexdigest()
                    except ValueError:
                        pass
            return result
    except HTTPError as error:
        code = error.code
        error.close()
        return {"state": "http_error", "latency_ms": round((time.monotonic()-started)*1000), "http_status": code}
    except (OSError, URLError, ValueError) as error:
        return {"state": "invalid_response" if isinstance(error, ValueError) else _error_kind(error),
                "latency_ms": None, "http_status": None}


def parse_official(body, now):
    """Keep relevant components and active notices, even without component IDs."""
    result = {"state": "unknown", "checked_at": now, "updated_at": None,
              "components": [], "incidents": [], "url": "https://status.openai.com/"}
    if not isinstance(body, dict) or not isinstance(body.get("components"), list):
        return result
    page = body.get("page") or {}
    if isinstance(page, dict) and isinstance(page.get("updated_at"), str):
        result["updated_at"] = page["updated_at"][:64]
    for component in body["components"][:100]:
        if not isinstance(component, dict):
            continue
        name, status = component.get("name"), component.get("status")
        if not isinstance(name, str) or not isinstance(status, str):
            continue
        if "codex" in name.lower() or name.lower() in {"responses", "conversations", "chatgpt work"}:
            result["components"].append({"name": name[:100], "status": status[:50]})
    incidents = body.get("incidents")
    if isinstance(incidents, list):
        for incident in incidents[:20]:
            if not isinstance(incident, dict) or incident.get("status") in {"resolved", "postmortem"}:
                continue
            name, status = incident.get("name"), incident.get("status")
            if isinstance(name, str) and isinstance(status, str):
                result["incidents"].append({"name": name[:350], "status": status[:50]})
    statuses = [c["status"] for c in result["components"]]
    if statuses:
        if any(s in {"degraded_performance", "partial_outage", "major_outage", "under_maintenance"} for s in statuses):
            result["state"] = "degraded"
        elif all(s == "operational" for s in statuses):
            result["state"] = "operational"
    return result


class ConnectionMonitor:
    def __init__(self, *, clock=time.time, request=public_request):
        self.clock, self.request = clock, request
        self._lock = threading.Lock()
        self._checking = False
        self._closed = False
        self._started_at = None
        self._checked_at = None
        self._checks = []
        self._pending_workers = []
        self._history = deque(maxlen=300)
        self._route_fingerprint = None
        self._exit_observed = False
        self._route_generation = 1
        self._node_changed_at = None
        self._round_id = 0
        self._rounds_completed = 0
        self._rounds_planned = 0
        self._stop = threading.Event()
        self._official = {"state": "unknown", "checked_at": None, "updated_at": None,
                          "components": [], "incidents": [], "url": "https://status.openai.com/"}
        self._samples = {key: deque(maxlen=10) for key in PROBES}
        self._failures = {key: 0 for key in PROBES}
        self._route = "direct_or_tunnel"

    def close(self):
        self._stop.set()
        with self._lock:
            self._closed = True

    def request_check(self, *, force=False, reset=False):
        now = self.clock()
        with self._lock:
            cooldown = 10 if force else CHECK_INTERVAL
            self._pending_workers = [worker for worker in self._pending_workers if worker.is_alive()]
            if self._closed or self._checking or self._pending_workers or (self._started_at is not None and now-self._started_at < cooldown):
                return False
            if reset:
                self._reset_samples(now)
            rounds = 6 if reset or not self._history else 1
            self._rounds_completed, self._rounds_planned = 0, rounds
            self._checking, self._started_at = True, now
        threading.Thread(target=self._run, args=(rounds,), name="monkex-public-connection", daemon=True).start()
        return True

    def _reset_samples(self, now):
        self._history.clear()
        self._samples = {key: deque(maxlen=10) for key in PROBES}
        self._failures = {key: 0 for key in PROBES}
        self._checks, self._checked_at = [], None
        self._exit_observed = False
        self._route_generation += 1
        self._node_changed_at = now

    def _run(self, rounds=1):
        try:
            for index in range(rounds):
                if self._stop.is_set():
                    break
                self._round(include_official=index == 0)
                with self._lock:
                    self._rounds_completed = index + 1
                    blocked = any(worker.is_alive() for worker in self._pending_workers)
                if blocked or (index < rounds-1 and self._stop.wait(3)):
                    break
        finally:
            with self._lock:
                self._checking = False

    def _round(self, *, include_official=True):
        results = {}
        result_lock = threading.Lock()
        def probe(key, url):
            try:
                result = self.request(url, json_body=key == "official", **({"trace_body": True} if key == "trace" else {}))
            except Exception:
                result = {"state": "unreachable", "latency_ms": None, "http_status": None}
            with result_lock:
                results[key] = result
        destinations = {**PROBES, "trace": TRACE_URL}
        if include_official:
            destinations["official"] = STATUS_URL
        workers = [threading.Thread(target=probe, args=(key, url), daemon=True)
                   for key, url in destinations.items()]
        try:
            # Proxy addresses can contain credentials: persist only presence.
            proxy_present = any(getproxies().get(key) for key in ("http", "https", "all"))
            for worker in workers:
                worker.start()
            # DNS resolution may outlive socket timeouts. Publish a timeout
            # after eight seconds and retain live worker identities to prevent
            # repeated checks from accumulating threads while the OS resolves.
            deadline = time.monotonic() + CYCLE_TIMEOUT
            for worker in workers:
                worker.join(max(0, deadline-time.monotonic()))
            with result_lock:
                collected = dict(results)
            with self._lock:
                self._pending_workers = [worker for worker in workers if worker.is_alive()]
            now = self.clock()
            fingerprint = (collected.get("trace") or {}).get("route_fingerprint")
            with self._lock:
                if fingerprint and self._route_fingerprint and fingerprint != self._route_fingerprint:
                    self._reset_samples(now)
                if fingerprint:
                    self._route_fingerprint = fingerprint
                self._exit_observed = bool(fingerprint)
                self._round_id += 1
                round_id = self._round_id
            checks = []
            for key in PROBES:
                item = dict(collected.get(key) or {"state": "timeout", "latency_ms": None, "http_status": None})
                transport_ok = item["state"] in {"reachable", "http_error"}
                expected = transport_ok and item.get("http_status") in EXPECTED_STATUS[key]
                if expected:
                    item["state"] = "reachable"
                elif transport_ok:
                    item["state"] = "http_error"
                samples = self._samples[key]
                baseline = statistics.median(samples) if len(samples) >= 3 else None
                latency = item.get("latency_ms")
                if item["state"] == "reachable" and _number(latency):
                    slow = latency > 2500 or (baseline is not None and latency > max(1000, baseline * 3))
                    item["state"] = "slow" if slow else "reachable"
                    samples.append(latency)
                    self._failures[key] = 0
                else:
                    self._failures[key] += 1
                item.update(id=key, failure_streak=self._failures[key], baseline_ms=baseline,
                            median_ms=statistics.median(samples) if samples else None, sample_count=len(samples))
                checks.append(item)
                if key != "general":
                    with self._lock:
                        self._history.append({"at": now, "round_id": round_id, "target": key,
                                              "state": item["state"], "latency_ms": latency,
                                              "http_status": item.get("http_status"),
                                              "transport_ok": transport_ok, "expected_response": expected})
            official_response = collected.get("official") or {"state": "timeout"}
            official = parse_official(official_response.get("body"), now)
            if official_response["state"] != "reachable":
                official["error"] = official_response["state"]
            with self._lock:
                if not self._closed:
                    self._checks, self._checked_at = checks, now
                    if include_official:
                        self._official = official
                    self._route = "system_proxy" if proxy_present else "direct_or_tunnel"
        finally:
            pass

    def snapshot(self):
        now = self.clock()
        with self._lock:
            age = _age(self._checked_at, now)
            network = {"checking": self._checking, "checked_at": self._checked_at,
                       "blocked": any(worker.is_alive() for worker in self._pending_workers),
                       "route_generation": self._route_generation, "node_changed_at": self._node_changed_at,
                       "exit_observed": self._exit_observed and age is not None and age <= CHECK_TTL,
                       "rounds_completed": self._rounds_completed, "rounds_planned": self._rounds_planned,
                       "age_seconds": age, "stale": age is None or age > CHECK_TTL,
                       "route": self._route, "checks": deepcopy(self._checks)}
            official = deepcopy(self._official)
        official_age = _age(official.get("checked_at"), now)
        official["stale"] = official_age is None or official_age > CHECK_TTL
        return network, official

    def score(self, runtime, official):
        with self._lock:
            history = list(self._history)
        return score_runtime_health(history, now=self.clock(), runtime=runtime, official=official)


def _recent_runtime_issue(card, evidence, now):
    """Keep only a recent failure of the card's exact current terminal turn."""
    current_turn = card.get("latest_turn_id")
    if card.get("status") != "failed" or not isinstance(current_turn, str) or not current_turn:
        return None
    observed_turn = evidence.get("turn_id")
    if observed_turn and observed_turn != current_turn:
        return None
    for issue in (card.get("runtime_issue"), evidence.get("runtime_issue")):
        if not isinstance(issue, dict) or issue.get("state") != "error" or issue.get("turn_id") != current_turn:
            continue
        at = issue.get("at")
        if not _number(at) or at <= 0 or not 0 <= now-at <= 300:
            continue
        code = "http_connection_failed" if issue.get("code") == "http_connection_failed" else "task_error"
        return {"id": card.get("id"), "name": str(card.get("name") or "")[:200],
                "state": "error", "code": code, "at": at, "age_seconds": round(now-at, 1),
                "turn_id": current_turn}
    return None


def _operational_state(tasks, *, fresh, issues=()):
    """Describe observed work independently of unauthenticated probe scores.

    An open tool call and a quiet turn establish a waiting condition. They do
    not establish that the tool is alive, that a model is decoding, or that a
    network path failed. A recent event proves only recent activity.
    """
    active = sum(task["signal"] == "active" for task in tasks)
    quiet = [task for task in tasks if task["signal"] == "quiet"]
    unknown = sum(task["signal"] == "unknown" for task in tasks)
    tools = sum(task["pending_tools"] > 0 for task in tasks)
    starting = sum(task["signal"] == "active" and task["phase"] == "starting" for task in tasks)
    evidence = []
    if active:
        evidence.append("recent_runtime_activity")
    if quiet:
        evidence.append("runtime_quiet")
    if tools:
        evidence.append("tool_pending")
    if unknown:
        evidence.append("activity_unconfirmed")
    if starting:
        evidence.append("turn_start_only")
    if issues:
        evidence.append("recent_turn_failure")
    if not fresh:
        state, level, code, affected = "unknown", "unknown", "sync_unavailable", len(tasks)
    elif issues:
        code = "recent_connection_error" if any(issue["code"] == "http_connection_failed" for issue in issues) else "recent_task_error"
        state, level, affected = "error", "error", len(issues)
    elif quiet:
        waiting_tools = all(task["pending_tools"] > 0 for task in quiet)
        state = "tool_running" if waiting_tools else "quiet"
        code = "tool_wait" if waiting_tools else "quiet"
        level, affected = "notice", len(quiet)
    elif unknown:
        state, level, code, affected = "unknown", "unknown", "activity_unconfirmed", unknown
    elif starting:
        state, level, code, affected = "waiting", "notice", "awaiting_response", starting
    elif not tasks:
        state, level, code, affected = "idle", "ok", "idle", 0
    else:
        state = "tool_running" if tools == len(tasks) else "active"
        level, code, affected = "ok", state, 0
    return {"state": state, "level": level, "code": code, "evidence": evidence,
            "affected_tasks": affected, "active_tasks": active, "quiet_tasks": len(quiet),
            "unknown_tasks": unknown, "tool_tasks": tools, "starting_tasks": starting,
            "issue_tasks": len(issues),
            "score_scope": "public_path"}


def _token_signal(*, fresh, total, pending_tools, phase, report_age, activity_age):
    if not fresh:
        return "sync_unavailable"
    if total is None:
        return "awaiting_report"
    if total > 0:
        return "usage_reported"
    if pending_tools:
        return "tool_wait"
    if report_age is None or report_age >= 60:
        return "no_recent_usage_report"
    if phase == "thinking" and activity_age is not None and activity_age < QUIET_SECONDS:
        return "thinking"
    return "report_idle"


def runtime_diagnostics(cards, *, feed_at, connected, observer=None, now=None, network=None, official=None):
    now = time.time() if now is None else now
    age = _age(feed_at, now)
    fresh = bool(connected and age is not None and age <= 30)
    network = network or {"checking": False, "checked_at": None, "stale": True, "checks": []}
    official = official or {"state": "unknown", "stale": True, "components": [], "incidents": []}
    tasks, totals, outputs, buckets, issues = [], [], [], [0] * 12, []
    latest = None
    for card in cards:
        sync_pending = bool(card.get("sync_pending") is True and (
            card.get("status") == "running"
            or (card.get("status") == "unknown" and card.get("last_observed_status") == "running")))
        if card.get("status") not in {"running", "failed"} and not sync_pending:
            continue
        thread_id = card.get("id")
        evidence, tokens = observer.diagnostics_snapshot(thread_id) if observer else (card.get("runtime", {}), card.get("tokens", {}))
        evidence = evidence or {}
        if card.get("status") == "failed":
            issue = _recent_runtime_issue(card, evidence, now) if fresh else None
            if issue:
                issues.append(issue)
            continue
        tokens = tokens or {}
        same_turn = bool(card.get("latest_turn_id") and card["latest_turn_id"] == evidence.get("turn_id"))
        available = same_turn and evidence.get("observation_available") is not False and not sync_pending
        if not fresh or not available:
            evidence, tokens = {}, {}
        observed = max(evidence.get("activity_at") or 0, tokens.get("last_report_at") or 0)
        activity_age = _age(observed, now)
        signal = "unknown" if not fresh or not available or activity_age is None else "quiet" if activity_age >= QUIET_SECONDS else "active"
        if fresh and available and activity_age is not None:
            latest = max(latest or 0, observed)
        total = tokens.get("tokens_per_min") if fresh and available and tokens.get("ready") else None
        output = tokens.get("output_tokens_per_min") if fresh and available and tokens.get("output_ready") else None
        if _number(total):
            totals.append(total)
            values = tokens.get("buckets") or []
            if len(values) == 12 and all(_number(v) for v in values):
                buckets = [a+b for a, b in zip(buckets, values)]
        if _number(output):
            outputs.append(output)
        phase = evidence.get("phase", "unknown") if fresh and available else "unknown"
        pending = evidence.get("pending_tools", 0)
        pending = max(0, int(pending)) if fresh and available and _number(pending) else 0
        report_age = _age(tokens.get("last_report_at"), now)
        tasks.append({"id": thread_id, "name": str(card.get("name") or "")[:200],
                      "phase": phase,
                      "activity_age_seconds": activity_age, "phase_at": evidence.get("phase_at"),
                      "model": evidence.get("model"), "effort": evidence.get("effort"),
                      "tokens_per_min": total, "output_tokens_per_min": output,
                      "last_report_at": tokens.get("last_report_at"),
                      "report_age_seconds": report_age,
                      "signal": signal, "pending_tools": pending, "sync_pending": sync_pending,
                      "token_signal": _token_signal(fresh=fresh and available, total=total, pending_tools=pending,
                                                    phase=phase, report_age=report_age, activity_age=activity_age)})
    tasks.sort(key=lambda t: (t["signal"] != "quiet", -(t["activity_age_seconds"] or 0)))
    quiet = sum(t["signal"] == "quiet" for t in tasks)
    active = sum(t["signal"] == "active" for t in tasks)
    activity = {"state": "unknown" if not fresh else "idle" if not tasks else "quiet" if quiet else "active" if active else "unknown",
                "last_activity_at": latest, "quiet_tasks": quiet, "active_tasks": active,
                "tool_tasks": sum(t["pending_tools"] > 0 for t in tasks),
                "measured_tasks": len(totals), "output_measured_tasks": len(outputs),
                "total_tokens_per_min": round(sum(totals), 1) if totals else None,
                "output_tokens_per_min": round(sum(outputs), 1) if outputs else None, "buckets": buckets}
    codes = []
    if not fresh:
        codes.append("sync_unavailable")
    if not network.get("stale"):
        checks = {c["id"]: c for c in network.get("checks", [])}
        general, openai = checks.get("general", {}), checks.get("codex", checks.get("openai", {}))
        good = {"reachable", "slow", "http_error"}
        if general.get("state") and openai.get("state"):
            if general["state"] not in good and openai["state"] not in good:
                codes.append("network_unavailable")
            elif openai["state"] not in good:
                codes.append("openai_path")
            elif general["state"] not in good:
                codes.append("reference_path")
            elif "http_error" in {general["state"], openai["state"]}:
                codes.append("endpoint_response")
            elif "slow" in {general["state"], openai["state"]}:
                codes.append("connection_slow")
    if not official.get("stale") and (official.get("state") == "degraded" or official.get("incidents")):
        codes.append("service_notice")
    if fresh:
        codes.append("idle" if not tasks else "quiet" if quiet else "active" if active else "waiting")
    issues.sort(key=lambda issue: issue["at"], reverse=True)
    operational = _operational_state(tasks, fresh=fresh, issues=issues)
    if operational["level"] != "ok":
        codes = [operational["code"], *[code for code in codes if code != operational["code"]]]
    code = codes[0]
    level = "unknown" if code == "sync_unavailable" else "warning" if code in {"network_unavailable", "openai_path"} else "notice" if code in {"quiet", "service_notice", "connection_slow", "reference_path", "endpoint_response", "waiting"} else "ok"
    if operational["level"] != "ok":
        level = operational["level"]
    return {"observed_at": now, "feed_age_seconds": age, "data_state": "current" if fresh else "stale",
            "running_tasks": len(tasks), "activity": activity, "tasks": tasks,
            "operational": operational, "recent_issues": issues,
            "network": network, "official": official,
            "assessment": {"level": level, "code": code, "codes": codes}}
