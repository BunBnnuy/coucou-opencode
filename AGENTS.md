# Coucou — guide for AI coding agents

Coucou is a small animated character (Mochi) that lives in the MacBook notch — or
at the top of the screen on Windows — shows coding-agent sessions and a few
integrations, and lets the user approve, answer, chat and drop files without
leaving what they are doing.

The repo ships two native apps that must stay in step:

- `NotchBuddy/` — macOS, Swift 6 / SwiftUI / AppKit.
- `windows/` — Windows, Tauri 2 (Rust + TypeScript).

Claude Code is the original integration; OpenCode is supported too (see
`docs/OPENCODE.md` and `NotchBuddy/Resources/opencode/coucou.ts`).

## Where things are

- `NotchBuddy/Sources/App/` — all Swift code. `NotchBuddy/Resources/sounds/` — the 28 WAV sounds. `NotchBuddy/project.yml` — XcodeGen project (never edit the `.xcodeproj` by hand).
- `windows/src/` — island front end (TypeScript, no framework). `windows/src-tauri/src/` — Rust backend (window, named pipe, Claude API, pollers). `windows/hook/` — `coucou-hook.exe`, the relay.
- `docs/SPEC.md`, `docs/INTEGRATIONS.md` — behaviour, views, states, integrations (in French). `docs/OPENCODE.md` — the OpenCode plugin (in French).
- `design/prototype/notch-buddy.html` — original prototype, the visual source of truth. `design/captures/` — target screenshots.
- `NotchBuddy/Resources/opencode/coucou.ts` — the OpenCode plugin, shared by both apps. Build config consumes it as a resource; the Windows crate embeds it with `include_str!`.
- `docs/*.html` — the GitHub Pages site (privacy, terms, support, legal notice).

## Build

macOS:

```
cd NotchBuddy && xcodegen && xcodebuild -scheme NotchBuddy -configuration Debug build
```

Windows:

```
cd windows && npm install
npm run build          # type-check the front end + bundle
cargo test             # run the Rust tests (hook + backend)
npm run pack           # installer in windows/release/
```

## Rules

- Swift 6, SwiftUI + AppKit. No third-party dependencies unless truly unavoidable. The character is drawn in code (`Canvas` + `TimelineView`), no Rive/Lottie/images.
- Windows is Tauri 2 + plain TypeScript: no UI framework, no CSS-in-JS. Mochi is Canvas 2D with the same shapes, timings and sounds as the Mac.
- Secrets live in the macOS Keychain / Windows Credential Manager, never on disk or in git.
- No telemetry. Network calls only to services the user configured.
- Never block the coding agent: if the app doesn't answer, the hook/plugin exits immediately.
- Never overwrite `~/.claude/settings.json` or `~/.config/opencode/opencode.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a permission without an explicit click.
- Performance: 0 % CPU when the island is hidden.
- Keep the bundle identifier `fr.louisraille.NotchBuddy` (Keychain items, preferences and permissions depend on it).
- Visual changes must match the prototype and the screenshots in `design/captures/`.
- Never edit `*.xcodeproj` / `*.pbxproj` by hand; change `NotchBuddy/project.yml` and run `xcodegen`.
