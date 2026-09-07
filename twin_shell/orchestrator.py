from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
from typing import Any


from .app_server import AppServerClient, AppServerError
from .activity import ActivityFeed
from .runtime_observer import LocalRuntimeObserver
from .weekly_quota import weekly_quota, primary_usage
from .semantic_summary import CodexSummaryEngine, TaskSummaries
from .platform_support import data_directory, open_codex_thread


ROOT = Path(__file__).resolve().parents[1]
_legacy_state = ROOT / "data/work_twin_shell_state.json"
DEFAULT_STATE_PATH = (_legacy_state if not getattr(sys, "frozen", False)
                      and not os.environ.get("MONKEX_DATA_DIR") and _legacy_state.is_file()
                      else data_directory() / "state.json")
WORKSPACE_TYPES = {
    "product_creator_or_tool",
    "course_or_delivery",
    "work",
    "media",
    "other",
}
APPROVAL_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
}
USER_INPUT_METHOD = "tool/requestUserInput"


class WorkTwinShellError(RuntimeError):
    """Raised when the work-twin shell rejects or cannot complete an action."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _status_type(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("type") or "unknown")
    return "unknown"


class EventHub:
    """In-memory fan-out for browser SSE connections."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: set[queue.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        subscriber: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=128)
        with self._lock:
            self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                try:
                    subscriber.get_nowait()
                    subscriber.put_nowait(event)
                except queue.Empty:
                    continue


