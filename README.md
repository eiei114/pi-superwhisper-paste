# Pi Superwhisper Paste

> Windows-focused Pi bridge for Superwhisper clipboard input.
>
> The official Superwhisper Pi package (`@superwhisper/pi`) targets the deeplink/macOS flow. If you need the clipboard-based Windows workaround, use this package.

[![CI](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-superwhisper-paste.svg)](https://www.npmjs.com/package/pi-superwhisper-paste)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Recommended install on Windows

```bash
pi install npm:pi-superwhisper-paste
```

## Official package

If you are using the official Superwhisper Pi integration instead:

```bash
pi install npm:@superwhisper/pi
```

Docs: https://superwhisper.com/pi

## Why this package exists

Superwhisper can paste dictated text into normal Windows apps, but terminal TUIs can be a rough edge. In the original case, dictation worked in Notepad and PowerShell, and Typeless worked in Pi, but Superwhisper's automatic paste did not reliably reach Pi's TUI editor without a manual `Ctrl+V`.

This package bridges that gap from the Pi side: it watches the Windows clipboard, detects new Superwhisper output, and inserts it into the active Pi editor with Pi's extension API.

## Install

From npm:

```bash
pi install npm:pi-superwhisper-paste
```

From GitHub:

```bash
pi install git:github.com/eiei114/pi-superwhisper-paste
```

## Current behavior

- Default-on after the extension loads.
- Slash commands: `/sw-paste:on` and `/sw-paste:off`.
- Windows clipboard polling with active-tab gating.
- Brief copy-suppression window so local terminal copy actions do not get auto-pasted back into Pi.
- Clipboard-owner filtering so terminal/CLI-owned clipboard updates stay blocked by default.

See [CHANGELOG.md](CHANGELOG.md) for version history.

## Links

- Windows package: https://www.npmjs.com/package/pi-superwhisper-paste
- GitHub: https://github.com/eiei114/pi-superwhisper-paste
- Official Superwhisper Pi package: https://superwhisper.com/pi — `@superwhisper/pi` on npm (`pi install npm:@superwhisper/pi`)

## License

MIT
