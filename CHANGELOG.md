# Changelog

## 0.1.1 Preview

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
