# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

## [0.1.5] - 2026-06-03

### Fixed

- Truncate clipboard text in PowerShell before writing stdout so huge clipboards no longer exceed Node `maxBuffer` on extension load.
- Treat clipboard read failures (including `maxBuffer`) as empty reads so `session_start` never surfaces as an extension error.

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
