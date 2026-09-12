# Changelog

## Unreleased — 2026-09-12

- Fixed completed Codex tasks disappearing from the board when the paginated history API still returns an older, already-read turn. Confirmed local completion events now supply a result identity consistent with the history API.
- Preserve newer result cursors across stale refreshes and restarts; read receipts remain bound to the specific result. Existing read receipts and weekly banana totals are retained.
- Recover recent completion metadata within the existing seven-day history window, using bounded local reads and retaining only identifiers, timestamps and result digests.
- Added regression coverage for stale history, new completion after an acknowledged result, restart recovery and protection of newer API results.

修复任务完成后因历史接口滞后而从看板消失的问题。新结果独立标记未读，刷新和重启保留结果，原有已读记录与收蕉数保持。此修复已同步源码；公开 v0.1.2 安装包仍保持原版，后续安装包发布以 Releases 为准。

## 0.1.2 Preview

- Windows standalone launch now discovers Codex Desktop's versioned per-user CLI directory and the Microsoft Store package resource without relying on Codex's process-only `PATH` injection.
- Windows live task observation now accepts Codex Desktop's extended-length rollout paths, so active tasks show as running instead of falling back to the previous interrupted snapshot.

## 0.1.1 Preview

- Windows runtime discovery now uses Codex's state-database update time when an open rollout file retains an old modification time, so long-running desktop tasks remain visible as running while the observer keeps its bounded read window.

- Weekly quota now follows its own account observation, independently of task-feed and event-stream reconnects. Transport timeouts retain the last valid value within the existing 90-second freshness limit, show its observation time on hover and retry after five seconds; expired or authoritative missing quota remains unknown.

- The entire tree supports drag-to-move and tap-to-open; drag release keeps it collapsed. Right-click the tree to quit. macOS launches as an agent app without a Dock tile; Windows keeps the observer window out of the taskbar.

- Read tasks use a subdued pixel-art banana peel, completing the green growing banana → ripe unread banana → collected peel visual sequence.

- Removed task search, avatar settings and the animation toggle. Banana collection feedback is enabled by default and respects system reduced-motion preferences; the legacy opt-out is ignored.

- Unpinned boards collapse to the tree when another application window gains focus; pinned boards remain open. Internal controls and task-navigation receipt/error handling retain their existing behavior.

- Avatar badge now shows persisted calendar-week banana collections (local Monday to Sunday), independent of animation preferences and deduplicated by read receipt.

- Removed additional AI task-summary generation, its background worker and configuration switch. The board displays existing Codex progress text.

- Banana planter footer with live weekly quota, aligned below tree roots.
- ImageGen round banana coins expressing observed Token activity; progress bar removed.
- Green (>50%), yellow (>20% to 50%) and red (≤20%) quota states.
- A compact 20px banana coin inside the quota card turns slowly (12 seconds per revolution) during observed activity and gently bounces and refreshes the task list and weekly quota when clicked; separated from the pin, with no flyaway layer or additional window.
- Local Codex read-receipt reconciliation bound to each result version.
- Public sample showcase and Chinese/English Codex-assisted installation prompts.
- macOS arm64 and Windows x64 packaging; exact test evidence and signing limitations recorded per Release.

## 0.1.0 Preview candidate

- Task observation, unread-first board, Codex navigation, banana collection and a compact desktop tree.
- Initial macOS and Windows packaging pipeline; prepared as a draft candidate.
