import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRecordingSource, recordingsDirAvailable } from "./recording-source.ts";
import type { RecordingSource } from "./recording-source.ts";

const execFileAsync = promisify(execFile);
const EXTENSION_VERSION = "0.2.0";

const STATUS_KEY = "superwhisper-paste";
const DEFAULT_SOURCE = "clipboard";
const DEFAULT_INTERVAL_MS = 800;
const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_IGNORE_COPY_MS = 1500;
const BASELINE_REFRESH_DELAY_MS = 120;
const DEFAULT_OWNER_DENYLIST = [
  "windowsterminal",
  "windowsterminal.exe",
  "windows terminal",
  "openconsole",
  "openconsole.exe",
  "wezterm",
  "alacritty",
  "mintty",
  "conhost",
  "cmd.exe",
  "code",
  "code.exe",
  "powershell",
  "pwsh",
  "bash",
  "cursor",
  "cursor.exe",
  "wsl",
];
const ACTIVE_STATE_FILE = "pi-superwhisper-paste-active.json";
const ACTIVE_STATE_PATH = join(tmpdir(), ACTIVE_STATE_FILE);
/** Herdr's CLI, used to read which pane is focused when Herdr hosts this pane. */
const HERDR_APP_BIN =
  process.env.PI_SUPERWHISPER_HERDR_BIN ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "Programs",
    "herdr-app",
    "herdr-app.exe",
  );
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CTRL_C = "\x03";
const CTRL_INSERT = "\x1b[2;5~";
const CTRL_SHIFT_INSERT = "\x1b[2;6~";
const CTRL_SHIFT_C_CSI_U = "\x1b[99;6u";
const CTRL_SHIFT_UPPER_C_CSI_U = "\x1b[67;6u";
const LOCAL_COPY_SHORTCUTS = new Set([
  CTRL_C,
  CTRL_INSERT,
  CTRL_SHIFT_INSERT,
  CTRL_SHIFT_C_CSI_U,
  CTRL_SHIFT_UPPER_C_CSI_U,
]);

type BridgeMode = "off" | "on";

/**
 * Where transcriptions come from.
 *
 * - `clipboard`: poll the Windows clipboard, the original behaviour.
 * - `recording`: read Superwhisper's own recording files. Works where the
 *   clipboard paste cannot reach the app, such as Herdr's GPUI window, whose
 *   UI Automation tree is empty so Superwhisper's paste finds no target.
 * - `auto`: pick `recording` when the recordings folder exists, else clipboard.
 */
type BridgeSource = "clipboard" | "recording" | "auto";

type ClipboardSnapshot = {
  text?: string;
  ownerProcessName?: string;
  ownerProcessPath?: string;
};

type PiEditorUi = {
  setStatus(key: string, value: string | undefined): void;
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  pasteToEditor(text: string): void;
  getEditorText?: () => string;
};

type PiRuntimeContext = {
  hasUI?: boolean;
  ui: PiEditorUi;
};

type SessionHandle = {
  generation: number;
  ctx: PiRuntimeContext;
};

type BridgeState = {
  mode: BridgeMode;
  interval?: NodeJS.Timeout;
  baselineRefreshTimeout?: NodeJS.Timeout;
  generation: number;
  session?: SessionHandle;
  inFlightGeneration?: number;
  activatingGeneration?: number;
  terminalFocused: boolean;
  suppressPasteUntil?: number;
  unsubscribeTerminalInput?: () => void;
  lastClipboard?: string;
  lastPasted?: string;
  lastPasteSummary?: string;
  activeTabCache?: { ok: boolean; checkedAt: number };
  recordingSource?: RecordingSource;
  recordingGeneration?: number;
  /** Serializes recording deliveries so two pastes cannot interleave. */
  recordingDelivery?: Promise<void>;
};

let cachedOwnerDenylistEnv: string | undefined;
let cachedOwnerDenylist: readonly string[] | undefined;
let cachedClipboardScript: { limit: number; script: string } | undefined;

type RuntimeConfig = {
  intervalMs: number;
  maxChars: number;
  ignoreCopyMs: number;
};

