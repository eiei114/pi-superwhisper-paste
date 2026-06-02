# Pi Superwhisper Paste

> **Archived — use the official Superwhisper Pi extension instead**
>
> Superwhisper now ships an official Pi package. Install and maintain that going forward:
>
> ```bash
> pi install npm:@superwhisper/pi
> ```
>
> This repository (`pi-superwhisper-paste`) was a community bridge for the same problem (Superwhisper clipboard output not reaching the Pi TUI on Windows). It is **no longer maintained**. Issues and feature requests belong with Superwhisper's official Pi integration.

[![CI](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-superwhisper-paste.svg)](https://www.npmjs.com/package/pi-superwhisper-paste)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Recommended install

```bash
pi install npm:@superwhisper/pi
```

## Historical context

Superwhisper can paste dictated text into normal Windows apps, but terminal TUIs can be a rough edge. In the original case, dictation worked in Notepad and PowerShell, and Typeless worked in Pi, but Superwhisper's automatic paste did not reliably reach Pi's TUI editor without a manual `Ctrl+V`.

This package bridged that gap from the Pi side: it watched the Windows clipboard, detected new Superwhisper output, and inserted it into the active Pi editor with Pi's extension API.

## Legacy install (not recommended)

If you still need this archived package for comparison or rollback:

```bash
pi install npm:pi-superwhisper-paste
```

Or from GitHub:

```bash
pi install git:github.com/eiei114/pi-superwhisper-paste
```

## Legacy behavior (v0.1.2 and earlier)

- Default-on after the extension loads.
- Slash commands: `/sw-paste:on` and `/sw-paste:off`.
- Windows clipboard polling with active-tab gating.

See [CHANGELOG.md](CHANGELOG.md) for version history.

## Links

- Official: `@superwhisper/pi` on npm (install via `pi install npm:@superwhisper/pi`)
- Archived npm: https://www.npmjs.com/package/pi-superwhisper-paste
- Archived GitHub: https://github.com/eiei114/pi-superwhisper-paste

## License

MIT
