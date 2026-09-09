# English edition

The product and handbook keep their existing Chinese versions. English UI files are generated from the canonical product files with explicit translation dictionaries. User task titles and progress content retain their original language.

## Build

```sh
node scripts/build_monkex_guide.mjs
node scripts/build_monkex_english.mjs
```

The product outputs are `shell/en/`. The handbook output is `docs/guide.en.html` in the public repository, or `releases/Monkex/docs/guide.en.html` in the authoring workspace. All guide assets are embedded, including the monkey atlas and branch-motion styles.

The launcher follows the browser/WebView system language: Chinese locales use Chinese; other locales use English. For a browser preview, `?lang=en` and `?lang=zh` explicitly select a language while retaining other URL parameters. Native context-menu labels follow the rendered page language. No language controls, model calls, telemetry or task translation were added.

The generated English source includes localized system diagnostics for connection, quota, navigation and read-status failures. Original provider diagnostics can still contain their source language. OS permission dialogs follow the operating system.

## Verification and release boundary

The English handbook passes 11 routes at 4 viewport sizes, offline assets, interactive demos, five branch-motion phases and Reduced Motion. The 344px product preview verifies auto-selection, Chinese override, readable controls, task-content preservation, quota refresh, tree expansion and pinning. Rust compilation and the existing Chinese frontend regressions pass.

This is an English source update. A source commit does not update an older installed app. Public installers need a new tagged build and platform-specific verification; consult the actual release notes before promising English support in a download.
