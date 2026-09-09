# Monkex · A tiny desktop companion for Codex

[中文](README.md) · [Interactive handbook](docs/guide.en.html) · [Releases](https://github.com/zxzin/Monkex/releases) · [Install with Codex](INSTALL_WITH_CODEX.md)

Keep an eye on your Codex tasks from a little pixel-art banana tree.

- Small green bananas indicate running tasks; ripe yellow ones indicate recent unread results.
- Click the tree to open the board, then a task to return to its original Codex conversation.
- Hold anywhere on the tree to drag it. An unpinned board collapses when you switch windows.
- Collect a banana when a result is successfully opened and marked read from the board. The avatar counts your local weekly harvest.
- See your remaining weekly quota. Click the banana coin to refresh; it turns slowly when recent token use is observed.
- Right-click the tree to quit. The running app stays out of the macOS Dock and Windows taskbar.

Monkex is independent, local-first software for an existing **Codex desktop** installation. It is not an OpenAI product. It reads the current system user local Codex environment; packages contain no maker task history. Replies, approvals and execution stay in Codex.

## Try the English handbook

[Download the standalone HTML](https://github.com/zxzin/Monkex/raw/refs/heads/main/docs/guide.en.html), save it and open it in a browser. Images, styles, monkey animation and all demo interactions are embedded. It works offline and uses example data; it never connects to your Codex account. GitHub displays the file source, so use **Download raw file** to try it locally.

The 11 chapters cover the tree, task states, board navigation, harvest, quota, pinning, design, installation, data boundaries and FAQ.

## English version and installation

The updated source includes English and Chinese interfaces, selected from the system/WebView language. Your task titles and progress retain their original language. Browser previews also accept `?lang=en` or `?lang=zh`.

**English source availability and installer availability are separate.** The existing public `v0.1.2` installer predates this English update. Check the release notes of a newer public installer before expecting English UI support. No newer English installer has been published as part of this source update.

Packaged targets are macOS Apple Silicon and Windows x64. There is no Intel Mac, Windows ARM64 or Linux package. Preview builds lack Apple notarization and a Windows publisher signature. Verify the source and SHA256, review OS warnings yourself, and keep security protections enabled. Live Windows Codex integration still requires device-level validation.

## Install prompt for Codex

```text
Please help me install Monkex: https://github.com/zxzin/Monkex .
Read README.en.md, INSTALL_WITH_CODEX.md and public Releases. Detect my OS and CPU architecture, select the latest matching public installer (Preview is acceptable), verify SHA256, and preserve existing user data. Check the release notes for English UI support; do not assume newer source changes exist in an older installer.
Connect to my own local Codex. If no matching installer exists, stop and explain. Do not default to a source build, read or upload credentials, or change Codex configuration.
Explain unsigned/unnotarized warnings, sign-in and administrator prompts, then let me confirm. Keep system security protections enabled.
Report the installed version, path, launch instructions and actual verification results.
```

## Build and limitations

See [English edition build notes](docs/monkex-guide/ENGLISH.md) and the [installation guide](docs/INSTALL.md). Rebuild locale outputs before packaging. Normal installer users need no Python, Node.js or Rust.

Quota is the percentage reported by Codex, not an estimate of tokens or money. One coin has no fixed token value. Recent valid observations survive brief failures; expired readings show a dash. Reading sync depends on compatible local records, and mixed account histories in one system-user directory are not separated by cloud identity.

There is no extra AI-summary model, search, automatic update, launch at login or cross-device cloud sync. To report a problem, use [GitHub Issues](https://github.com/zxzin/Monkex/issues) with your version, OS and privacy-safe reproduction steps.
