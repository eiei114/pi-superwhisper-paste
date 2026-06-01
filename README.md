# Pi Superwhisper Paste

[![CI](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-superwhisper-paste/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-superwhisper-paste.svg)](https://www.npmjs.com/package/pi-superwhisper-paste)
[![npm downloads](https://img.shields.io/npm/dm/pi-superwhisper-paste.svg)](https://www.npmjs.com/package/pi-superwhisper-paste)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/pi-package-purple.svg)](https://pi.dev/packages)
[![Trusted Publishing](https://img.shields.io/badge/npm-Trusted%20Publishing-blue.svg)](docs/release.md)

> Bridge Superwhisper clipboard dictation into the Pi TUI editor on Windows.

## Why This Exists

Superwhisper can paste dictated text into normal Windows apps, but terminal TUIs can be a rough edge. In the original case, dictation worked in Notepad and PowerShell, and Typeless worked in Pi, but Superwhisper's automatic paste did not reliably reach Pi's TUI editor without a manual `Ctrl+V`.

Pi Superwhisper Paste fixes that gap from the Pi side. It watches the Windows clipboard, detects new Superwhisper output, and inserts it into the active Pi editor with Pi's extension API.

## Observed Environment

This package was created for an issue observed in one local setup:

- Windows
- VS Code integrated terminal
- PowerShell
- Pi running in the terminal
- Superwhisper using clipboard-based auto-paste

This may not be a universal Superwhisper or Pi issue. If Superwhisper already pastes into your Pi editor reliably, you probably do not need this package.

## Features

- Default-on after the extension loads.
- Inserts new clipboard text into the active Pi editor.
- Avoids replaying clipboard content that existed before startup.
- Pastes only into the active Pi tab when multiple tabs are open.
- Ignores old clipboard content when switching tabs.
- Continues inserting while Pi is thinking or waiting on an agent turn.
- Provides slash-autocomplete control commands: `/sw-paste:on` and `/sw-paste:off`.

## Install

```bash
pi install npm:pi-superwhisper-paste
```

Or install from GitHub:

```bash
pi install git:github.com/eiei114/pi-superwhisper-paste
```

## Usage

After installation, start Pi normally. The bridge is enabled by default.

Dictate with Superwhisper while the Pi input box is focused. When Superwhisper writes the transcript to the clipboard, the active Pi tab receives it automatically.

Toggle the bridge inside Pi's input box:

```txt
/sw-paste:off
/sw-paste:on
```

The status line shows whether this tab is ready to receive dictation:

```txt
SW paste: active
SW paste: standby
```

## Local Development

Run this repo as a local Pi extension:

```bash
pi -e .
```

Then run:

```txt
/sw-paste:off
/sw-paste:on
```

## Behavior

### Multiple Pi tabs

Only the tab that most recently had terminal focus or keyboard input should paste the new clipboard text. Other tabs stay in standby.

When you switch to another Pi tab, the current clipboard is treated as already seen. This prevents the previous dictation result from being pasted into the newly focused tab.

### Pi thinking state

The bridge does not wait for Pi's agent turn to become idle. If Pi is thinking and the active tab is focused, the next Superwhisper clipboard update is still inserted into the editor.

### Clipboard baseline

On startup and focus changes, existing clipboard text is used as a baseline and will not be pasted. Only later clipboard changes are treated as dictation input.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PI_SUPERWHISPER_PASTE` | `on` | Set to `off`, `0`, `false`, or `no` to disable by default. |
| `PI_SUPERWHISPER_PASTE_INTERVAL_MS` | `800` | Clipboard polling interval. |
| `PI_SUPERWHISPER_PASTE_MAX_CHARS` | `8000` | Maximum clipboard text length to paste. |

PowerShell example:

```powershell
$env:PI_SUPERWHISPER_PASTE = "off"
pi
```

## Troubleshooting

If dictation does not appear, first confirm that Superwhisper can paste into Notepad or PowerShell. If it cannot, fix Superwhisper's own auto-paste settings first.

If dictation appears in the wrong Pi tab, reload all open Pi tabs so old extension instances are gone.

If text appears only after pressing a key, reload Pi and confirm the status line shows `SW paste: active`.

## Package contents

| Path | Purpose |
|---|---|
| `extensions/` | Pi TypeScript extension entrypoints (`*.ts` and `index.ts`) |
| `docs/` | Release and setup docs |

## Development

```bash
npm install
npm run ci
```

`npm run ci` runs typecheck, tests, and `npm pack --dry-run`.

## Release

This package is set up for npm Trusted Publishing, so no `NPM_TOKEN` is required.

```bash
npm version patch
git push --follow-tags
```

See [`docs/release.md`](docs/release.md) for setup details.

## Security

Pi packages can execute code with your local permissions. Review extensions before installing third-party packages.

For vulnerability reporting, see [`SECURITY.md`](SECURITY.md).

## Links

- npm: https://www.npmjs.com/package/pi-superwhisper-paste
- GitHub: https://github.com/eiei114/pi-superwhisper-paste
- Issues: https://github.com/eiei114/pi-superwhisper-paste/issues

## License

MIT
