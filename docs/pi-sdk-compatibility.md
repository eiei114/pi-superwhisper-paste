# Pi SDK 1.5.0 compatibility

`pi-superwhisper-paste` is verified against the frozen Pi SDK wave:

- `@earendil-works/pi-agent-core`: `1.5.0`
- `@earendil-works/pi-ai`: `1.5.0`
- `@earendil-works/pi-coding-agent`: `1.5.0`
- `@earendil-works/pi-tui`: `1.5.0`

These are exact dev/test pins. Public peer dependency ranges stay `*`, so a
host Pi of another version is not blocked by the published package; only the
installed development host the smoke runs against is pinned.

## What this package uses from the SDK

The extension surface is small and deliberately stays inside the stable
extension API:

- `ExtensionAPI.registerCommand()` for `sw-paste:on` and `sw-paste:off`
- `ExtensionAPI.on()` for `session_start`, `session_shutdown` and `input`
- `ctx.ui.setStatus()`, `ctx.ui.notify()`, `ctx.ui.onTerminalInput()`,
  `ctx.ui.pasteToEditor()` and `ctx.ui.getEditorText()`
- `ctx.hasUI` to skip clipboard polling when no editor is attached
- the `input` handler returning `{ action: "continue" }` or `{ action: "handled" }`

All of these behave the same on 1.5.0. The package registers no tools, so tool
schema changes do not reach it (see the schema note below for completeness).

## 1.5.0 notes that matter downstream

Reused from the verified `pi-extension-template` baseline (DOT-3243 / PR #141),
adapted to what this package actually touches:

- Tool argument validation moved to `@earendil-works/pi-schema`; TypeBox schemas
  are JSON Schema and keep working, but TypeBox-only features (`Type.Refine()`,
  `Type.BigInt()`, `Type.Undefined()`, `Type.Void()`, codecs, `Format.Set()`
  formats) no longer apply to tool arguments. Check such constraints in
  `execute()`. **This package registers no tools, so nothing to migrate.**
- The published `@earendil-works/pi-ai` no longer re-exports TypeBox, and its
  `StringEnum` is typed as a pi-schema `Schema<T>`. **This package imports
  `Type`-free code only** — no TypeBox or `StringEnum` usage — so no cast is
  needed. A package that builds tool schemas must import `Type`/`Static` from
  `typebox` and wrap `StringEnum` as `Type.Unsafe<T>(StringEnum(...))`.
- `pi-coding-agent` 1.5.0 pins `typebox` to exactly `1.3.27`. This package
  does not depend on `typebox` directly, so the lockfile keeps a single copy.
- `before_agent_start` is a `messageType` union (`user` with `prompt`/`images`,
  `custom` with `message`) since 1.2.0. **This package does not handle
  `before_agent_start`**, so no migration is required.
- `ctx.isIdle()` is false during startup handlers and `sendUserMessage()`
  requires `deliverAs` in that window. This package awaits
  `session_start` work but never calls either method.

No deprecated SDK API is removed by this update; the change is a
dev/test pin plus verification, not a code migration.

## Runtime verification

`npm run smoke:pi` loads the extension in the actual locally pinned Pi host.
`npm run ci` runs that harness as part of the required pipeline. The committed
result is `docs/verification/pi-sdk-smoke.json` with
`verification_contract=pi-sdk-behavior-v2`.

The harness asserts, against a real Pi process rather than a mocked import:

1. `extension_load` — real `get_commands` lists both extension commands.
2. `happy_path` — `/sw-paste:off` returns `disposition: "handled"` and emits
   the "Superwhisper paste bridge: disabled" notification.
3. `error_path` — malformed RPC input returns `success: false` with an
   observed parse error.
4. `reload_cleanup` — a second, separate Pi process re-registers both commands,
   handles the feature command, and exits zero without unhandled or shutdown
   errors. Reload assertions read the second process only.
5. `host_shell` — the native Windows PowerShell boundary launches the pinned
   Pi CLI and prints exactly the pinned SDK version.

The harness resolves the CLI from the installed SDK manifest, checks all four
installed versions against the exact pins, and uses an isolated temporary agent
directory (`PI_CODING_AGENT_DIR`) so global Pi settings are untouched.

### Boundary of the claim

- Model inference is **not** exercised: `--offline` plus `/sw-paste:off` makes
  the feature path deterministic, so no paid model request happens.
- The clipboard is **not** read or written: the smoke runs with
  `PI_SUPERWHISPER_PASTE=off`, so the user's shared clipboard is not touched.
  This smoke therefore does not claim live clipboard or recording insertion;
  that path is covered by the unit/regression tests in `tests/` and by the
  manual usage documented in `README.md`.
- The Pi extension loader, host process, RPC handling, extension lifecycle and
  feature response are real, not mocked. `tests/pi-sdk-smoke-contract.test.mjs`
  additionally proves the assertions fail on deliberately missing or malformed
  responses, so the contract cannot pass on an empty harness.