class WorkTwinShell:
    """Codex-first orchestrator exposed by the local workbench."""

    def __init__(
        self,
        *,
        state_path: Path = DEFAULT_STATE_PATH,
        client: AppServerClient | None = None,
        usage_poll_seconds: float = 30.0,
        runtime_observer: LocalRuntimeObserver | None = None,
    ) -> None:
        self.state_path = state_path.expanduser().resolve()
        self.events = EventHub()
        self._state_lock = threading.RLock()
        self._pending_lock = threading.RLock()
        self._state = self._load_state()
        self._pending_requests: dict[str, dict[str, Any]] = {}
        self._active_turns: dict[str, str] = {}
        self._connected_threads: set[str] = set()
        self._send_lock = threading.Lock()
        self._feed_lock = threading.Lock()
        self._feed_snapshot: dict[str, Any] = {"threads": [], "loading": True}
        self._feed_at = 0.0
        self._stop_event = threading.Event()
        self._usage_poll_seconds = usage_poll_seconds
        self._usage_snapshot: dict[str, Any] | None = None
        self.client = client or AppServerClient(on_message=self._on_app_server_message)
        # Fixture clients stay isolated from the user's actual local history.
        self.runtime_observer = runtime_observer or (LocalRuntimeObserver(Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))) if client is None else None)
        if client is not None:
            self.client.on_message = self._on_app_server_message
        self._usage_thread: threading.Thread | None = None
        self._feed_thread: threading.Thread | None = None
        ai_enabled = os.environ.get("MONKEX_AI_SUMMARIES", "0" if getattr(sys, "frozen", False) else "1") == "1"
        self.summaries = TaskSummaries(CodexSummaryEngine() if client is None and ai_enabled else None,
            on_update=lambda: self.events.publish({"type": "summaries_updated", "at": _utc_now()}))
        self.feed = ActivityFeed(self)

    def start(self) -> None:
        try:
            self.client.start()
        except (AppServerError, OSError):
            # The observer window remains available for installation/login help.
            self.client.close()
        # Informational usage polling runs outside the UI startup path.
        self._stop_event.clear()
        self.summaries.start()
        self._usage_thread = threading.Thread(
            target=self._usage_loop,
            name="work-twin-usage-info",
            daemon=True,
        )
        self._usage_thread.start()
        self._feed_thread = threading.Thread(target=self._feed_loop, name="work-twin-activity", daemon=True)
        self._feed_thread.start()
        self.events.publish({"type": "shell_ready", "at": _utc_now()})

    def close(self) -> None:
        self._stop_event.set()
        self.summaries.close()
        self.client.close()

    def health(self) -> dict[str, Any]:
        with self._state_lock:
            shell_task_count = len(self._state["tasks"])
        usage = deepcopy(self._usage_snapshot)
        return {
            "app_server": "online" if self.client.running else "offline",
            "shell_task_count": shell_task_count,
            "usage": usage,
            "usage_stop_percent": None,
            "usage_blocked": False,
            "personal_usage_limit": "disabled_by_user",
            "execution_mode": "codex_supervised",
            "old_monitoring_services": "disabled",
            "at": _utc_now(),
        }

    def predict_route(self, instruction: str, workspace_type: str = "other") -> dict[str, Any]:
        clean_instruction = instruction.strip()
        if not clean_instruction:
            raise WorkTwinShellError("任务说明不能为空")
        if workspace_type not in WORKSPACE_TYPES:
            raise WorkTwinShellError("工作区类型无效")
        command = [
            "python3",
            "-B",
            str(ROOT / "scripts" / "work_twin_distiller.py"),
            "predict",
            "--workspace-type",
            workspace_type,
        ]
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        completed = subprocess.run(
            command,
            cwd=ROOT,
            env=environment,
            input=clean_instruction,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if completed.returncode != 0:
            raise WorkTwinShellError("工作分身路由器运行失败")
        try:
            prediction = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise WorkTwinShellError("工作分身路由结果损坏") from error
        method = dict(prediction.get("method_guidance") or {})
        selected = str(method.get("selected_method") or "")
        method["skill_available"] = bool(self._skill_path(selected))
        return {
            "model_version": prediction.get("model_version"),
            "recommended_contract": prediction.get("recommended_contract"),
            "authority": prediction.get("authority"),
            "method_guidance": method,
            "outcome_guidance": prediction.get("outcome_guidance"),
            "project_contract_guidance": prediction.get("project_contract_guidance"),
            "input_persisted": False,
        }

    def start_task(
        self,
        *,
        instruction: str,
        cwd: str,
        workspace_type: str = "other",
    ) -> dict[str, Any]:
        project_path = self._validate_project_path(cwd)
        clean_instruction = instruction.strip()
        if not clean_instruction:
            raise WorkTwinShellError("任务说明不能为空")
        usage = deepcopy(self._usage_snapshot or {})
        route = self.predict_route(clean_instruction, workspace_type)
        method = dict(route.get("method_guidance") or {})
        selected_method = str(method.get("selected_method") or "")
        skill_path = self._skill_path(selected_method)
        route_status = str(method.get("status") or "unresolved")
        invoke_skill = bool(
            skill_path
            and route_status in {"user_confirmed", "historically_supported"}
        )
        thread_response = self.client.request(
            "thread/start",
            {
                "cwd": str(project_path),
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "developerInstructions": self._developer_instructions(),
                "threadSource": "work_twin_shell",
                "runtimeWorkspaceRoots": [str(project_path)],
            },
        )
        thread = self._result_or_raise(thread_response, "创建 Codex 任务").get("thread")
        if not isinstance(thread, dict) or not thread.get("id"):
            raise WorkTwinShellError("Codex 没有返回任务 ID")
        thread_id = str(thread["id"])
        text = clean_instruction
        inputs: list[dict[str, Any]] = []
        if invoke_skill and skill_path is not None:
            text = f"${selected_method} {clean_instruction}"
            inputs.append(
                {"type": "skill", "name": selected_method, "path": str(skill_path)}
            )
        inputs.insert(0, {"type": "text", "text": text})
        now = _utc_now()
        task = {
            "thread_id": thread_id,
            "cwd": str(project_path),
            "workspace_type": workspace_type,
            "project_archetype": str(method.get("project_archetype") or "unknown"),
            "selected_method": selected_method or "project_specific_method_unresolved",
            "method_status": route_status,
            "skill_invoked": invoke_skill,
            "last_turn_id": None,
            "last_status": "starting",
            "created_at": now,
            "updated_at": now,
            "usage_at_start": usage.get("used_percent"),
        }
        with self._state_lock:
            self._state["tasks"][thread_id] = task
            self._save_state()
        self._connected_threads.add(thread_id)
        try:
            turn_response = self.client.request(
                "turn/start",
                {
                    "threadId": thread_id,
                    "input": inputs,
                    "cwd": str(project_path),
                    "approvalPolicy": "on-request",
                    "sandboxPolicy": {
                        "type": "workspaceWrite",
                        "writableRoots": [str(project_path)],
                        "networkAccess": True,
                    },
                    "summary": "concise",
                },
            )
            turn = self._result_or_raise(turn_response, "启动 Codex 回合").get("turn")
            if not isinstance(turn, dict) or not turn.get("id"):
                raise WorkTwinShellError("Codex 没有返回回合 ID")
        except Exception:
            with self._state_lock:
                self._state["tasks"][thread_id]["last_status"] = "start_uncertain"
                self._save_state()
            raise
        turn_id = str(turn["id"])
        returned_status = _status_type(turn.get("status"))
        normalized_status = {
            "inProgress": "running",
            "active": "running",
            "completed": "completed",
            "failed": "failed",
            "interrupted": "interrupted",
        }.get(returned_status, "running")
        with self._state_lock:
            stored_task = self._state["tasks"][thread_id]
            stored_task["last_turn_id"] = turn_id
            if stored_task.get("last_status") == "starting":
                stored_task["last_status"] = normalized_status
            stored_task["updated_at"] = _utc_now()
            task = deepcopy(stored_task)
            self._save_state()
        if task["last_status"] not in {"completed", "failed", "interrupted"}:
            self._active_turns.setdefault(thread_id, turn_id)
        self.events.publish(
            {
                "type": "task_started",
                "thread_id": thread_id,
                "method": task["selected_method"],
                "at": now,
            }
        )
        return {"thread": thread, "turn": turn, "route": route, "task": task}

    def list_threads(self, *, limit: int = 60) -> dict[str, Any]:
        if self._feed_thread is None:
            with self._feed_lock:
                self._feed_snapshot = self.feed.collect()
                self._feed_at = time.time()
        with self._feed_lock:
            result = deepcopy(self._feed_snapshot)
        for card in result.get("threads", []):
            card.update(self.summaries.view(card["id"]))
        result["health"] = self.health()
        result["observed_at"] = self._feed_at or None
        result["stale"] = bool(self._feed_at and time.time() - self._feed_at > 30)
        if result.get("error") or result["stale"] or not self.client.running:
            for card in result.get("threads", []):
                if card.get("status") == "running":
                    card.update(status="unknown", stage="状态待同步", can_interrupt=False)
        return result

    def _feed_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                result = self.feed.collect()
                with self._feed_lock:
                    self._feed_snapshot = result
                    self._feed_at = time.time()
                self.events.publish({"type": "feed_updated", "at": _utc_now()})
            except Exception:
                with self._feed_lock:
                    self._feed_snapshot["error"] = ("任务同步暂时中断，保留上次观测结果" if self.client.running
                        else "请安装并登录 Codex；找不到程序时设置 MONKEX_CODEX_PATH 后重启 Monkex")
                    self._feed_snapshot["loading"] = False
            self._stop_event.wait(8)

    def read_thread(self, thread_id: str) -> dict[str, Any]:
        return self.feed.detail(thread_id, force=True)

    def acknowledge_result(self, thread_id: str, version: str) -> dict[str, Any]:
        self.feed.acknowledge(thread_id, version)
        with self._feed_lock:
            for card in self._feed_snapshot.get("threads", []):
                if card.get("id") == thread_id and card.get("pending_result_version") == version:
                    card["unread"] = False
                    card["pending_result_version"] = None
        return {"ok": True}

    def open_thread(self, thread_id: str) -> dict[str, Any]:
        import re
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", thread_id):
            raise WorkTwinShellError("任务 ID 无效")
        self._result_or_raise(self.client.request("thread/read", {"threadId": thread_id, "includeTurns": False}), "定位原任务")
        # This route is present in the installed desktop application's URL handler.
        open_codex_thread(thread_id)
        return {"ok": True}

    def send_message(
        self, thread_id: str, message: str, *,
        request_id: str, context_version: str, suggestion_id: str | None = None,
    ) -> dict[str, Any]:
        import re
        # Reject cached pre-removal clients explicitly. Retire with the legacy
        # HTTP suggestion_id field; never reinterpret it as a typed message.
        if suggestion_id is not None:
            raise WorkTwinShellError("下一步推荐已移除，请刷新窗口后自行输入")
        clean_message = message.strip()
        if not clean_message or len(clean_message) > 20000:
            raise WorkTwinShellError("请输入 1–20000 字的消息")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{8,100}", request_id):
            raise WorkTwinShellError("发送请求 ID 无效")
        digest = hashlib.sha256((thread_id + "\n" + clean_message).encode()).hexdigest()
        with self._send_lock:
            previous = self._state["outbox"].get(request_id)
            if previous:
                if previous["digest"] != digest:
                    raise WorkTwinShellError("请求 ID 已用于另一条消息")
                if previous["status"] == "accepted":
                    return {"accepted": True, "duplicate": True, "thread_id": thread_id, "turn_id": previous.get("turn_id")}
                raise WorkTwinShellError("这条消息的发送状态待核对，请先查看原任务；系统不会重复发送")
            if thread_id not in self._connected_threads:
                raise WorkTwinShellError("这是桌面原任务，运行状态尚未确认。请打开原任务继续，草稿会保留")
            if any(r.get("thread_id") == thread_id and r.get("status") in {"pending", "uncertain"} for r in self._state["outbox"].values()):
                raise WorkTwinShellError("这个任务有一条发送状态待核对的消息，请先在原任务确认；自动重发已锁定")
            detail = self.feed.detail(thread_id, force=True)
            if not context_version or detail["card"]["context_version"] != context_version:
                raise WorkTwinShellError("任务已有新变化，请查看最新结果后再发送")
            if any(p.get("thread_id") == thread_id for p in self.pending_requests()):
                raise WorkTwinShellError("请先处理这个任务的审批或问题")
            record = {"thread_id": thread_id, "digest": digest, "status": "pending", "at": _utc_now()}
            with self._state_lock:
                self._state["outbox"][request_id] = record
                self._save_state()
            try:
                active_turn_id = self._active_turns.get(thread_id)
                if active_turn_id:
                    result = self._result_or_raise(self.client.request("turn/steer", {
                        "threadId": thread_id, "expectedTurnId": active_turn_id,
                        "input": [{"type": "text", "text": clean_message}],
                    }), "追加 Codex 指令")
                    turn_id = result.get("turnId") or active_turn_id
                else:
                    thread = self._ensure_loaded(thread_id)
                    cwd = self._validate_project_path(str(thread.get("cwd") or ""))
                    result = self._result_or_raise(self.client.request("turn/start", {
                        "threadId": thread_id, "input": [{"type": "text", "text": clean_message}],
                        "cwd": str(cwd), "approvalPolicy": "on-request", "summary": "concise",
                        "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": [str(cwd)], "networkAccess": True},
                    }), "继续 Codex 对话")
                    turn = result.get("turn") or {}
                    turn_id = turn.get("id")
                    if not turn_id:
                        raise WorkTwinShellError("未收到回合回执，请先核对原任务")
                    # Preserve terminal events that arrived before the response.
                    returned_status = _status_type(turn.get("status"))
                    if returned_status in {"completed", "failed", "interrupted"}:
                        self._active_turns.pop(thread_id, None)
                        self._update_task(thread_id, last_turn_id=turn_id, last_status=returned_status)
                    elif self._state["tasks"].get(thread_id, {}).get("last_turn_id") != turn_id:
                        self._active_turns[thread_id] = turn_id
                        self._update_task(thread_id, last_turn_id=turn_id, last_status="running")
                with self._state_lock:
                    record.update(status="accepted", turn_id=turn_id)
                    self._save_state()
                self.feed.cache.pop(thread_id, None)
                return {"accepted": True, "thread_id": thread_id, "turn_id": turn_id}
            except Exception:
                with self._state_lock:
                    record["status"] = "uncertain"
                    self._save_state()
                raise

    def interrupt(self, thread_id: str) -> dict[str, Any]:
        turn_id = self._active_turns.get(thread_id)
        if not turn_id:
            raise WorkTwinShellError("这个任务当前没有运行中的回合")
        response = self.client.request(
            "turn/interrupt", {"threadId": thread_id, "turnId": turn_id}
        )
        result = self._result_or_raise(response, "停止 Codex 回合")
        self._update_task(thread_id, last_status="interrupted")
        return result

    def pending_requests(self) -> list[dict[str, Any]]:
        with self._pending_lock:
            return [deepcopy(value) for value in self._pending_requests.values()]

    def respond_to_request(
        self,
        request_id: str,
        *,
        decision: str | None = None,
        answers: dict[str, list[str]] | None = None,
    ) -> None:
        with self._pending_lock:
            pending = self._pending_requests.pop(request_id, None)
        if pending is None:
            raise WorkTwinShellError("等待项已失效")
        method = str(pending.get("method") or "")
        if method in APPROVAL_METHODS:
            if decision not in {"accept", "acceptForSession", "decline", "cancel"}:
                raise WorkTwinShellError("审批选择无效")
            self.client.respond(pending["rpc_id"], result={"decision": decision})
        elif method == USER_INPUT_METHOD:
            if not isinstance(answers, dict):
                raise WorkTwinShellError("需要提供问题答案")
            payload = {
                "answers": {
                    key: {"answers": [str(value) for value in values]}
                    for key, values in answers.items()
                }
            }
            self.client.respond(pending["rpc_id"], result=payload)
        else:
            self.client.respond(
                pending["rpc_id"],
                error={"code": -32002, "message": "Work Twin Shell 未授权此交互"},
            )
        self.events.publish(
            {
                "type": "user_gate_resolved",
                "request_id": request_id,
                "thread_id": pending.get("thread_id"),
                "at": _utc_now(),
            }
        )

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.is_file():
            return {"schema_version": 2, "settings": {}, "tasks": {}, "observations": {}, "outbox": {}}
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise WorkTwinShellError("工作分身壳子状态损坏") from error
        if not isinstance(value, dict) or value.get("schema_version") not in {1, 2}:
            raise WorkTwinShellError("工作分身壳子状态版本不兼容")
        value["schema_version"] = 2
        for key in ("settings", "tasks", "observations", "outbox"):
            if not isinstance(value.setdefault(key, {}), dict):
                raise WorkTwinShellError("工作分身壳子状态结构损坏")
        value["settings"].pop("stop_percent", None)
        return value

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self._state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        os.replace(temporary, self.state_path)

    def _refresh_usage(self) -> dict[str, Any]:
        response = None
        try:
            response = self.client.request("account/rateLimits/read", None)
            usage = primary_usage(response)
        except Exception:
            usage = {"used_percent": None, "available": False}
        usage["weekly"] = weekly_quota(response)
        self._usage_snapshot = usage
        return deepcopy(self._usage_snapshot)

    def _usage_loop(self) -> None:
        while not self._stop_event.is_set():
            self._refresh_usage()
            if self._stop_event.wait(self._usage_poll_seconds):
                break

    def _on_app_server_message(self, message: dict[str, Any]) -> None:
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        rpc_id = message.get("id")
        if rpc_id is not None and method:
            request_id = f"rpc-{rpc_id}"
            pending = {
                "request_id": request_id,
                "rpc_id": rpc_id,
                "method": method,
                "thread_id": params.get("threadId"),
                "turn_id": params.get("turnId"),
                "params": params,
                "created_at": _utc_now(),
            }
            with self._pending_lock:
                self._pending_requests[request_id] = pending
            self.events.publish(
                {
                    "type": "user_gate_required",
                    "request_id": request_id,
                    "thread_id": params.get("threadId"),
                    "method": method,
                    "at": pending["created_at"],
                }
            )
            return
        thread_id = str(params.get("threadId") or "")
        if method == "turn/started":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
            turn_id = str(turn.get("id") or "")
            if thread_id and turn_id:
                self._active_turns[thread_id] = turn_id
                self._update_task(thread_id, last_turn_id=turn_id, last_status="running")
        elif method == "turn/completed":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
            turn_id = str(turn.get("id") or "")
            if thread_id:
                self._active_turns.pop(thread_id, None)
                self._update_task(
                    thread_id,
                    last_turn_id=turn_id or None,
                    last_status=str(turn.get("status") or "completed"),
                )
        elif method == "shell/appServerDisconnected":
            self._active_turns.clear()
            self._connected_threads.clear()
            self.feed.cache.clear()
            with self._pending_lock:
                self._pending_requests.clear()
        if thread_id and method in {"turn/started", "turn/completed", "item/completed"}:
            self.feed.cache.pop(thread_id, None)
        self.events.publish(
            {"type": "codex_event", "method": method, "params": params, "at": _utc_now()}
        )

    def _update_task(self, thread_id: str, **values: Any) -> None:
        with self._state_lock:
            task = self._state["tasks"].get(thread_id)
            if not isinstance(task, dict):
                return
            for key, value in values.items():
                if value is not None:
                    task[key] = value
            task["updated_at"] = _utc_now()
            self._save_state()

    def _ensure_loaded(self, thread_id: str) -> dict[str, Any]:
        read = self.client.request(
            "thread/read", {"threadId": thread_id, "includeTurns": False}
        )
        thread = self._result_or_raise(read, "读取 Codex 任务").get("thread")
        if not isinstance(thread, dict):
            raise WorkTwinShellError("Codex 任务数据无效")
        if _status_type(thread.get("status")) == "notLoaded":
            resumed = self.client.request("thread/resume", {"threadId": thread_id})
            thread = self._result_or_raise(resumed, "恢复 Codex 任务").get("thread")
            if not isinstance(thread, dict):
                raise WorkTwinShellError("Codex 无法恢复任务")
        return thread

    @staticmethod
    def _validate_project_path(value: str) -> Path:
        if not value.strip():
            raise WorkTwinShellError("项目目录不能为空")
        project_path = Path(value).expanduser().resolve()
        if not project_path.is_dir():
            raise WorkTwinShellError("项目目录不存在")
        if project_path == Path("/") or project_path == Path.home():
            raise WorkTwinShellError("请选择具体项目目录，不能把系统根目录或用户主目录作为项目")
        return project_path

    @staticmethod
    def _skill_path(method: str) -> Path | None:
        from twin_core.v10_method_distillation import METHOD_IDS
        if method not in METHOD_IDS or method == "direct_codex":
            return None
        candidates = [
            Path.home() / ".codex" / "skills" / method / "SKILL.md",
            Path.home() / ".codex" / "skills" / ".system" / method / "SKILL.md",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return candidate.resolve()
        return None

    @staticmethod
    def _developer_instructions() -> str:
        return (
            "你由 Zinx 工作分身容器驱动，Codex 是唯一项目执行器。"
            "先完整读取项目中的 AGENTS.md、README、PROJECT_STATE、规格与当前任务相关权威文件。"
            "在当前目录和当前任务范围内自主完成可逆工作，持续验证用户可见结果；方法路由不能扩大任务范围。"
            "登录、身份、验证码、付款、协议签署、最终发布、正式提交、领奖、不可恢复删除和最终产品方向必须停止并请求用户。"
            "严格区分本地实现、已验证、已上传、草稿、已发布和已提交。"
            "需要用户选择时只提出一个高价值问题；其他普通选择依据当前规格、项目证据和历史方法继续执行。"
            "进度简短可见，完成声明必须附带测试、渲染、回执或可定位产物证据。"
        )

    @staticmethod
    def _result_or_raise(response: dict[str, Any], action: str) -> dict[str, Any]:
        error = response.get("error")
        if error is not None:
            message = error.get("message") if isinstance(error, dict) else str(error)
            raise WorkTwinShellError(f"{action}失败：{message}")
        result = response.get("result")
        if not isinstance(result, dict):
            raise WorkTwinShellError(f"{action}失败：返回结果无效")
        return result

    @staticmethod
    def _present_thread(thread: dict[str, Any]) -> dict[str, Any]:
        presented_turns = []
        for turn in list(thread.get("turns") or [])[-16:]:
            if not isinstance(turn, dict):
                continue
            items = []
            for item in turn.get("items") or []:
                if not isinstance(item, dict):
                    continue
                item_type = str(item.get("type") or "unknown")
                if item_type == "reasoning":
                    continue
                if item_type == "userMessage":
                    items.append({"type": item_type, "content": item.get("content")})
                elif item_type == "agentMessage":
                    items.append(
                        {"type": item_type, "text": item.get("text"), "phase": item.get("phase")}
                    )
                elif item_type == "commandExecution":
                    items.append(
                        {
                            "type": item_type,
                            "command": item.get("command"),
                            "status": item.get("status"),
                            "exit_code": item.get("exitCode"),
                        }
                    )
                elif item_type == "fileChange":
                    changes = item.get("changes") if isinstance(item.get("changes"), list) else []
                    items.append(
                        {"type": item_type, "status": item.get("status"), "change_count": len(changes)}
                    )
                else:
                    items.append(
                        {
                            "type": item_type,
                            "status": item.get("status"),
                            "name": item.get("name"),
                            "query": item.get("query"),
                        }
                    )
            presented_turns.append(
                {
                    "id": turn.get("id"),
                    "status": turn.get("status"),
                    "started_at": turn.get("startedAt"),
                    "completed_at": turn.get("completedAt"),
                    "items": items,
                }
            )
        return {
            "id": thread.get("id"),
            "name": thread.get("name") or thread.get("preview") or "未命名任务",
            "cwd": thread.get("cwd"),
            "status": _status_type(thread.get("status")),
            "updated_at": thread.get("updatedAt"),
            "turns": presented_turns,
        }
