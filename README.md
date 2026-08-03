# Pi Superwhisper Paste

[![Join dotfield.xyz on Discord](https://img.shields.io/badge/Join%20dotfield.xyz%20on%20Discord-5865F2?logo=discord&logoColor=white)](https://discord.gg/4945dXZVW5)

[![CI](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-superwhisper-paste.svg)](https://www.npmjs.com/package/pi-superwhisper-paste)
[![npm downloads](https://img.shields.io/npm/dm/pi-superwhisper-paste.svg)](https://www.npmjs.com/package/pi-superwhisper-paste)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/pi-package-purple.svg)](https://pi.dev/packages)
[![Trusted Publishing](https://img.shields.io/badge/npm-Trusted%20Publishing-blue.svg)](docs/release.md)
<a href="https://buymeacoffee.com/ekawano114m"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="217" height="60"></a>

> Windows-focused Pi bridge that pastes Superwhisper clipboard output into Pi's TUI editor.

## What this is

Superwhisper can paste dictated text into normal Windows apps, but terminal TUIs can be a rough edge. In the original case, dictation worked in Notepad and PowerShell, and Typeless worked in Pi, but Superwhisper's automatic paste did not reliably reach Pi's TUI editor without a manual `Ctrl+V`.

This package bridges that gap from the Pi side: it watches the Windows clipboard, detects new Superwhisper output, and inserts it into the active Pi editor with Pi's extension API.

The official Superwhisper Pi package (`@superwhisper/pi`) targets the deeplink/macOS flow. If you need the clipboard-based Windows workaround, use this package.

## Features

- Default-on after the extension loads on Windows.
- Slash commands: `/sw-paste:on` and `/sw-paste:off`.
- Windows clipboard polling with active-tab gating.
- Brief copy-suppression window so local terminal copy actions do not get auto-pasted back into Pi.
- Clipboard-owner filtering so terminal/CLI-owned clipboard updates stay blocked by default.

## Install

Install the published npm package with Pi:

```bash
pi install npm:pi-superwhisper-paste
```

Pin a specific version when you want reproducible installs:

```bash
pi install npm:pi-superwhisper-paste@0.1.18
```

Install into the current project instead of your user Pi settings:

```bash
pi install npm:pi-superwhisper-paste -l
```

Or install from GitHub:

```bash
pi install git:github.com/eiei114/pi-superwhisper-paste
```

Try it without permanently installing:

```bash
pi -e npm:pi-superwhisper-paste
```

### Official Superwhisper package

If you are using the official Superwhisper Pi integration instead:

```bash
pi install npm:@superwhisper/pi
```

Docs: https://superwhisper.com/pi

## Quick start

After install, start Pi and dictate with Superwhisper. New Superwhisper clipboard output should auto-paste into the active Pi editor when the bridge is on.

Toggle the bridge at runtime:

```txt
/sw-paste:off
/sw-paste:on
```

Try this package locally from a clone:

```bash
pi -e .
```

## Package contents

| Path | Purpose |
|---|---|
| `extensions/index.ts` | Pi TypeScript extension entrypoint |
| `docs/examples.md` | Usage examples |
| `docs/release.md` | Trusted Publishing release flow |
| `docs/template-checklist.md` | Maintainer template checklist |
| `CHANGELOG.md` | Version history |
| `LICENSE` | MIT license |

## Development

```bash
npm install
npm run ci
```

## Release

This package is set up for npm Trusted Publishing, so no `NPM_TOKEN` is required.

```bash
npm version patch
git push
```

See [`docs/release.md`](docs/release.md) for setup details.

## Security

Pi packages can execute code with your local permissions. Review extensions before installing third-party packages.

For vulnerability reporting, see [`SECURITY.md`](SECURITY.md).

## Links

- npm: https://www.npmjs.com/package/pi-superwhisper-paste
- GitHub: https://github.com/eiei114/pi-superwhisper-paste
- Issues: https://github.com/eiei114/pi-superwhisper-paste/issues
- Official Superwhisper Pi package: https://superwhisper.com/pi — `@superwhisper/pi` on npm (`pi install npm:@superwhisper/pi`)

## License

MIT