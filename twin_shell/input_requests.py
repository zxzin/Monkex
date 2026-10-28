"""Bounded, content-free state for Codex's structured asynchronous questions.

Only AgentMessage.questions and matching user reply envelopes contribute. Tool
acceptance receipts describe delivery; they leave the questions awaiting a reply.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import math
import re
from typing import Any


MAX_CALLS = 128
MAX_QUESTIONS = 32
MAX_REPLY_BYTES = 64 * 1024
REPLY = re.compile(r"\s*<send_user_message_question_reply>([\s\S]*)</send_user_message_question_reply>\s*")


def _id(value: Any) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= 256 and value.isprintable() else None


def unknown_input(*, turn_id=None, observed_at=None):
    return {"pending": False, "count": 0, "available": False, "turn_id": turn_id,
            "source": "structured_questions", "observed_at": observed_at, "target": None}


def pending_input(card, now):
    value = card.get("input_request")
    if not isinstance(value, dict) or value.get("pending") is not True or value.get("available") is not True:
        return False
    at, count = value.get("observed_at"), value.get("count")
    return bool(card.get("latest_turn_id") and value.get("turn_id") == card["latest_turn_id"]
                and isinstance(at, (float, int)) and not isinstance(at, bool) and math.isfinite(at)
                and 0 <= now-at <= 30 and type(count) is int and 0 < count <= MAX_CALLS * MAX_QUESTIONS
                and not card.get("sync_pending"))


def reply_ids(content):
    """Parse a whole user reply envelope, retaining only exact question IDs."""
    if not isinstance(content, list):
        return set()
    chunks = [part.get("text") for part in content
              if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)]
    if sum(len(part) for part in chunks) > MAX_REPLY_BYTES:
        return set()
    text = "\n".join(chunks)
    # Codex strips its explicit user-request context header before decoding the
    # reply. Arbitrary quoted text and tool outputs remain outside this path.
    text = text.rsplit("\n## My request:\n", 1)[-1]
    matched = REPLY.fullmatch(text)
    if not matched:
        return set()
    try:
        values = json.loads(matched[1])
        if isinstance(values, dict):
            values = [values]
        if not isinstance(values, list) or not values or len(values) > MAX_CALLS * MAX_QUESTIONS:
            return set()
        if any(not isinstance(value, dict) or any(not isinstance(value.get(key), str)
               for key in ("questionItemId", "question", "answer")) for value in values):
            return set()
        result = set()
        for value in values:
            encoded = value.get("questionItemId") if isinstance(value, dict) else None
            if not isinstance(encoded, str) or len(encoded) > 512:
                continue
            key = json.loads(encoded)
            if (isinstance(key, list) and len(key) == 3 and key[0] == "request_user_input_async"
                    and _id(key[1]) and type(key[2]) is int and 0 <= key[2] < MAX_QUESTIONS):
                result.add((key[1], key[2]))
        return result
    except (ValueError, TypeError, RecursionError):
        return set()


@dataclass
class InputRequests:
    questions: set[tuple[str, int]] = field(default_factory=set)
    answered: set[tuple[str, int]] = field(default_factory=set)
    question_order: list[tuple[str, int]] = field(default_factory=list)
    complete: bool = False

    def observe(self, item: Any) -> None:
        if not isinstance(item, dict):
            return
        kind = item.get("type")
        normalized = kind[:1].lower() + kind[1:] if isinstance(kind, str) else ""
        if normalized == "agentMessage":
            questions, call_id = item.get("questions"), _id(item.get("id"))
            if call_id and isinstance(questions, list) and 0 < len(questions) <= MAX_QUESTIONS:
                if all(isinstance(question, dict) and isinstance(question.get("title"), str) for question in questions):
                    for index in range(len(questions)):
                        key = (call_id, index)
                        if key not in self.questions:
                            self.question_order.append(key)
                            self.questions.add(key)
        elif normalized == "userMessage":
            self.answered.update(reply_ids(item.get("content")))
        elif normalized == "steeringUserMessage" and item.get("status") == "accepted":
            self.answered.update(reply_ids(item.get("input")))
        self._bound()

    def _bound(self):
        if len({call for call, _ in self.questions | self.answered}) > MAX_CALLS:
            # Exceeding the supported history bound makes absence unconfirmed.
            self.questions.clear()
            self.answered.clear()
            self.question_order.clear()
            self.complete = False

    @classmethod
    def from_items(cls, items):
        state = cls(complete=isinstance(items, list))
        if isinstance(items, list):
            for item in items:
                state.observe(item)
        return state

    def merge(self, other):
        # A complete API turn supplies canonical item order; append newer local
        # questions missing from that snapshot without duplicating any identity.
        first, rest = (other.question_order, self.question_order) if other.complete else (self.question_order, other.question_order)
        self.question_order = list(dict.fromkeys([*first, *rest]))
        self.questions.update(other.questions)
        self.answered.update(other.answered)
        self.complete = self.complete or other.complete
        self._bound()

    def snapshot(self, *, turn_id, observed_at, available=True, active=True):
        pending = self.questions - self.answered if active else set()
        first = next((key for key in self.question_order if key in pending), None)
        count = len(pending)
        target = {"turn_id": turn_id, "question_id": json.dumps(["request_user_input_async", *first], separators=(",", ":"), ensure_ascii=False)} if first else None
        return {"pending": bool(count), "count": count,
                "available": bool(available and (self.complete or count or not active)),
                "turn_id": turn_id, "source": "structured_questions", "observed_at": observed_at, "target": target}