let cachedRuntimeConfig: RuntimeConfig | undefined;

const state: BridgeState = {
  mode: defaultMode(),
  generation: 0,
  terminalFocused: true,
};

/** Resolves bridge on/off from `PI_SUPERWHISPER_PASTE` (default on). */
function defaultMode(): BridgeMode {
  const raw = (process.env.PI_SUPERWHISPER_PASTE ?? "on").trim().toLowerCase();
  return ["0", "false", "no", "off"].includes(raw) ? "off" : "on";
}

/**
 * Resolves the transcription source from `PI_SUPERWHISPER_PASTE_SOURCE`.
 *
 * An unset, blank or unrecognised value resolves to the clipboard default, so
 * an empty setting can never opt a user into reading the recordings folder.
 */
function configuredSource(): BridgeSource {
  const raw = (process.env.PI_SUPERWHISPER_PASTE_SOURCE ?? "").trim().toLowerCase();
  if (raw === "clipboard" || raw === "recording" || raw === "auto") return raw;
  return DEFAULT_SOURCE;
}

/**
 * The source actually in use right now.
 *
 * `auto` prefers recording files because that path works whether or not the
 * focused app accepts a patched paste, and falls back to the clipboard when
 * Superwhisper's recordings are not present on this machine.
 */
function activeSource(): "clipboard" | "recording" {
  const configured = configuredSource();
  if (configured !== "auto") return configured;
  return recordingsDirAvailable(recordingsDir()) ? "recording" : "clipboard";
}

/** Cached poll/copy limits parsed from env (hot path on every interval tick). */
function runtimeConfig(): RuntimeConfig {
  if (cachedRuntimeConfig) return cachedRuntimeConfig;

  const parsedInterval = Number(process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS);
  const parsedMaxChars = Number(process.env.PI_SUPERWHISPER_PASTE_MAX_CHARS);
  const parsedIgnoreCopy = Number(process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS);

  cachedRuntimeConfig = {
    intervalMs:
      Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : DEFAULT_INTERVAL_MS,
    maxChars:
      Number.isFinite(parsedMaxChars) && parsedMaxChars > 0 ? parsedMaxChars : DEFAULT_MAX_CHARS,
    ignoreCopyMs:
      Number.isFinite(parsedIgnoreCopy) && parsedIgnoreCopy >= 0
        ? parsedIgnoreCopy
        : DEFAULT_IGNORE_COPY_MS,
  };
  return cachedRuntimeConfig;
}

/** Poll interval from env or default. */
function intervalMs(): number {
  return runtimeConfig().intervalMs;
}

/** Max pasted characters from env or default. */
function maxChars(): number {
  return runtimeConfig().maxChars;
}

/** Ignore clipboard changes briefly after local copy shortcuts. */
function ignoreCopyMs(): number {
  return runtimeConfig().ignoreCopyMs;
}

/** Superwhisper's recordings folder, overridable for tests and odd installs. */
function recordingsDir(): string {
  const override = process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR?.trim();
  if (override) return override;
  const localAppData = process.env.LOCALAPPDATA;
  const base = localAppData && localAppData.length > 0
    ? localAppData
    : join(homedir(), "AppData", "Local");
  return join(base, "com.superwhisper.app", "recordings");
}

/** Process-name/path substrings denied from triggering auto-paste. */
function ownerDenylist(): readonly string[] {
  const raw = process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST ?? "";
  if (cachedOwnerDenylist && cachedOwnerDenylistEnv === raw) return cachedOwnerDenylist;

  cachedOwnerDenylistEnv = raw;
  if (!raw) {
    cachedOwnerDenylist = DEFAULT_OWNER_DENYLIST;
    return cachedOwnerDenylist;
  }

  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  cachedOwnerDenylist = tokens.length > 0 ? tokens : DEFAULT_OWNER_DENYLIST;
  return cachedOwnerDenylist;
}

