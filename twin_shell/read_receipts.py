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
        self.authoritative = False

    def snapshot(self) -> set[str] | None:
        self.authoritative = False
        try:
            if self.path.stat().st_size > 8 * 1024 * 1024:
                return None
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if "electron-thread-read-state-v1" in payload:
                state = payload["electron-thread-read-state-v1"]
                if not isinstance(state, dict) or state.get("version") != 1:
                    return None
                identities = state.get("unreadByIdentity")
                # A single identity/local scope is unambiguous. Multiple saved
                # accounts/hosts require an authenticated scope resolver; never
                # union their unread lists or interpret their absence as read.
                if not isinstance(identities, dict) or len(identities) != 1:
                    return None
                hosts = next(iter(identities.values()))
                if not isinstance(hosts, dict):
                    return None
                local = [value for key, value in hosts.items() if re.fullmatch(r"local:[a-f0-9]{64}", key)]
                if len(local) != 1:
                    return None
                ids = local[0]
                self.authoritative = True
            else:
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
            if self.authoritative:
                blue_dot = card["id"] in unread
                if version and blue_dot:
                    entry["codex_unread_version"] = version
                elif version:
                    # Both transitions follow the same authoritative desktop
                    # snapshot; a subsequent blue dot can restore unread state.
                    entry["ack_version"] = version
                    entry.pop("codex_unread_version", None)
                card["unread"] = bool(version and (blue_dot or version != entry.get("ack_version")))
                card["pending_result_version"] = version if card["unread"] else None
                changed |= before != entry
                continue
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
