import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXTENSION_VERSION = "0.1.17";

const STATUS_KEY = "superwhisper-paste";
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

type BridgeMode = "off" | "on";

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
};

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

/** Poll interval from env or default. */
function intervalMs(): number {
  const parsed = Number(process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/** Max pasted characters from env or default. */
function maxChars(): number {
  const parsed = Number(process.env.PI_SUPERWHISPER_PASTE_MAX_CHARS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHARS;
}

/** Ignore clipboard changes briefly after local copy shortcuts. */
function ignoreCopyMs(): number {
  const parsed = Number(process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IGNORE_COPY_MS;
}

/** Process-name/path substrings denied from triggering auto-paste. */
function ownerDenylist(): string[] {
  const raw = process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST;
  if (!raw) return DEFAULT_OWNER_DENYLIST;

  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  return tokens.length > 0 ? tokens : DEFAULT_OWNER_DENYLIST;
}

/** Status bar label for the paste bridge. */
function statusText(): string | undefined {
  if (state.mode === "off") return undefined;
  const focusText = state.terminalFocused ? "active" : "standby";
  return state.lastPasteSummary
    ? `SW paste v${EXTENSION_VERSION}: ${focusText} (${state.lastPasteSummary})`
    : `SW paste v${EXTENSION_VERSION}: ${focusText}`;
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
function safeWithCurrentUi(
  ctx: PiRuntimeContext,
  generation: number,
  action: (ui: PiEditorUi) => void,
): boolean {
  if (!isCurrentSession(ctx, generation)) return false;

  try {
    const ui = ctx.ui;
    if (!isCurrentSession(ctx, generation)) return false;
    action(ui);
    return true;
  } catch {
    // A Pi ctx can become stale between any callback/await boundary. Treat UI
    // failures as a closed session so the extension never bubbles the runner's
    // stale-ctx guard up as an uncaughtException.
    return false;
  }
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
  if (!isCurrentSession(ctx, generation)) return undefined;

  try {
    const ui = ctx.ui;
    if (!isCurrentSession(ctx, generation)) return undefined;
    return String(ui.getEditorText?.() ?? "");
  } catch {
    return undefined;
  }
}

/** Records last paste and refreshes status after insert. */
function markPasted(ctx: PiRuntimeContext, generation: number, text: string): void {
  if (!isCurrentSession(ctx, generation)) return;
  state.lastPasted = text;
  state.lastPasteSummary = `${text.length} chars`;
  // pasteToEditor mutates the editor directly; setStatus nudges Pi to redraw.
  setStatus(ctx, generation);
}

/** Builds a PowerShell command that reads clipboard text truncated to `limit` characters. */
function clipboardPowerShellScript(limit: number): string {
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
      ["-NoProfile", "-Command", clipboardPowerShellScript(limit)],
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

/** Temp file path for cross-tab active-instance claim. */
function activeStatePath(): string {
  return join(tmpdir(), ACTIVE_STATE_FILE);
}

/** Writes this Pi instance as the active tab for paste gating. */
async function claimActiveTab(): Promise<void> {
  const claim = {
    instanceId: INSTANCE_ID,
    pid: process.pid,
    updatedAt: Date.now(),
  };

  try {
    await writeFile(activeStatePath(), JSON.stringify(claim), "utf8");
  } catch {
    // Focus tracking is best-effort; clipboard safety still falls back to local focus state.
  }
}

/** True when this instance owns the active-tab claim and has focus. */
async function isActiveTab(): Promise<boolean> {
  if (!state.terminalFocused) return false;

  try {
    const raw = await readFile(activeStatePath(), "utf8");
    const claim = JSON.parse(raw) as { instanceId?: string };
    return claim.instanceId === INSTANCE_ID;
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
  return [
    CTRL_C,
    CTRL_INSERT,
    CTRL_SHIFT_INSERT,
    CTRL_SHIFT_C_CSI_U,
    CTRL_SHIFT_UPPER_C_CSI_U,
  ].includes(data);
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
  teardownTerminalFocusTracking();
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
