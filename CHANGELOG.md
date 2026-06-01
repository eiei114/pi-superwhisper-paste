# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

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