/** Status bar label for the paste bridge. */
function statusText(): string | undefined {
  if (state.mode === "off") return undefined;
  const focusText = state.terminalFocused ? "active" : "standby";
  const sourceText = activeSource();
  return state.lastPasteSummary
    ? `SW paste v${EXTENSION_VERSION}: ${sourceText} ${focusText} (${state.lastPasteSummary})`
    : `SW paste v${EXTENSION_VERSION}: ${sourceText} ${focusText}`;
}

/** Short display name for clipboard owner debugging. */
function clipboardOwnerSummary(snapshot: ClipboardSnapshot): string {
  const name = snapshot.ownerProcessName?.trim();
  if (name) return name;

  const rawPath = snapshot.ownerProcessPath?.trim();
  if (!rawPath) return "unknown";

  const segments = rawPath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? rawPath;
}

/** True when `ctx`/`generation` still match the active Pi session. */
function isCurrentSession(ctx: PiRuntimeContext, generation: number): boolean {
  return state.session?.generation === generation && state.session.ctx === ctx;
}

/** Runs a UI callback only for the current session; swallows stale-ctx errors. */
function withCurrentUi<T>(
  ctx: PiRuntimeContext,
  generation: number,
  action: (ui: PiEditorUi) => T,
  fallback: T,
): T {
  if (!isCurrentSession(ctx, generation)) return fallback;

  try {
    const ui = ctx.ui;
    if (!isCurrentSession(ctx, generation)) return fallback;
    return action(ui);
  } catch {
    // A Pi ctx can become stale between any callback/await boundary. Treat UI
    // failures as a closed session so the extension never bubbles the runner's
    // stale-ctx guard up as an uncaughtException.
    return fallback;
  }
}

/** Runs a UI callback and reports whether it completed for the current session. */
function safeWithCurrentUi(
  ctx: PiRuntimeContext,
  generation: number,
  action: (ui: PiEditorUi) => void,
): boolean {
  return withCurrentUi(
    ctx,
    generation,
    (ui) => {
      action(ui);
      return true;
    },
    false,
  );
}

/** Updates Pi status bar when session is current. */
function setStatus(ctx: PiRuntimeContext, generation: number): boolean {
  return safeWithCurrentUi(ctx, generation, (ui) => {
    ui.setStatus(STATUS_KEY, statusText());
  });
}

/** Shows a Pi notification when session is current. */
function notify(
  ctx: PiRuntimeContext,
  generation: number,
  message: string,
  level?: "info" | "warning" | "error" | "success",
): boolean {
  return safeWithCurrentUi(ctx, generation, (ui) => {
    ui.notify(message, level);
  });
}

/** Pastes text into the editor when session is current. */
function pasteToEditor(ctx: PiRuntimeContext, generation: number, text: string): boolean {
  return safeWithCurrentUi(ctx, generation, (ui) => {
    ui.pasteToEditor(text);
  });
}

/** Reads editor text when session is current. */
function getEditorText(ctx: PiRuntimeContext, generation: number): string | undefined {
  return withCurrentUi(
    ctx,
    generation,
    (ui) => String(ui.getEditorText?.() ?? ""),
    undefined,
  );
}

/** Records last paste and refreshes status after insert. */
function markPasted(ctx: PiRuntimeContext, generation: number, text: string): void {
  if (!isCurrentSession(ctx, generation)) return;
  state.lastPasted = text;
  state.lastPasteSummary = `${text.length} chars`;
  // pasteToEditor mutates the editor directly; setStatus nudges Pi to redraw.
  setStatus(ctx, generation);
}

/**
 * Whether Herdr currently shows this terminal as the focused agent.
 *
 * `herdr-app status` reports the focused pane's terminal address (`agent`), so
 * comparing it with the terminal this process runs in is a direct focus check.
 * Reading focus from Herdr rather than from terminal focus reporting matters
 * here: Herdr keeps several agent panes alive at once, and every one of them
 * watching the same recordings folder is exactly the bug this gate prevents.
 *
 * Returns undefined when Herdr is not the host, so callers can fall back.
 */
