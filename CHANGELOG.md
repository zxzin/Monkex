# Changelog

## Unreleased — 2026-10-28

- Dispatch reminder interaction, pagination and dismissal off the UI thread. Preserve window serialization while allowing native getters to complete during concurrent refreshes.
- Polish compact replies into rounded speech bubbles with continuous tails, calmer text hierarchy and a circular yellow reply arrow. Preserve the full-row click area and above-tree position. Play one short entrance per newly visible row, keep normal polling still and respect reduced-motion settings.
- Fit each reminder page to its text within 152–196px, reducing unused space for short titles while preserving room for long labels. Keep width across ordinary refreshes, pointer holds and native repositioning.
- Compact independent reminders to a content-fit 152–196px window and 46px bubble. Successful navigation dismisses the exact prompt for this app session and resizes or hides the window; new questions remain eligible. Failed navigation keeps a retry path. Bounded in-memory navigation receipts preserve actual pending-question, unread-result and harvest state.
- Place the floating reminder above the tree with a centered, tree-facing tail. Keep it inside the display work area; top-edge placement falls back below with its tail flipped toward the tree.
- Show structured Codex input requests on task cards and in an independent floating reminder window. Each bubble names its task, displays the pending count and opens its original conversation without expanding the board. Stable paged ordering, inline failures and fresh exact-question validation protect navigation; opening preserves unread-result and harvest state. Official external navigation remains conversation-scoped.
- Track current-turn question identities and matching structured replies in bounded local runtime records. Async tool acceptance keeps questions pending. Clear resolved questions and obsolete turns; unavailable observations show pending sync. Question text and answers stay out of reminder metadata.
- Distinguish waiting for user input from quiet execution in runtime health. Keep connection scores, task failures, project grouping and completed-result priority independent. Add bilingual, lifecycle, navigation and narrow-layout coverage.

## Unreleased — 2026-10-26

- Add one compact observed-exit row to health details. Show the region returned by the existing public trace probe, keeping the score prominent. Omit unavailable VPN profile and selected-node names.
- Reuse the existing bounded trace request and sampling cadence. Exit metadata stays in memory, clears on reset or observation failure, and hides when stale. Keep raw IPs, proxy URLs and credentials out of the payload. Add bilingual rendering, privacy, freshness and narrow-layout regressions; no OS VPN queries or third-party client integration.

## Unreleased — 2026-10-23

- Pair the compact health number with five readable connection bands: Prime 95–100, Smooth 85–94, Steady 70–84, Mixed 60–69 and Poor 0–59. Explain each band and its range in the anchored details, retain task warnings, prioritize official notices, and preserve the existing score formula. Unknown or expired samples keep a dash and an explicit sampling/sync/retest label.
- Add a compact pixel-heart indicator left of weekly quota. Its 13px numeric reading shows public-connection quality out of 100, with a visible Link label and a separate runtime alert. Task activity, waiting, quiet/unknown evidence and recent structured errors remain independent in its anchored popover; high public scores preserve operational warnings.
- Show fresh reported Token usage or an evidence-based phase on running cards. Tool waits, first-response waits and missing reports remain distinct; rate values measure reported usage, including input/cache/output, rather than completion progress.
- Preserve known running cards as Pending sync through transient API, observer and event-feed failures. Retain anchored long-running turns until a matching terminal event; newer completions and explicit archive/deletion take precedence. Recover temporary history-pagination gaps without resurrecting completed turns.
- Keep delayed tool records inside their original lifecycle. Cold-start log tails retain unknown start times; explicit start events establish a new running turn, so a late old tool completion cannot revive an ended task.
- Bind runtime diagnostics to the current turn with an atomic activity/usage snapshot. New turns clear prior activity and establish their own usage baseline; missing or mismatched identities show unknown with old metadata hidden. Thread/project rolling usage keeps its existing cross-turn window.
- Compare small public HTTPS checks with official OpenAI component notices. Checks run off the task-refresh path, have bounded concurrency and freshness, and preserve HTTP restrictions separately from transport failures. Probe timing describes public connectivity; individual model throughput and VPN/server causality remain unconfirmed.
- Keep diagnostic metadata in memory and document destinations, interpretation, sampling and privacy in [Runtime Health](docs/RUNTIME_HEALTH.md).

