# Examples

This package ships one Pi extension for Windows clipboard-based dictation.

## Local trial

Run Pi with this repo loaded as an extension:

```bash
pi -e .
```

The bridge is enabled by default. Dictate with Superwhisper and let it update the clipboard.

## Toggle commands

Run these commands inside Pi's input box:

```txt
/sw-paste:off
/sw-paste:on
```

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_SUPERWHISPER_PASTE` | `on` | Set to `off`, `0`, `false`, or `no` to disable by default. |
| `PI_SUPERWHISPER_PASTE_INTERVAL_MS` | `800` | Clipboard polling interval. |
| `PI_SUPERWHISPER_PASTE_MAX_CHARS` | `8000` | Maximum clipboard text length to paste. |
| `PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS` | `1500` | Ignore clipboard changes briefly after local terminal copy shortcuts. |
| `PI_SUPERWHISPER_PASTE_OWNER_DENYLIST` | `windowsterminal,...` | Comma-separated clipboard owner process/path substrings blocked from auto-paste. |

## Expected workflow

1. Start Pi with this extension installed or loaded.
2. Keep the Pi input box focused.
3. Dictate with Superwhisper.
4. Superwhisper writes the transcript to the clipboard.
5. The extension inserts the new clipboard text into the Pi editor.

When multiple Pi tabs are open, only the tab that most recently had terminal focus or keyboard input should paste the new clipboard text.

The bridge does not wait for Pi's agent turn to become idle. If Pi is thinking, the active tab should still receive the next Superwhisper clipboard update.

When you copy text inside the active CLI, the bridge now suppresses auto-paste briefly and refreshes the clipboard baseline so the copied text is not inserted into Pi.

The bridge also inspects the Windows clipboard owner and blocks auto-paste when the owner looks like a terminal/CLI app.
