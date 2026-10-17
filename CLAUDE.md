# Buddybara — guide for AI coding agents

Buddybara is a personal Windows desktop buddy for Claude Code, forked from Coucou (Louis-CFM/coucou, MIT). The buddy floats on the desktop; a click opens a panel with the projects, their Claude Code sessions and the conversation, so no editor is needed. Permission requests and questions show there, and nothing pops up during games. The character, also called Buddybara, is a capybara with a mikan on its head, drawn in `src/buddybara/engine.ts`; the mikan shows the Claude plan's usage. Coucou's own top-of-screen mode, its service integrations and its Mac and phone apps are gone: only buddy mode is left.

## Where things are
- `windows/src-tauri/` — Rust backend (Tauri 2). `windows/src/` — TypeScript frontend: `src/buddy/` is the panel, `src/desktop/` the desktop Buddybara's window, `src/buddybara/` his drawing and life cycle, `src/island/` the glue between them (hook events, the desktop link), `src/settings/` the Settings window. The panel's window keeps its old label, `island`.
- `windows/hook/` — `buddybara-hook`, the relay Claude Code's hooks call (named pipe to the app).
- `windows/scripts/gen-icons.mjs`, `gen-sounds.mjs` — the capybara icon and the sounds are generated in code (`npm run icons`, `npm run sounds`).
- `windows/src/i18n/strings.json`, `extra.json` — translations. Every `t()`/`tl()`/`N_()` (TS) and `t()`/`tf()`/`n_()` (Rust) key needs all 9 languages; new keys go in `extra.json`, which must not keep unused ones.
- `updates.md`, when there is one, is a private hand-off log between machines: it stays out of the public repository.

## Build
```
cd windows && npm ci && npx tauri build --no-bundle
```
Quit the app first: Windows locks the running exe.

## Rules
- No third-party dependencies unless truly unavoidable. The character is drawn in code, no images or animation libraries.
- Secrets live in Windows Credential Manager, never on disk or in git.
- No telemetry. Network calls only to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never approve a Claude Code permission without an explicit click.
- Everything is named Buddybara: the identifier `com.buddybara.app` (Credential Manager keys, WebView data), `buddybara-hook` and its marker in `settings.json`, `%APPDATA%\Buddybara` and `%LOCALAPPDATA%\Buddybara`, `BUDDYBARA_*` variables. Renaming any of them orphans installed hooks or stored keys, so it needs a migration.
- The code that moves an install from the old Coucou names is marked `ponytail:`: `LEGACY_SERVICE` (secrets.rs), `LEGACY_MARKER` and the status line copy (hooks.rs), and `adopt_legacy_config` (platform/windows.rs). Delete it once both PCs have run it and reinstalled their hooks.
- Pill IDs are stable contract values (stored settings, hook routing): never rename one.
