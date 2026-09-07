# Monkex

A tiny banana orchard for your Codex tasks. Green bananas are running tasks; ripe bananas are unread results. Click a task to open its original conversation in Codex and collect the banana.

Monkex is an independent companion, not an OpenAI product.

## Download status

This first distribution is being validated. Source is available; installation packages remain draft until their platform checks pass. Windows support currently requires installation and real Codex navigation testing on a Windows desktop. Build success alone is not a compatibility guarantee.

## Requirements

- Codex desktop app installed and signed in. Monkex does not include Codex, create accounts, or bypass subscription limits.
- macOS Apple Silicon, or Windows 10/11 x64 with WebView2. Windows installer can download WebView2 when absent (internet required).
- A native Codex executable supporting `app-server --listen stdio://`. For nonstandard installations, set `MONKEX_CODEX_PATH` to its full executable path before launching Monkex. On Windows this must be an `.exe`, not a WSL path or `.cmd` wrapper.
- Codex must register the `codex://threads/…` URL handler. Windows URL handling is pending real-desktop verification.

## Use

1. Start Codex and sign in.
2. Start Monkex. The banana tree lives in the lower-right corner; click it to expand the board.
3. Click a task to open it in Codex. The pin keeps the board expanded. Right-click the tree to expand/collapse or quit.

The board prioritizes unread results. Recent activity covers a rolling 24 hours, and history covers the previous 24 hours to 7 days. Weekly remaining quota is informational; unavailable observations display as unavailable. Token rate is measured throughput, not remaining budget or completion percentage.

## Privacy and cost

The packaged application starts a loopback-only observer on `127.0.0.1:8766`. It reads this user's Codex task metadata, recent conversation context and runtime records to show status. Read receipts are stored in the OS application-data directory for `com.zin.work-twin`. No training database, author's conversations, account credentials, or development prototype is included.

AI summaries are **off by default in installers**. Existing task/progress text remains available. Setting `MONKEX_AI_SUMMARIES=1` before launch opts into sending recent task context through the user's configured Codex service for short summaries; this consumes that account's quota and follows its configured provider's data policy. Monkex itself has no analytics or remote upload service. Codex authentication stays with Codex.

Missing Codex or a failed sync leaves the board visible with installation/sync guidance. A Windows URL launch confirms dispatch to the OS, not that Codex has visibly selected the conversation; this limitation is part of the pending Windows acceptance test.

## Build from source

Install Python 3.11+, Node.js 22, Rust stable and the platform prerequisites from [Tauri](https://v2.tauri.app/start/prerequisites/).

```sh
python -m venv .venv
# Activate .venv for your shell, then:
python -m pip install pyinstaller==6.19.0
npm ci --prefix desktop_shell
python scripts/build_monkex_release.py
cd desktop_shell
npx tauri build --config src-tauri/tauri.release.conf.json --bundles nsis
# On macOS use --bundles app (or dmg) instead.
```

For the ad-hoc macOS preview, build `--bundles app`, return to the repository root, and run `python scripts/finalize_monkex_macos.py` before archiving the `.app`. This signs and tests the exact bundled sidecar. Its Python interpreter requires a scoped library-validation exception while embedded libraries are ad-hoc signed; the main UI keeps library validation. Retire this exception once the interpreter/extensions share a verified publisher identity.

The build embeds a Python sidecar and only the curated runtime assets. End users do not need Python, Node, Rust or this source checkout. Packaging is described by the [Tauri sidecar](https://v2.tauri.app/develop/sidecar/) and [Windows installer](https://v2.tauri.app/distribute/windows-installer/) documentation.

No paid signing/notarization service or publisher certificate has been configured. Unsigned Windows builds can trigger SmartScreen; the macOS build uses local ad-hoc signing and is not notarized. Do not disable OS security globally. Public release remains gated on the documented platform checks.

## Scope

Observation, read receipts and navigation only. New tasks, replies and approvals remain in Codex. Historical training/execution systems are not shipped. No auto-update or auto-start is installed.

## Rights

Copyright © 2026 Monkex contributors. This repository is source-available; no general open-source license is granted. You may download and run the released application for personal use. Codex and OpenAI names belong to their respective owners. Character artwork was generated with ImageGen.