## Unreleased — 2026-10-21

- Integrate quota into the compact toolbar with an 18px banana coin. Reset times start collapsed and toggle independently from coin refresh; background sync preserves disclosure state. Keep balance, nearest expiry and reset-card count in one quiet summary, with the expiry placed left of the count and full expiry details in a bounded three-column disclosure.
- Add a compact quota-details area to the expanded board: credit balance, available reset-card count, grouped expiration dates, and local reset dates for weekly and available five-hour windows.
- Preserve the simple collapsed tree and the banana coin's full account refresh. Display-only quota details add no purchase or reset-redemption action.
- Parse only the core Codex quota bucket. Preserve true zero values, distinguish missing data from unlimited credits and explicit non-expiring cards, and keep authoritative card counts when the detail list is capped or absent.
- Keep recent observations for up to 90 seconds during transport failures, label pending refreshes, and clear account-derived details on manual refresh or authoritative missing fields. Account IDs and reset-card IDs stay out of the display payload.
- Include Chinese and English labels and regression coverage for quota parsing, freshness, account refresh and compact layouts. This is a source update; public installer availability remains defined by each Release.
- Run standalone UI regression suites in CI; browser-dependent visual QA remains an explicit local check.

## Unreleased — 2026-10-02

- Discover the embedded Codex CLI in the current macOS ChatGPT/Codex application bundle, including user-level installations. Finder launches connect automatically with both the current nested CLI layout and the legacy resource path.
- Resolve macOS apps through LaunchServices before standard-install fallbacks. Renamed/moved apps and new resource layouts use bounded executable discovery; the default registered app takes priority over backups. Explicit paths retain their existing authority.
- Rediscover the CLI on every app-server reconnect and coin refresh, including updates that leave the old binary on disk. Failed initialization closes the incomplete session so the normal retry can recover.
- Distinguish a missing executable from a failed connection: temporary or protocol failures show reconnect/retry guidance and retain the last observed task snapshot.
- Run discovery and reconnect regressions on both packaging platforms. Add a read-only `scripts/check_codex_compatibility.py` probe for initialization, task listing and quota support after Codex updates; it emits status only.

## Unreleased — 2026-09-12

- Track hover against the native window's physical bounds while other apps are focused. A short hover dwell preserves press-to-drag; pointer exit/reentry, manual collapse and pin behavior have focused regression coverage. Browser previews retain DOM tracking.

- Use a fresh leaf-green palette with bright project dots. Running rows use a richer green surface, pulsing marker and moving green bottom rail; completed unread rows use a banana-yellow surface, soft gold border and completed badge. Project headings and counts share deep-green text.
- Group conversations by their exact local project path and assign each project a stable shared color. Project headings expose the short folder name and task count without placing full local paths in the page; task-state bananas and badges remain independent.
- Open the unpinned board by hovering the banana tree and collapse it after the pointer leaves the window. Hover expansion keeps the current application focused; the pin retains the board.
- Recover automatically when the native WebView fails to finish the first frontend boot. A one-shot cache-busted reload now restores task and quota polling; a persistent second failure becomes visible instead of leaving the board on the initial loading screen forever.
- Make the banana-coin refresh a full Codex resync: restart the local app-server session, discard account-derived task and quota caches, and rebuild the board from the currently signed-in account.
- Apply unread/read/running priority changes immediately while a task row is hovered or focused. Newly completed unread tasks move above running tasks; routine progress updates retain stable ordering. Added combined sorting/rendering regression coverage, including checks against an installed app script.
- Follow Codex Desktop's current blue-dot read-state schema for a single saved account/local execution scope. Reading in Codex clears Monkex's unread result; a blue dot restores unread status. Automatic synchronization preserves weekly harvest totals. Ambiguous multi-account/local scopes retain the fallback behavior.
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
