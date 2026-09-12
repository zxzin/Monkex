"""Read-only, bounded cross-project feed with a durable result cursor."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import time
from typing import Any

from .task_view import describe
from .runtime_observer import apply_runtime
from .token_meter import aggregate_project_tokens


SOURCES = ["cli", "vscode", "exec", "appServer", "unknown"]


class ActivityFeed:
    def __init__(self, shell: Any) -> None:
        self.shell = shell
        self.cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self.metadata: dict[str, dict[str, Any]] = {}
        self.project_tokens: dict[str, dict[str, Any]] = {}

    def telemetry(self, card: dict[str, Any]) -> None:
        if self.shell.runtime_observer:
            card["tokens"] = self.shell.runtime_observer.token_snapshot(card["id"])
        card["project_tokens"] = deepcopy(self.project_tokens.get(card.get("cwd")))

    def detail(self, thread_id: str, *, force: bool = False) -> dict[str, Any]:
        observer = self.shell.runtime_observer
        if observer and force:
            observer.refresh([thread_id])
        evidence = observer.snapshot(thread_id) if observer else {}
        cached = self.cache.get(thread_id)
        metadata_time = self.metadata.get(thread_id, {}).get("updatedAt")
        ttl = 8 if thread_id in self.shell._connected_threads else 60
        if not force and cached and time.monotonic() - cached[0] < ttl and cached[1].get("runtime_revision") == evidence.get("revision") and (metadata_time is None or cached[1]["card"].get("updated_at") == metadata_time):
            payload = deepcopy(cached[1])
            self.telemetry(payload["card"])
            return payload
        shell = self.shell
        raw = shell._result_or_raise(shell.client.request("thread/read", {"threadId": thread_id, "includeTurns": False}), "读取任务").get("thread")
        if not isinstance(raw, dict):
            raise ValueError("任务数据无效")
        result = shell._result_or_raise(shell.client.request("thread/turns/list", {"threadId": thread_id, "limit": 6, "sortDirection": "desc", "itemsView": "full"}), "读取最近回合")
        turns = list(reversed(result.get("data") or []))
        raw["turns"] = turns
        # Ownership is a live connection, not a persisted flag from yesterday.
        owned = thread_id in shell._connected_threads
        card = describe(raw, turns, owned=owned)
        card.update({"id": thread_id, "name": raw.get("name") or "未命名任务", "cwd": raw.get("cwd"), "updated_at": raw.get("updatedAt"), "owned_by_shell": owned})
        card["updated_at"] = self.metadata.get(thread_id, {}).get("updatedAt") or card["updated_at"]
        if observer:
            apply_runtime(card, evidence)
        self.telemetry(card)
        self.observe(card)
        payload = {"thread": shell._present_thread(raw), "card": card, "shell": deepcopy(shell._state["tasks"].get(thread_id)), "runtime_revision": evidence.get("revision")}
        self.cache[thread_id] = (time.monotonic(), payload)
        return deepcopy(payload)

    def observe(self, card: dict[str, Any]) -> None:
        shell = self.shell
        with shell._state_lock:
            ledger = shell._state["observations"]
            old = ledger.get(card["id"], {})
            entry = dict(old)
            entry["latest_turn_id"] = card.get("latest_turn_id")
            result_at = card.get("result_completed_at") or 0
            if card.get("has_result") and result_at >= (entry.get("result_completed_at") or 0):
                entry["result_version"] = card["result_version"]
                entry["result_completed_at"] = result_at
                entry["result_turn_id"] = card.get("result_turn_id")
            elif card.get("has_result") and entry.get("result_version"):
                # History can lag behind a confirmed local completion, including
                # after restart. Preserve the durable cursor until history catches up.
                card.update(has_result=True, result_version=entry["result_version"],
                            result_completed_at=entry.get("result_completed_at", 0),
                            result_turn_id=entry.get("result_turn_id"), result_is_latest=False,
                            result_excerpt="新一轮已完成 · 打开 Codex 查看结果")
            if entry != old:
                ledger[card["id"]] = entry
                shell._save_state()
            card["unread"] = bool(entry.get("result_version") and entry.get("result_version") != entry.get("ack_version"))
            card["pending_result_version"] = entry.get("result_version") if card["unread"] else None

    def acknowledge(self, thread_id: str, version: str) -> dict[str, Any]:
        shell = self.shell
        with shell._state_lock:
            entry = shell._state["observations"].get(thread_id, {})
            if not version or entry.get("result_version") != version:
                raise ValueError("结果已更新，请重新查看后再标记")
            harvest = shell.weekly_harvest()
            if entry.get("ack_version") != version:
                previous_entry = deepcopy(entry)
                previous_harvest = deepcopy(shell._state.get("weekly_harvest"))
                harvest["count"] += 1
                entry["ack_version"] = version
                shell._state["weekly_harvest"] = harvest
                try:
                    shell._save_state()
                except Exception:
                    entry.clear()
                    entry.update(previous_entry)
                    if previous_harvest is None:
                        shell._state.pop("weekly_harvest", None)
                    else:
                        shell._state["weekly_harvest"] = previous_harvest
                    raise
        self.cache.pop(thread_id, None)
        return dict(harvest)

    def collect(self) -> dict[str, Any]:
        shell = self.shell
        raw_threads = []
        cursor = None
        seen = set()
        for _ in range(10):
            params = {"limit": 100, "archived": False, "sortKey": "updated_at", "sortDirection": "desc", "sourceKinds": SOURCES, "useStateDbOnly": True}
            if cursor:
                params["cursor"] = cursor
            page = shell._result_or_raise(shell.client.request("thread/list", params), "读取 Codex 任务")
            for raw in page.get("data") or []:
                if raw.get("id") and raw["id"] not in seen:
                    raw_threads.append(raw)
                    seen.add(raw["id"])
            cursor = page.get("nextCursor")
            if not cursor:
                break
        # Hydrate the visible seven-day window, all active tasks, and existing
        # pending results. The first 40 rows retain the cold-start fallback.
        self.metadata = {r["id"]: {"updatedAt": r.get("updatedAt")} for r in raw_threads}
        if shell.runtime_observer:
            shell.runtime_observer.refresh(list(self.metadata))
        hydrate_ids = {r["id"] for r in raw_threads[:40]}
        cutoff = time.time() - 7 * 86400
        hydrate_ids.update(r["id"] for r in raw_threads if isinstance(r.get("updatedAt"), (int, float)) and r["updatedAt"] >= cutoff)
        if shell.runtime_observer:
            for raw in raw_threads:
                evidence = shell.runtime_observer.snapshot(raw["id"])
                if evidence.get("status") == "running" or (evidence.get("event_at") or 0) >= cutoff:
                    hydrate_ids.add(raw["id"])
        with shell._state_lock:
            hydrate_ids.update(k for k, v in shell._state["observations"].items() if v.get("result_version") != v.get("ack_version"))
        def row(raw: dict[str, Any]) -> dict[str, Any]:
            thread_id = raw["id"]
            if thread_id in hydrate_ids:
                try:
                    card = self.detail(thread_id)["card"]
                    # State-db metadata is the authoritative activity ordering.
                    card["updated_at"] = raw.get("updatedAt") or card.get("updated_at")
                    self.observe(card)
                    return card
                except Exception:
                    pass
            card = describe(raw, [], owned=False)
            card.update({"id": thread_id, "name": raw.get("name") or "未命名任务", "cwd": raw.get("cwd"), "updated_at": raw.get("updatedAt"), "owned_by_shell": False, "unread": False})
            if shell.runtime_observer:
                apply_runtime(card, shell.runtime_observer.snapshot(thread_id))
            self.telemetry(card)
            return card
        with ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(row, raw_threads))
        if shell.codex_read_receipts:
            with shell._state_lock:
                if shell.codex_read_receipts.reconcile(shell._state["observations"], rows):
                    shell._save_state()
        rows.sort(key=lambda r: r.get("updated_at") or 0, reverse=True)
        self.project_tokens = aggregate_project_tokens(rows)
        for card in rows:
            card["project_tokens"] = deepcopy(self.project_tokens.get(card.get("cwd")))
        runtime = "local_events" if shell.runtime_observer and not shell.runtime_observer.error else "unconfirmed"
        return {"threads": rows, "next_cursor": cursor, "coverage": {"listed": len(rows), "recent_detail_limit": 40, "detail_window_days": 7, "complete_listing": cursor is None, "external_runtime": runtime}, "health": shell.health()}
