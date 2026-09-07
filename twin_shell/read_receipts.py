"""Read-only adapter for Codex desktop's persisted local unread state.

This private desktop schema is optional. Missing/changed data preserves Monkex
receipts. Absence alone never establishes that an unknown task was viewed.
"""
from pathlib import Path
import json
import re


class CodexReadReceipts:
    def __init__(self, codex_home: Path):
        self.path = codex_home / ".codex-global-state.json"

    def snapshot(self) -> set[str] | None:
        try:
            if self.path.stat().st_size > 8 * 1024 * 1024:
                return None
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            ids = payload["electron-persisted-atom-state"]["unread-thread-ids-by-host-v1"]["local"]
            if not isinstance(ids, list) or any(not isinstance(i, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", i) for i in ids):
                return None
            return set(ids)
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def reconcile(self, ledger: dict, cards: list[dict]) -> bool:
        unread = self.snapshot()
        if unread is None:
            return False
        changed = False
        for card in cards:
            entry = ledger.get(card["id"])
            if not entry:
                continue
            before = dict(entry)
            version = entry.get("result_version")
            if card["id"] in unread:
                # Bind the positive unread observation to this exact result.
                # A later removal can acknowledge this version only.
                if version:
                    entry["codex_unread_version"] = version
            else:
                seen_version = entry.pop("codex_unread_version", None)
                if seen_version and seen_version == version:
                    entry["ack_version"] = seen_version
            changed |= before != entry
            card["unread"] = bool(version and version != entry.get("ack_version"))
            card["pending_result_version"] = version if card["unread"] else None
        return changed