async function herdrFocusVerdict(): Promise<boolean | undefined> {
  const terminalId = process.env.HC_TERMINAL_ID?.trim();
  if (!terminalId) return undefined;

  try {
    const result = await execFileAsync(HERDR_APP_BIN, ["status"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    if (!stdout.trim()) return undefined;

    const status = JSON.parse(stdout) as { agent?: unknown; focused_pane?: unknown };
    const focusedTerminal = typeof status.agent === "string" ? status.agent : undefined;
    if (!focusedTerminal) return undefined;
    return focusedTerminal === terminalId;
  } catch {
    // Herdr not installed, not running, or the call timed out.
    return undefined;
  }
}

/**
 * Decides whether this session may receive a transcription right now.
 *
 * Every Pi session watches the same recordings folder, so without a gate a
 * single dictation lands in every open session. Under Herdr the focused pane
 * decides; elsewhere the clipboard path's terminal-focus and active-tab claim
 * are used.
 */
async function canReceiveRecording(): Promise<boolean> {
  const herdr = await herdrFocusVerdict();
  if (herdr !== undefined) return herdr;

  if (!state.terminalFocused) return false;
  return isActiveTab();
}

/**
 * Delivers one transcription read from Superwhisper's recordings.
 *
 * Unlike the clipboard path there is no owner gate to apply: the text came from
 * a recording this machine just made, so it is always ours to paste. Focus and
 * active-tab gating still apply, because several Pi sessions share one
 * recordings folder.
 */
async function deliverRecordingText(
  ctx: PiRuntimeContext,
  generation: number,
  text: string,
): Promise<void> {
  if (!isCurrentSession(ctx, generation)) return;
  if (state.mode === "off") return;

  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  if (trimmed.length > maxChars()) return;
  // No same-text guard here: the recording source already delivers each
  // recording id once, and dictating the same words twice is a real repeat.

  if (!(await canReceiveRecording())) {
    state.lastPasteSummary = "skipped (not focused)";
    setStatus(ctx, generation);
    return;
  }
  if (!isCurrentSession(ctx, generation)) return;

  if (!pasteToEditor(ctx, generation, trimmed)) return;
  markPasted(ctx, generation, trimmed);
  state.lastPasteSummary = `${trimmed.length} chars via recording`;
  setStatus(ctx, generation);
}

/** Starts the recordings watcher for the current session. */
function ensureRecordingSource(ctx: PiRuntimeContext, generation: number): void {
  if (!isCurrentSession(ctx, generation)) return;
  if (state.recordingSource?.isRunning() && state.recordingGeneration === generation) return;

  state.recordingSource?.stop();

  const source = createRecordingSource({
    dir: recordingsDir(),
    maxChars,
    onText: (text) => {
      // The source is synchronous, but focus gating reads the shared claim file.
      // Serialize deliveries so two recordings cannot interleave pastes.
      state.recordingDelivery = (state.recordingDelivery ?? Promise.resolve())
        .then(() => deliverRecordingText(ctx, generation, text))
        .catch(() => {
          // A stale session or a closed editor must not break the watcher.
        });
    },
    log: (level, message) => {
      // Never write to stdout/stderr: Pi owns the terminal and raw text there
      // lands on top of the TUI and shreds the layout.
      if (process.env.PI_SUPERWHISPER_PASTE_DEBUG) {
        try {
          process.emitWarning(`[superwhisper-paste] ${level}: ${message}`);
        } catch {
          // Diagnostics are best-effort.
        }
      }
    },
  });

  source.start();
  if (!source.isRunning()) return;

  state.recordingSource = source;
  state.recordingGeneration = generation;
}

/** Stops the recordings watcher. */
function stopRecordingSource(): void {
  state.recordingSource?.stop();
  state.recordingSource = undefined;
  state.recordingGeneration = undefined;
}

/** Returns a cached PowerShell clipboard script for the current char limit. */
function clipboardPowerShellCommand(limit: number): string {
  if (cachedClipboardScript?.limit === limit) return cachedClipboardScript.script;

  const script = buildClipboardPowerShellScript(limit);
  cachedClipboardScript = { limit, script };
  return script;
}

/** Builds a PowerShell command that reads clipboard text truncated to `limit` characters. */
function buildClipboardPowerShellScript(limit: number): string {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$signature = @\"",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class ClipboardOwnerNative {",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetClipboardOwner();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
    "}",
    "\"@",
    "Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue",
    `$limit = ${limit}`,
    "$text = Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue",
    "$ownerProcessName = $null",
    "$ownerProcessPath = $null",
    "try {",
    "  $ownerWindow = [ClipboardOwnerNative]::GetClipboardOwner()",
    "  if ($ownerWindow -ne [IntPtr]::Zero) {",
    "    $ownerPid = 0",
    "    [void][ClipboardOwnerNative]::GetWindowThreadProcessId($ownerWindow, [ref]$ownerPid)",
    "    if ($ownerPid -gt 0) {",
    "      $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue",
    "      if ($null -ne $ownerProcess) {",
    "        $ownerProcessName = $ownerProcess.ProcessName",
    "        $ownerProcessPath = $ownerProcess.Path",
    "      }",
    "    }",
    "  }",
    "} catch {}",
    "if ($null -ne $text) {",
    "  if ($text.Length -gt $limit) { $text = $text.Substring(0, $limit) }",
    "}",
    "$result = @{ text = $text; ownerProcessName = $ownerProcessName; ownerProcessPath = $ownerProcessPath }",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("\n");
}

/** Reads clipboard text and owner metadata via PowerShell. */
async function readClipboardSnapshot(): Promise<ClipboardSnapshot | undefined> {
  const limit = maxChars();

  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", clipboardPowerShellCommand(limit)],
      {
        encoding: "utf8",
        maxBuffer: limit * 4 + 1024,
        timeout: 2500,
        windowsHide: true,
      },
    );

    const stdout = typeof result.stdout === "string" ? result.stdout : undefined;
    if (!stdout) return undefined;

    const snapshot = JSON.parse(stdout) as ClipboardSnapshot;
    const text = typeof snapshot.text === "string" ? snapshot.text : undefined;
    return {
      text: text && text.length > limit ? text.slice(0, limit) : text,
      ownerProcessName:
        typeof snapshot.ownerProcessName === "string" ? snapshot.ownerProcessName : undefined,
      ownerProcessPath:
        typeof snapshot.ownerProcessPath === "string" ? snapshot.ownerProcessPath : undefined,
    };
  } catch {
    // Oversized clipboard, PowerShell failure, or maxBuffer must not break extension load.
    return undefined;
  }
}

/** Clears cached active-tab ownership between focus or session changes. */
function invalidateActiveTabCache(): void {
  state.activeTabCache = undefined;
}

/** Writes this Pi instance as the active tab for paste gating. */
async function claimActiveTab(): Promise<void> {
  const claim = {
    instanceId: INSTANCE_ID,
    pid: process.pid,
    updatedAt: Date.now(),
  };

  try {
    await writeFile(ACTIVE_STATE_PATH, JSON.stringify(claim), "utf8");
    // Cache only negative ownership: a cached positive claim could let another
    // instance's overwrite go unnoticed and paste into an inactive tab.
  } catch {
    invalidateActiveTabCache();
    // Focus tracking is best-effort; clipboard safety still falls back to local focus state.
  }
}

/** True when this instance owns the active-tab claim and has focus. */
async function isActiveTab(): Promise<boolean> {
  if (!state.terminalFocused) return false;

  const now = Date.now();
  const cache = state.activeTabCache;
  if (cache?.ok === false && now - cache.checkedAt < intervalMs()) return false;

  try {
    const raw = await readFile(ACTIVE_STATE_PATH, "utf8");
    const claim = JSON.parse(raw) as { instanceId?: string };
    const ok = claim.instanceId === INSTANCE_ID;
    state.activeTabCache = ok ? undefined : { ok: false, checkedAt: now };
    return ok;
  } catch {
    await claimActiveTab();
    return true;
  }
}

/** Seeds `lastClipboard` without pasting (focus/tab activation). */
async function refreshClipboardBaseline(
  ctx: PiRuntimeContext,
  generation: number,
): Promise<void> {
  const text = (await readClipboardSnapshot())?.text;
  if (!isCurrentSession(ctx, generation)) return;
  if (text !== undefined) state.lastClipboard = text;
}

/** Best-effort delayed baseline refresh after local copy shortcuts. */
function scheduleClipboardBaselineRefresh(ctx: PiRuntimeContext, generation: number): void {
  if (!isCurrentSession(ctx, generation)) return;

  if (state.baselineRefreshTimeout) {
    clearTimeout(state.baselineRefreshTimeout);
    state.baselineRefreshTimeout = undefined;
  }

  state.baselineRefreshTimeout = setTimeout(() => {
    state.baselineRefreshTimeout = undefined;
    if (isCurrentSession(ctx, generation)) void refreshClipboardBaseline(ctx, generation);
  }, BASELINE_REFRESH_DELAY_MS);
}

/** Marks tab focused, refreshes clipboard baseline, claims active tab. */
async function activateTab(ctx: PiRuntimeContext, generation: number): Promise<void> {
  if (!isCurrentSession(ctx, generation) || state.activatingGeneration !== undefined) return;

  state.activatingGeneration = generation;
  try {
    if (!isCurrentSession(ctx, generation)) return;
    state.terminalFocused = true;
    await refreshClipboardBaseline(ctx, generation);
    if (!isCurrentSession(ctx, generation)) return;
    await claimActiveTab();
    if (!isCurrentSession(ctx, generation)) return;
    setStatus(ctx, generation);
  } finally {
    if (state.activatingGeneration === generation) state.activatingGeneration = undefined;
  }
}

/** Claims active tab when user types in the terminal. */
async function markActiveFromInput(ctx: PiRuntimeContext, generation: number): Promise<void> {
  if (!isCurrentSession(ctx, generation)) return;
  state.terminalFocused = true;
  await claimActiveTab();
  if (!isCurrentSession(ctx, generation)) return;
  setStatus(ctx, generation);
}

/** True while recent local copy shortcuts should suppress bridge pastes. */
function shouldSuppressPasteForRecentCopy(): boolean {
  return (state.suppressPasteUntil ?? 0) > Date.now();
}

/** Detects common terminal copy shortcuts forwarded to Pi. */
function isLocalCopyShortcut(data: string): boolean {
  return LOCAL_COPY_SHORTCUTS.has(data);
}

/** Suppresses auto-paste briefly after local terminal copy intent. */
function suppressPasteAfterLocalCopy(ctx: PiRuntimeContext, generation: number): void {
  if (!isCurrentSession(ctx, generation)) return;
  state.suppressPasteUntil = Date.now() + ignoreCopyMs();
  state.lastPasteSummary = "blocked recent copy";
  void markActiveFromInput(ctx, generation);
  scheduleClipboardBaselineRefresh(ctx, generation);
}

/** True when clipboard owner metadata does not look like a terminal copy source. */
function shouldAcceptClipboardSource(snapshot: ClipboardSnapshot): boolean {
  const owner = `${snapshot.ownerProcessName ?? ""}\n${snapshot.ownerProcessPath ?? ""}`.toLowerCase();
  if (!owner.trim()) return true;
  return !ownerDenylist().some((token) => owner.includes(token));
}

/** Whether clipboard text should be auto-pasted into the editor. */
function shouldPaste(text: string, ctx: PiRuntimeContext, generation: number): boolean {
  if (!text.trim()) return false;
  if (text.length > maxChars()) return false;
  if (text === state.lastPasted) return false;

  const current = getEditorText(ctx, generation);
  if (current === undefined) return false;
  if (current.endsWith(text)) return false;

  return true;
}

/** Poll handler: paste new clipboard text when gates pass. */
async function pasteClipboardChange(ctx: PiRuntimeContext, generation: number): Promise<void> {
  if (!isCurrentSession(ctx, generation)) return;
  if (
    state.inFlightGeneration !== undefined ||
    state.activatingGeneration === generation ||
    state.mode === "off"
  ) {
    return;
  }
  if (!ctx.hasUI) return;
  if (!(await isActiveTab())) return;
  if (!isCurrentSession(ctx, generation)) return;

  state.inFlightGeneration = generation;
  try {
    const snapshot = await readClipboardSnapshot();
    const text = snapshot?.text;
    if (!isCurrentSession(ctx, generation)) return;
    if (text === undefined || text === state.lastClipboard) return;

    state.lastClipboard = text;
    if (!snapshot) {
      state.lastPasteSummary = "clipboard read failed";
      setStatus(ctx, generation);
      return;
    }
    if (!shouldAcceptClipboardSource(snapshot)) {
      state.lastPasteSummary = `blocked ${clipboardOwnerSummary(snapshot)}`;
      setStatus(ctx, generation);
      return;
    }
    if (shouldSuppressPasteForRecentCopy()) {
      state.lastPasteSummary = `blocked recent copy (${clipboardOwnerSummary(snapshot)})`;
      setStatus(ctx, generation);
      return;
    }
    if (!shouldPaste(text, ctx, generation)) return;
    if (!(await isActiveTab())) return;
    if (!isCurrentSession(ctx, generation)) return;

    if (!pasteToEditor(ctx, generation, text)) return;
    markPasted(ctx, generation, text);
    state.lastPasteSummary = `${text.length} chars via ${clipboardOwnerSummary(snapshot)}`;
    setStatus(ctx, generation);
  } catch {
    // Clipboard polling should stay quiet while the user is typing.
  } finally {
    if (state.inFlightGeneration === generation) state.inFlightGeneration = undefined;
  }
}

/** Enables terminal focus reporting and input hooks for this session. */
function setupTerminalFocusTracking(ctx: PiRuntimeContext, generation: number): void {
  if (!isCurrentSession(ctx, generation)) return;
  if (state.unsubscribeTerminalInput) return;

  try {
    process.stdout.write(ENABLE_FOCUS_REPORTING);
  } catch {
    // Best-effort terminal focus setup only.
  }
  void activateTab(ctx, generation);

  safeWithCurrentUi(ctx, generation, (ui) => {
    state.unsubscribeTerminalInput = ui.onTerminalInput((data) => {
      if (!isCurrentSession(ctx, generation)) return undefined;

      if (data === FOCUS_IN) {
        void activateTab(ctx, generation);
        return { consume: true };
      }

      if (data === FOCUS_OUT) {
        state.terminalFocused = false;
        invalidateActiveTabCache();
        setStatus(ctx, generation);
        return { consume: true };
      }

      if (isLocalCopyShortcut(data)) {
        suppressPasteAfterLocalCopy(ctx, generation);
        return undefined;
      }

      if (data.length > 0) {
        void markActiveFromInput(ctx, generation);
      }

      return undefined;
    });
  });
}

/** Disables focus reporting and removes terminal input subscription. */
function teardownTerminalFocusTracking(): void {
  try {
    state.unsubscribeTerminalInput?.();
  } catch {
    // The old subscription may already belong to an invalidated session.
  }
  state.unsubscribeTerminalInput = undefined;

  try {
    process.stdout.write(DISABLE_FOCUS_REPORTING);
  } catch {
    // Best-effort terminal focus cleanup only.
  }
}

/** Clears poll interval and terminal hooks for the current session. */
function teardownSessionResources(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  if (state.baselineRefreshTimeout) {
    clearTimeout(state.baselineRefreshTimeout);
    state.baselineRefreshTimeout = undefined;
  }
  stopRecordingSource();
  teardownTerminalFocusTracking();
  invalidateActiveTabCache();
  state.inFlightGeneration = undefined;
  state.activatingGeneration = undefined;
  state.suppressPasteUntil = undefined;
}

/** Starts a new session generation and tears down the previous one. */
function beginSession(ctx: PiRuntimeContext): number {
  teardownSessionResources();
  const generation = state.generation + 1;
  state.generation = generation;
  state.session = { generation, ctx };
  return generation;
}

/** Returns current session generation, beginning one if needed. */
function ensureCurrentSession(ctx: PiRuntimeContext): number {
  if (state.session?.ctx === ctx) return state.session.generation;
  return beginSession(ctx);
}

/** Invalidates the current session and releases resources. */
function endSession(): void {
  teardownSessionResources();
  state.generation += 1;
  state.session = undefined;
}

/** Starts clipboard polling and focus tracking when mode is on. */
function ensurePolling(ctx: PiRuntimeContext, generation: number): void {
  if (!isCurrentSession(ctx, generation)) return;

  setupTerminalFocusTracking(ctx, generation);

  if (activeSource() === "recording") {
    // No clipboard polling and no clipboard baseline: this path reads
    // Superwhisper's own files, so a clipboard read would be pure overhead and
    // would also re-introduce the owner gates that do not apply here.
    state.lastPasteSummary = undefined;
    ensureRecordingSource(ctx, generation);
    setStatus(ctx, generation);
    return;
  }

  stopRecordingSource();
  setStatus(ctx, generation);

  if (state.interval) return;
  state.interval = setInterval(() => {
    if (isCurrentSession(ctx, generation)) void pasteClipboardChange(ctx, generation);
  }, intervalMs());
}

/** Stops polling and clears bridge status. */
function stopPolling(ctx: PiRuntimeContext, generation: number): void {
  teardownSessionResources();
  state.mode = "off";
  setStatus(ctx, generation);
}

/** Baselines clipboard then starts polling (session_start path). */
async function startPolling(ctx: PiRuntimeContext, generation: number): Promise<void> {
  const text = (await readClipboardSnapshot())?.text;
  if (!isCurrentSession(ctx, generation)) return;
  state.lastClipboard = text;
  ensurePolling(ctx, generation);
}

/** Enables bridge mode and notifies the user. */
async function arm(ctx: PiRuntimeContext, generation: number): Promise<void> {
  const text = (await readClipboardSnapshot())?.text;
  if (!isCurrentSession(ctx, generation)) return;
  state.lastClipboard = text;
  state.mode = "on";
  ensurePolling(ctx, generation);
  notify(ctx, generation, "Superwhisper paste bridge: enabled", "info");
}

/** Parses `/sw-paste:on` or `/sw-paste:off` from user input. */
function parseControlCommand(text: string): BridgeMode | undefined {
  const match = text.trim().match(/^\/sw-paste:(on|off)$/i);
  if (!match) return undefined;
  return match[1].toLowerCase() as BridgeMode;
}

/** Applies on/off control command for the current session. */
async function runControlAction(
  action: BridgeMode,
  ctx: PiRuntimeContext,
  generation: number,
): Promise<void> {
  if (action === "on") {
    await arm(ctx, generation);
    return;
  }

  stopPolling(ctx, generation);
  notify(ctx, generation, "Superwhisper paste bridge: disabled", "info");
}

/** Pi extension entry: Superwhisper clipboard bridge for Windows. */
export default function superwhisperPaste(pi: ExtensionAPI) {
  pi.registerCommand("sw-paste:on", {
    description: "Enable the Superwhisper clipboard paste bridge",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const generation = ensureCurrentSession(runtimeCtx);
      await runControlAction("on", runtimeCtx, generation);
    },
  });

  pi.registerCommand("sw-paste:off", {
    description: "Disable the Superwhisper clipboard paste bridge",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const generation = ensureCurrentSession(runtimeCtx);
      await runControlAction("off", runtimeCtx, generation);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const runtimeCtx = ctx as PiRuntimeContext;
    const generation = beginSession(runtimeCtx);
    if (state.mode !== "off") await startPolling(runtimeCtx, generation);
  });

  pi.on("session_shutdown", () => {
    endSession();
  });

  pi.on("input", async (event, ctx) => {
    const action = parseControlCommand(event.text);
    if (!action) return { action: "continue" };

    const runtimeCtx = ctx as PiRuntimeContext;
    const generation = ensureCurrentSession(runtimeCtx);
    await runControlAction(action, runtimeCtx, generation);
    return { action: "handled" };
  });
}
