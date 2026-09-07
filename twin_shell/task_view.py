"""Ephemeral task summaries and evidence-labelled runtime states.

Raw content stays in memory and in the original Codex history. These helpers
never execute historical text or claim that a finished turn passed acceptance.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any


def clean_text(value: str, limit: int = 180) -> str:
    text = str(value or "")
    if "## My request:" in text:
        text = text.rsplit("## My request:", 1)[1]
    text = re.sub(r"<(?:environment_context|in-app-browser-context|heartbeat|system-reminder)[\s\S]*?</(?:environment_context|in-app-browser-context|heartbeat|system-reminder)>", "", text)
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"::[a-zA-Z][a-zA-Z0-9_-]*\{[^}]*\}", "", text)
    text = re.sub(r"<source_thread_id>[\s\S]*?</source_thread_id>", "", text)
    text = re.sub(r"</?(?:codex_delegation|input)>", "", text)
    text = re.sub(r"!?\[([^\]]+)\]\([^\n)]+\)", r"\1", text)
    text = re.sub(r"(?:[A-Za-z]:[\\/]|\\\\)[^\r\n，。；）)]+", "[本机引用]", text)
    text = re.sub(r"(?:https?://|/Users/|/home/|/var/|/tmp/)[^\s，。；）)]+", "[本机引用]", text)
    text = re.sub(r"(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)", "[已隐藏]", text)
    text = re.sub(r"[#*`<>]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def message_text(item: dict[str, Any]) -> str:
    if item.get("type") == "agentMessage":
        return str(item.get("text") or "")
    content = item.get("content") or []
    if isinstance(content, str):
        return content
    return "\n".join(str(p.get("text") or "") for p in content if isinstance(p, dict))


def category_for(text: str, cwd: str) -> tuple[str, str]:
    # Categories are navigation hints; they grant no execution or Skill authority.
    if re.search(r"Course|课程|论文|作业|DOCX|Word|学术", text + cwd, re.I):
        return "course", "课程 / 文档"
    if re.search(r"自媒体|口播|视频|作品集|表情包|贴纸|宣传|剪辑", text + cwd):
        return "content", "内容 / 创作"
    if re.search(r"[/\\]工作[/\\]|市场调研|竞品|专利", text + cwd):
        return "work", "工作 / 研究"
    if re.search(r"软件|开发|代码|构建|bug|app|skill|插件|小程序|产品", text, re.I):
        return "product", "产品 / 开发"
    return "other", "其他"


def describe(thread: dict[str, Any], turns: list[dict[str, Any]], *, owned: bool) -> dict[str, Any]:
    latest = turns[-1] if turns else {}
    items = latest.get("items") or []
    users = [message_text(i) for t in turns for i in t.get("items", []) if i.get("type") == "userMessage"]
    agents = [i for i in items if i.get("type") == "agentMessage"]
    finals = [i for i in agents if i.get("phase") in {"final_answer", "final"}]
    final = message_text(finals[-1]) if finals else (message_text(agents[-1]) if agents and latest.get("status") == "completed" else "")
    meaningful = [clean_text(t, 160) for t in users if len(clean_text(t, 160)) >= 10]
    summary = meaningful[-1] if meaningful else clean_text(thread.get("preview") or "", 160)
    if len(summary) < 10:
        summary = clean_text(thread.get("name") or "内容待核对", 160)
    result_turn = next((t for t in reversed(turns) if t.get("status") == "completed" and any(i.get("type") == "agentMessage" for i in t.get("items", []))), {})
    result_agents = [i for i in result_turn.get("items", []) if i.get("type") == "agentMessage"]
    result_final = next((message_text(i) for i in reversed(result_agents) if i.get("phase") in {"final", "final_answer"}), message_text(result_agents[-1]) if result_agents else "")
    result = clean_text(result_final, 500)
    turn_status = latest.get("status", "unknown")
    runtime = thread.get("status") or {}
    runtime = runtime.get("type") if isinstance(runtime, dict) else runtime
    active = runtime == "active" or (owned and turn_status == "inProgress")
    waiting = bool(re.search(r"(?:请|需要你|等待你|待你).{0,16}(?:确认|补充|提供|选择|授权|登录)|待补.{0,8}(?:数据|材料)|Blocked", final, re.I))
    if active:
        status, stage = "running", "正在推进"
        if agents:
            stage = clean_text(message_text(agents[-1]), 68) or stage
    elif waiting:
        status, stage = "waiting_user", "可能需要你 · 请查看结果"
    elif turn_status == "completed" and final:
        status, stage = "result_ready", "本轮有结果 · 尚未验收"
    elif turn_status in {"failed", "interrupted"}:
        status, stage = turn_status, ("本轮失败" if turn_status == "failed" else "回合已停止") if owned else "上次回合记录 · 当前待确认"
    else:
        status, stage = "unknown", "状态待同步" if not owned else "等待新指令"
    category, label = category_for(summary, str(thread.get("cwd") or ""))
    version = hashlib.sha256((str(latest.get("id")) + str(turn_status) + str(runtime) + final + (message_text(agents[-1]) if agents else "")).encode()).hexdigest()[:24]
    return {
        "summary": summary, "summary_source": "近期指令摘取" if meaningful else "任务摘要",
        "stage": stage, "status": status, "category": category, "category_label": label,
        "project_label": Path(str(thread.get("cwd") or "未关联项目")).name,
        "activity_excerpt": clean_text(final or (message_text(agents[-1]) if agents else summary), 100),
        "progress_excerpt": clean_text(final or (message_text(agents[-1]) if agents else summary), 360),
        "result_is_latest": bool(result_final and result_turn.get("id") == latest.get("id")),
        "result_excerpt": result, "result_version": hashlib.sha256((str(result_turn.get("id")) + result_final).encode()).hexdigest()[:24] if result_final else None,
        "context_version": version, "latest_turn_id": latest.get("id"),
        "has_result": bool(result_final),
        "observation": "实时连接" if owned else "历史快照 · 运行状态未确认",
        "can_send": owned, "can_interrupt": owned and active,
    }
