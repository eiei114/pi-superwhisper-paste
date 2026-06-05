# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

## [0.1.15] - 2026-06-05

### Changed

- Remove stale template-maintenance docs (`github-template.md`, `repository-settings.md`, `typescript.md`) from the published package.

## [0.1.14] - 2026-06-05

### Changed

- Re-add `Code` / `Cursor` host processes to the clipboard-owner denylist so editor-hosted clipboard updates are blocked again during debugging.

## [0.1.13] - 2026-06-05

### Fixed

- Remove `Code.exe` / `Cursor.exe` from the terminal-owner denylist so editor-hosted Superwhisper clipboard updates are not blocked just because Pi is running inside Code/Cursor.

## [0.1.12] - 2026-06-05

### Changed

- Add an explicit `v0.1.12` marker to the status text so stale package loads are visible during live debugging.

## [0.1.11] - 2026-06-05

### Fixed

- Broaden the terminal clipboard-owner denylist with `OpenConsole` / explicit `.exe` variants.
- Surface the last clipboard decision in the Pi status text (`blocked ...`, `... via ...`) so real-machine owner mismatches can be diagnosed quickly.

## [0.1.10] - 2026-06-05

### Fixed

- Fix the Windows PowerShell clipboard-owner probe script so the owner-aware bridge works in real Pi sessions instead of failing on multiline `Add-Type` syntax.

## [0.1.9] - 2026-06-05

### Fixed

- Replace the strict Superwhisper owner allowlist with a terminal-owner denylist so unknown Superwhisper owner names still auto-paste while terminal/CLI clipboard owners stay blocked.

## [0.1.8] - 2026-06-05

### Fixed

- Filter clipboard updates by clipboard-owner process so Pi auto-pastes only when the clipboard owner looks like Superwhisper.
- Keep local terminal copy suppression as a fallback for forwarded copy shortcuts while blocking mouse/right-click terminal copies via owner filtering.

## [0.1.7] - 2026-06-05

### Fixed

- Suppress auto-paste for a short window after local terminal copy shortcuts so copying inside the active CLI no longer pastes into Pi.
- Refresh the clipboard baseline after local copy intent so the bridge keeps waiting for the next Superwhisper clipboard update.

## [0.1.6] - 2026-06-04

### Changed

- Added `version:check` PR guard support: package script + `scripts/check-version-bump.mjs`.
- Added CI verification that publishable changes must bump `package.json` and update `CHANGELOG.md` in the same PR.

### Fixed

- Truncate clipboard text in PowerShell before writing stdout so huge clipboards no longer exceed Node `maxBuffer` on extension load.
- Treat clipboard read failures (including `maxBuffer`) as empty reads so `session_start` never surfaces as an extension error.

## [0.1.5] - 2026-06-03

## [0.1.4] - 2026-06-03

### Changed

- Clarify that `pi-superwhisper-paste` is the Windows clipboard-based package.
- Point users to `@superwhisper/pi` only for the official deeplink/macOS flow.
- Update npm package metadata to match the revived Windows-focused positioning.

## [0.1.3] - 2026-06-03

### Changed

- Mark the package as archived in README and `package.json` description.
- Point new installs to the official Superwhisper Pi extension: `pi install npm:@superwhisper/pi`.

## [0.1.2] - 2026-06-01

### Fixed

- Register `/sw-paste:on` and `/sw-paste:off` as Pi slash commands so they appear in command autocomplete.

### Changed

- Clarify that the Superwhisper paste controls are slash-autocomplete commands.

## [0.1.1] - 2026-05-31

### Added

- Add automatic GitHub release creation for version bumps on `main`.
- Add manual and release-published npm publish entrypoints for Trusted Publishing.

### Changed

- Align CI and publish workflows with the maintained Pi OSS release pattern.
- Skip npm publish when the exact package version is already published.

## [0.1.0] - YYYY-MM-DD

### Added

- Initial Superwhisper paste bridge extension for Pi on Windows.
- Default-on clipboard watcher with `/sw-paste:on` and `/sw-paste:off` controls.
- CI and npm Trusted Publishing workflow from the Pi extension template.
